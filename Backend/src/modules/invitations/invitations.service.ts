import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter';
import { buildOffsetPage, OffsetPage } from '../../common/pagination/pagination';
import { DEFAULT_PAGE_SIZE } from '../../common/pagination/pagination-query.dto';
import { containsPattern } from '../../common/utils/like-pattern';
import { EmailService } from '../../email/email.service';
import { DeliveryOutcome, EmailDeliveryEvents } from '../../email/email-delivery-events';
import { buildInvitationEmail } from './invitation-email';
import { InvitationListStatus, ListInvitationsQueryDto } from './dto/list-invitations-query.dto';

// 7 days is the common default (GitHub, Slack, Notion all sit between 3 and 30). Long enough for
// someone on holiday; short enough that a link lingering in a forwarded email goes dead.
const INVITATION_TTL = '7 days';

// Invitations send email on our behalf, which makes them a spam vector: register a free
// workspace, then invite ten thousand strangers from our domain. That burns the sending
// domain's reputation, and then real invitations land in spam for every customer. So both
// sending paths are limited per workspace, and resending one invitation has its own tighter cap.
const WORKSPACE_SEND_LIMIT = { limit: 50, windowSeconds: 60 * 60 };
const RESEND_LIMIT = { limit: 3, windowSeconds: 60 * 60 };

// The role ceiling: nobody can hand out more access than they hold. Only owners hold
// members.invite today, so it never binds yet — but the day agents are granted members.invite
// (a one-row change to role_permissions), this is what stops an agent inviting an owner and
// thereby promoting themselves by proxy. Permissions answer "may you invite?"; the ceiling
// answers "whom, at what level?" — a check on the DATA, which a route-level permission can't see.
const ROLE_RANK: Record<MembershipRole, number> = {
  [MembershipRole.VIEWER]: 1,
  [MembershipRole.AGENT]: 2,
  [MembershipRole.OWNER]: 3,
};

export interface Inviter {
  userId: number;
  role: MembershipRole;
}

export interface InvitationSummary {
  id: number;
  email: string;
  role: MembershipRole;
  status: InvitationListStatus;
  invitedByEmail: string | null;
  expiresAt: string;
  lastSentAt: string;
  sendCount: number;
  createdAt: string;
  acceptedAt: string | null;
  acceptedByEmail: string | null;
  revokedAt: string | null;
  emailStatus: 'queued' | 'sent' | 'failed';
  emailSentAt: string | null;
  emailLastError: string | null;
}

// Selected by every read so the list and single-row responses have one shape. The derived
// status is the only place 'expired' exists.
const SUMMARY_COLUMNS = `
  i.id, i.email, i.role,
  CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status::text END AS status,
  inviter.email AS "invitedByEmail",
  i.expires_at AS "expiresAt", i.last_sent_at AS "lastSentAt", i.send_count AS "sendCount",
  i.created_at AS "createdAt", i.accepted_at AS "acceptedAt", accepter.email AS "acceptedByEmail",
  i.revoked_at AS "revokedAt", i.email_status AS "emailStatus", i.email_sent_at AS "emailSentAt",
  i.email_last_error AS "emailLastError"`;

// Every read joins both people the same way, so SUMMARY_COLUMNS can refer to them.
const SUMMARY_FROM = `
  FROM invitations i
  LEFT JOIN users inviter ON inviter.id = i.invited_by_user_id
  LEFT JOIN users accepter ON accepter.id = i.accepted_by_user_id`;

@Injectable()
export class InvitationsService implements OnModuleInit {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly workspaceLimiter: FixedWindowRateLimiter;
  private readonly resendLimiter: FixedWindowRateLimiter;
  private readonly frontendUrl: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) redis: Redis,
    private readonly email: EmailService,
    private readonly deliveryEvents: EmailDeliveryEvents,
    config: ConfigService,
  ) {
    this.workspaceLimiter = new FixedWindowRateLimiter(redis, this.logger, WORKSPACE_SEND_LIMIT);
    this.resendLimiter = new FixedWindowRateLimiter(redis, this.logger, RESEND_LIMIT);

    // `|| undefined`, not `??`: a key present in .env with no value (`FRONTEND_URL=`) arrives as
    // an EMPTY STRING, which `??` treats as a real value — links would silently become
    // "/invite#token=…" with no host at all. Empty means unset.
    const frontendUrl = config.get<string>('FRONTEND_URL') || undefined;
    if (!frontendUrl && config.get<string>('NODE_ENV') === 'production') {
      // A missing value would silently produce links to localhost in real customers' inboxes.
      throw new Error('FRONTEND_URL must be set in production — invitation links are built from it.');
    }
    this.frontendUrl = (frontendUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  onModuleInit(): void {
    this.deliveryEvents.register('invitation', (ref, outcome) =>
      this.recordDelivery(Number(ref.id), String(ref.tokenHash), outcome),
    );
  }

  async get(workspaceId: number, invitationId: number): Promise<InvitationSummary> {
    return this.getSummary(workspaceId, invitationId);
  }

  // Matched on token_hash as well as id. A resend rotates the token and queues a new email;
  // if the OLD email's job finishes (or fails) after that, its report must not overwrite the
  // status of the new one — the hash identifies which send a report is about.
  private async recordDelivery(invitationId: number, tokenHash: string, outcome: DeliveryOutcome): Promise<void> {
    if (outcome.status === 'sent') {
      await this.dataSource.query(
        `UPDATE invitations SET email_status = 'sent', email_sent_at = now(), email_last_error = NULL
         WHERE id = $1 AND token_hash = $2`,
        [invitationId, tokenHash],
      );
    } else if (outcome.status === 'failed') {
      await this.dataSource.query(
        `UPDATE invitations SET email_status = 'failed', email_last_error = $3 WHERE id = $1 AND token_hash = $2`,
        [invitationId, tokenHash, outcome.error],
      );
    } else {
      // Still queued — the queue will try again. Recording the error lets the UI say
      // "retrying (attempt 2 of 5)" instead of looking stuck.
      await this.dataSource.query(
        `UPDATE invitations SET email_last_error = $3 WHERE id = $1 AND token_hash = $2`,
        [invitationId, tokenHash, `Attempt ${outcome.attempt} of ${outcome.maxAttempts} failed: ${outcome.error}`],
      );
    }
  }

  async create(workspaceId: number, inviter: Inviter, email: string, role: MembershipRole): Promise<InvitationSummary> {
    this.assertWithinCeiling(inviter, role);
    await this.consumeSendQuota(workspaceId);

    const [existingMember] = await this.dataSource.query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2`,
      [workspaceId, email],
    );
    if (existingMember) {
      throw new ConflictException('This person is already a member of the workspace.');
    }

    const token = generateToken();
    let id: number;
    try {
      const [row] = await this.dataSource.query(
        `INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + $6::interval)
         RETURNING id`,
        [workspaceId, email, role, hashToken(token), inviter.userId, INVITATION_TTL],
      );
      id = row.id;
    } catch (error) {
      // The partial unique index, not an earlier SELECT, is what actually guarantees one pending
      // invitation per address: two concurrent invites both pass any pre-check, and only one
      // INSERT can win. Same two-layer lesson as Phase 3's duplicate-upload constraint.
      if (isUniqueViolation(error, 'UQ_invitations_pending_email')) {
        throw new ConflictException('An invitation is already pending for this email. Resend or revoke it instead.');
      }
      throw error;
    }

    await this.sendInvitationEmail(id, token);
    return this.getSummary(workspaceId, id);
  }

  async list(workspaceId: number, query: ListInvitationsQueryDto): Promise<OffsetPage<InvitationSummary>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const status = query.status ?? null;
    const search = query.search?.trim() ? containsPattern(query.search.trim()) : null;

    // Filtering on the DERIVED status, so the CASE has to be computed before the WHERE sees
    // it — hence the subquery. The inner WHERE on workspace_id still uses the index.
    const rows = await this.dataSource.query(
      `SELECT *, count(*) OVER()::int AS "total" FROM (
         SELECT ${SUMMARY_COLUMNS}
         ${SUMMARY_FROM}
         WHERE i.workspace_id = $1
       ) s
       WHERE ($2::text IS NULL OR s.status = $2)
         AND ($5::text IS NULL OR s.email ILIKE $5 ESCAPE '\\')
       ORDER BY s."createdAt" DESC, s.id DESC
       LIMIT $3 OFFSET $4`,
      [workspaceId, status, pageSize, (page - 1) * pageSize, search],
    );

    // count(*) OVER() answers "how many in total" in the same query as the page itself. When
    // the page is empty there is no row to carry it, so an out-of-range page reports 0.
    const total = rows[0]?.total ?? 0;
    return buildOffsetPage(
      rows.map(({ total: _total, ...row }: Record<string, unknown>) => toSummary(row)),
      total,
      page,
      pageSize,
    );
  }

  // Rotates the token rather than resending the old one. We never stored the old token (only
  // its hash), so it CAN'T be resent — and that is the point: a resend is usually "I lost it" or
  // "it went to the wrong place", and in both cases the previous link should stop working.
  async resend(workspaceId: number, inviter: Inviter, invitationId: number): Promise<InvitationSummary> {
    await this.assertCanActOn(workspaceId, inviter, invitationId);

    const { limited } = await this.resendLimiter.hit(`invite-resend:${invitationId}`);
    if (limited) {
      throw new HttpException('This invitation was resent too many times recently. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.consumeSendQuota(workspaceId);

    const token = generateToken();
    // (TypeORM returns [rows, affectedCount] for UPDATE, unlike INSERT — hence the destructure.)
    // Conditional on status = 'pending': the row may have been accepted or revoked between the
    // check above and this statement, and a resend must not resurrect it.
    const [rows] = await this.dataSource.query(
      `UPDATE invitations
       SET token_hash = $3, expires_at = now() + $4::interval, last_sent_at = now(), send_count = send_count + 1,
           email_status = 'queued', email_sent_at = NULL, email_last_error = NULL
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
       RETURNING id`,
      [invitationId, workspaceId, hashToken(token), INVITATION_TTL],
    );
    if (rows.length === 0) {
      throw new ConflictException('Only a pending invitation can be resent.');
    }

    await this.sendInvitationEmail(invitationId, token);
    return this.getSummary(workspaceId, invitationId);
  }

  async revoke(workspaceId: number, inviter: Inviter, invitationId: number): Promise<InvitationSummary> {
    await this.assertCanActOn(workspaceId, inviter, invitationId);

    const [rows] = await this.dataSource.query(
      `UPDATE invitations SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
       RETURNING id`,
      [invitationId, workspaceId],
    );
    if (rows.length === 0) {
      throw new ConflictException('Only a pending invitation can be revoked.');
    }
    return this.getSummary(workspaceId, invitationId);
  }

  private async sendInvitationEmail(invitationId: number, token: string): Promise<void> {
    const [row] = await this.dataSource.query(
      `SELECT i.email, i.role, i.expires_at AS "expiresAt", w.name AS "workspaceName", inviter.email AS "inviterEmail"
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN users inviter ON inviter.id = i.invited_by_user_id
       WHERE i.id = $1`,
      [invitationId],
    );

    // The token goes in the URL FRAGMENT (#...), not the path or query string. Browsers never
    // send the fragment to any server: not in the request to our Frontend, not in the Referer
    // header to third-party scripts, not into any access log along the way. The /invite page
    // reads it with JavaScript and sends it in a POST body instead.
    const link = `${this.frontendUrl}/invite#token=${token}`;

    // Enqueued AFTER the row is committed (each statement above auto-commits). The reverse
    // order could email a link to an invitation that then failed to save. What this still
    // does not cover: Redis being down right here leaves a saved invitation whose email never
    // went out — recoverable (the inviter sees it pending and resends), not silent. The full
    // fix is a transactional outbox (see the doc), which this project does not need yet.
    await this.email.enqueue(
      buildInvitationEmail({
        to: row.email,
        workspaceName: row.workspaceName,
        inviterEmail: row.inviterEmail,
        role: row.role,
        link,
        expiresAt: new Date(row.expiresAt),
      }),
      { type: 'invitation', ref: { id: invitationId, tokenHash: hashToken(token) } },
    );
  }

  private async getSummary(workspaceId: number, invitationId: number): Promise<InvitationSummary> {
    const [row] = await this.dataSource.query(
      `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM} WHERE i.workspace_id = $1 AND i.id = $2`,
      [workspaceId, invitationId],
    );
    if (!row) throw new NotFoundException('Invitation not found.');
    return toSummary(row);
  }

  // Scoped by workspace_id as well as id: an owner of workspace 1 guessing invitation id 57
  // from workspace 2 gets a 404, exactly as if it did not exist — not a 403 that confirms it does.
  private async assertCanActOn(workspaceId: number, inviter: Inviter, invitationId: number): Promise<void> {
    const [row] = await this.dataSource.query(`SELECT role FROM invitations WHERE id = $1 AND workspace_id = $2`, [
      invitationId,
      workspaceId,
    ]);
    if (!row) throw new NotFoundException('Invitation not found.');
    this.assertWithinCeiling(inviter, row.role);
  }

  private assertWithinCeiling(inviter: Inviter, role: MembershipRole): void {
    if (ROLE_RANK[role] > ROLE_RANK[inviter.role]) {
      throw new ForbiddenException(`You cannot manage invitations for a role above your own (${inviter.role}).`);
    }
  }

  private async consumeSendQuota(workspaceId: number): Promise<void> {
    const { limited } = await this.workspaceLimiter.hit(`invite-sends:${workspaceId}`);
    if (limited) {
      throw new HttpException('Too many invitations sent from this workspace in the last hour.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

// 32 random bytes = 256 bits from the OS CSPRNG. Guessing one is not a rate-limiting problem,
// it is a physics problem — which is also why SHA-256 (fast) is the right hash for it and bcrypt
// (deliberately slow) would be wasted effort. Slow hashing exists to protect LOW-entropy secrets
// like passwords from offline guessing; a 256-bit random token has nothing to guess.
// (The same reasoning as Phase 2's refresh tokens.)
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driverError = (error as { driverError?: { code?: string; constraint?: string } }).driverError;
  return driverError?.code === '23505' && driverError.constraint === constraint;
}

function toSummary(row: Record<string, unknown>): InvitationSummary {
  const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
  return {
    id: row.id as number,
    email: row.email as string,
    role: row.role as MembershipRole,
    status: row.status as InvitationListStatus,
    invitedByEmail: (row.invitedByEmail as string | null) ?? null,
    expiresAt: iso(row.expiresAt)!,
    lastSentAt: iso(row.lastSentAt)!,
    sendCount: row.sendCount as number,
    createdAt: iso(row.createdAt)!,
    acceptedAt: iso(row.acceptedAt),
    acceptedByEmail: (row.acceptedByEmail as string | null) ?? null,
    revokedAt: iso(row.revokedAt),
    emailStatus: row.emailStatus as InvitationSummary['emailStatus'],
    emailSentAt: iso(row.emailSentAt),
    emailLastError: (row.emailLastError as string | null) ?? null,
  };
}
