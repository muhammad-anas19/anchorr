import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { AuthService, TokenPair } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { hashToken } from './invitations.service';

export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: MembershipRole;
  invitedByEmail: string | null;
  expiresAt: string;
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  // Lets the page choose "sign in to accept" vs "create your password". Revealing whether an
  // address has an account is normally an enumeration leak — but only to someone holding a
  // 256-bit token that already names that address, so there is nothing left to enumerate.
  accountExists: boolean;
}

export interface AcceptedMembership {
  workspaceId: number;
  role: MembershipRole;
  // True if they were already a member (possible only via a race — create refuses to invite
  // existing members). Their existing role is kept: an invitation never changes a role.
  alreadyMember: boolean;
}

interface ConsumedInvitation {
  id: number;
  workspaceId: number;
  role: MembershipRole;
}

// The invitee's side of the lifecycle, kept apart from InvitationsService (the inviter's side):
// different caller, different authorization model (a token rather than a membership), and
// nothing in common beyond the table.
@Injectable()
export class InvitationAcceptanceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
  ) {}

  async preview(token: string): Promise<InvitationPreview> {
    const [row] = await this.dataSource.query(
      `SELECT w.name AS "workspaceName", i.email, i.role, inviter.email AS "invitedByEmail", i.expires_at AS "expiresAt",
              CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status::text END AS status,
              EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS "accountExists"
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN users inviter ON inviter.id = i.invited_by_user_id
       WHERE i.token_hash = $1`,
      [hashToken(token)],
    );
    if (!row) throw invalidLink();
    return { ...row, expiresAt: new Date(row.expiresAt).toISOString() };
  }

  async acceptAsExistingUser(token: string, userId: number): Promise<AcceptedMembership> {
    const tokenHash = hashToken(token);

    return this.dataSource.transaction(async (manager) => {
      const [invitation] = await manager.query(`SELECT email FROM invitations WHERE token_hash = $1`, [tokenHash]);
      if (!invitation) throw invalidLink();

      // Email binding. Without it, whoever the link reaches joins the workspace — an invitee who
      // forwards it to a colleague, a shared mailbox, a link pasted into a ticket. The invitation
      // grants access to a PERSON, identified by the address it was sent to, not to "whoever
      // holds this URL". (Slack, GitHub and Google Workspace all enforce the same match.)
      const [user] = await manager.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (user.email !== invitation.email) {
        throw new ForbiddenException(
          `This invitation was sent to ${invitation.email}, but you are signed in as ${user.email}. ` +
            `Sign in with the invited address to accept it.`,
        );
      }

      const consumed = await this.consume(manager, tokenHash, userId);
      return this.joinWorkspace(manager, consumed, userId);
    });
  }

  async acceptWithSignup(token: string, password: string): Promise<TokenPair & AcceptedMembership> {
    const tokenHash = hashToken(token);

    // A read before the transaction, for two reasons. It gives a precise error without doing
    // any work (no bcrypt for a dead link). And bcrypt takes ~250 ms on purpose, which must not
    // happen inside the transaction: it would hold the row locks the INSERTs below take for the
    // whole time. This read is advisory only — the transaction re-checks everything that matters.
    const [invitation] = await this.dataSource.query(
      `SELECT email, status, expires_at <= now() AS expired,
              EXISTS (SELECT 1 FROM users u WHERE u.email = invitations.email) AS "accountExists"
       FROM invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    if (!invitation) throw invalidLink();
    if (invitation.status !== 'pending' || invitation.expired) {
      throw unusable(invitation.status, invitation.expired);
    }
    if (invitation.accountExists) {
      throw new ConflictException('An account with this email already exists. Sign in to accept the invitation.');
    }

    const passwordHash = await this.passwords.hash(password);

    const accepted = await this.dataSource.transaction(async (manager) => {
      let userId: number;
      try {
        const [user] = await manager.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [
          invitation.email,
          passwordHash,
        ]);
        userId = user.id;
      } catch (error) {
        // Two sign-ups racing on one link both pass the pre-check above; users.email's UNIQUE
        // makes the second INSERT wait for the first to commit, then fail here.
        if ((error as { driverError?: { code?: string } }).driverError?.code === '23505') {
          throw new ConflictException('An account with this email already exists. Sign in to accept the invitation.');
        }
        throw error;
      }

      // If this throws (revoked or expired a moment ago), the whole transaction rolls back —
      // including the user just inserted, so a dead invitation never leaves an account behind.
      const consumed = await this.consume(manager, tokenHash, userId);
      return { userId, ...(await this.joinWorkspace(manager, consumed, userId)) };
    });

    // Signing in happens after commit: tokens for a user whose transaction then rolled back
    // would be tokens for nobody.
    const tokens = await this.auth.issueTokenPair(accepted.userId);
    return {
      ...tokens,
      workspaceId: accepted.workspaceId,
      role: accepted.role,
      alreadyMember: accepted.alreadyMember,
    };
  }

  // The single-use guarantee. One conditional UPDATE both checks and consumes: of any number of
  // concurrent accepts with the same token, the first to take the row lock matches the WHERE,
  // the rest re-evaluate it after that commit, find status = 'accepted', and match nothing.
  // Same shape as Phase 12's claim — the condition lives on the very row being written, so a
  // plain UPDATE is atomic and no explicit lock is needed. It also closes the race with a
  // concurrent revoke or resend: whichever commits first wins, and the other finds no match.
  private async consume(manager: EntityManager, tokenHash: string, userId: number): Promise<ConsumedInvitation> {
    const [rows] = await manager.query(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $2
       WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
       RETURNING id, workspace_id AS "workspaceId", role`,
      [tokenHash, userId],
    );
    if (rows.length > 0) return rows[0];

    const [row] = await manager.query(
      `SELECT status, expires_at <= now() AS expired FROM invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    if (!row) throw invalidLink();
    throw unusable(row.status, row.expired);
  }

  private async joinWorkspace(
    manager: EntityManager,
    invitation: ConsumedInvitation,
    userId: number,
  ): Promise<AcceptedMembership> {
    const inserted = await manager.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING role`,
      [invitation.workspaceId, userId, invitation.role],
    );
    if (inserted.length > 0) {
      return { workspaceId: invitation.workspaceId, role: inserted[0].role, alreadyMember: false };
    }
    const [existing] = await manager.query(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [
      invitation.workspaceId,
      userId,
    ]);
    return { workspaceId: invitation.workspaceId, role: existing.role, alreadyMember: true };
  }
}

// One message for "no such token", whatever the reason — never "this token existed but was
// replaced". The most common real cause is clicking an older email after a resend.
function invalidLink(): NotFoundException {
  return new NotFoundException('This invitation link is not valid. If it was resent, use the most recent email.');
}

// 410 Gone for "it existed and is no longer usable", which is what 410 means; 409 for "already
// accepted", which is a conflict with the current state rather than an absence.
function unusable(status: string, expired: boolean): Error {
  if (status === 'accepted') return new ConflictException('This invitation has already been accepted.');
  if (status === 'revoked') return new GoneException('This invitation was revoked. Ask for a new one.');
  if (expired) return new GoneException('This invitation has expired. Ask for a new one.');
  return new ConflictException('This invitation can no longer be accepted.');
}
