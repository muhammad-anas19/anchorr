import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { Workspace } from '../../database/entities/workspace.entity';
import { Permission } from '../../common/permissions/permission.enum';
import { PermissionsService } from '../tenancy/permissions.service';
import { RealtimeBroadcaster } from '../../realtime/realtime-broadcaster.service';
import { agentUserRoom, agentsRoom } from '../../realtime/rooms';
import { buildOffsetPage, OffsetPage } from '../../common/pagination/pagination';
import { DEFAULT_PAGE_SIZE } from '../../common/pagination/pagination-query.dto';
import { containsPattern } from '../../common/utils/like-pattern';
import { ListMembersQueryDto } from './dto/list-members-query.dto';

export interface MemberSummary {
  userId: number;
  email: string;
  role: MembershipRole;
  joinedAt: string;
}

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  // Server-side search, filter and pagination: a workspace's member list is unbounded, and a
  // client-side filter over "all members" only works until the day it has thousands.
  async listMembers(workspaceId: number, query: ListMembersQueryDto): Promise<OffsetPage<MemberSummary>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.search?.trim();

    const rows = await this.dataSource.query(
      `SELECT m.user_id AS "userId", u.email, m.role, m.created_at AS "joinedAt", count(*) OVER()::int AS total
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1
         AND ($2::text IS NULL OR u.email ILIKE $2 ESCAPE '\\')
         AND ($3::text IS NULL OR m.role::text = $3)
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.email, m.user_id
       LIMIT $4 OFFSET $5`,
      [workspaceId, search ? containsPattern(search) : null, query.role ?? null, pageSize, (page - 1) * pageSize],
    );

    const total = rows[0]?.total ?? 0;
    return buildOffsetPage(
      rows.map((row: MemberSummary & { total?: number; joinedAt: Date }) => ({
        userId: row.userId,
        email: row.email,
        role: row.role,
        joinedAt: new Date(row.joinedAt).toISOString(),
      })),
      total,
      page,
      pageSize,
    );
  }

  // The role → permission matrix, as the database holds it. The invite dialog shows this when
  // choosing a role, so what it says a role can do is the policy that is actually enforced —
  // not a hand-written description that drifts from role_permissions.
  async listRoles() {
    const descriptions = await this.permissions.descriptions();
    return Object.values(MembershipRole).map((role) => ({
      role,
      permissions: this.permissions.forRole(role).map((key) => ({ key, description: descriptions.get(key) ?? key })),
    }));
  }

  async updateMemberRole(workspaceId: number, targetUserId: number, role: MembershipRole) {
    const released = await this.dataSource.transaction(async (manager) => {
      await lockWorkspace(manager, workspaceId);

      const membership = await manager.findOne(Membership, { where: { workspaceId, userId: targetUserId } });
      if (!membership) {
        throw new NotFoundException('This user is not a member of this workspace.');
      }

      if (membership.role === MembershipRole.OWNER && role !== MembershipRole.OWNER) {
        await assertAnotherOwnerRemains(manager, workspaceId);
      }

      membership.role = role;
      await manager.save(membership);

      // A demotion can take away handoff.work (agent → viewer). Their claimed conversations
      // then belong to nobody who can answer them, so they go back in the queue, same as a removal.
      return this.permissions.has(role, Permission.HANDOFF_WORK)
        ? []
        : releaseClaimedSessions(manager, workspaceId, targetUserId);
    });

    if (!this.permissions.has(role, Permission.HANDOFF_WORK)) {
      this.afterAccessReduced(workspaceId, targetUserId, released, 'role-changed');
    }
    return { userId: targetUserId, role };
  }

  // Removing someone else. Removing yourself is leave(): same effect, but a different decision
  // with a different confirmation, and it must not need members.manage.
  async removeMember(workspaceId: number, actorUserId: number, targetUserId: number) {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('To remove yourself, leave the workspace instead.');
    }
    await this.endMembership(workspaceId, targetUserId, 'removed');
    return { userId: targetUserId, removed: true };
  }

  async leave(workspaceId: number, userId: number) {
    await this.endMembership(workspaceId, userId, 'left');
    return { workspaceId, left: true };
  }

  // Promote the target to owner and step the current owner down to agent, in one transaction.
  //
  // Why this exists when owners can already promote others: done as two separate role changes,
  // there is a window between them, and a failure in between leaves either two owners (harmless
  // but not what was asked) or, done in the wrong order, the second step refused by the
  // last-owner check. One transaction has no in-between for anyone to observe or get stuck in.
  async transferOwnership(workspaceId: number, actorUserId: number, targetUserId: number) {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('You already own this workspace.');
    }

    await this.dataSource.transaction(async (manager) => {
      await lockWorkspace(manager, workspaceId);

      const target = await manager.findOne(Membership, { where: { workspaceId, userId: targetUserId } });
      if (!target) {
        throw new NotFoundException('Ownership can only be transferred to an existing member of this workspace.');
      }
      target.role = MembershipRole.OWNER;
      await manager.save(target);

      // The actor is still an owner at this point (PermissionsGuard required it). If they were
      // demoted by someone else a moment ago, the lock means we see that now, and refuse.
      const actor = await manager.findOne(Membership, { where: { workspaceId, userId: actorUserId } });
      if (!actor || actor.role !== MembershipRole.OWNER) {
        throw new ConflictException('You are no longer an owner of this workspace.');
      }
      actor.role = MembershipRole.AGENT;
      await manager.save(actor);
    });

    return { newOwnerUserId: targetUserId, previousOwnerUserId: actorUserId, previousOwnerRole: MembershipRole.AGENT };
  }

  private async endMembership(workspaceId: number, userId: number, reason: 'removed' | 'left'): Promise<void> {
    const released = await this.dataSource.transaction(async (manager) => {
      await lockWorkspace(manager, workspaceId);

      const membership = await manager.findOne(Membership, { where: { workspaceId, userId } });
      if (!membership) {
        throw new NotFoundException('This user is not a member of this workspace.');
      }
      if (membership.role === MembershipRole.OWNER) {
        await assertAnotherOwnerRemains(manager, workspaceId);
      }

      // The DELETE waits here for any in-flight claim holding this membership row FOR SHARE
      // (lockMembershipForShare), so the release below also catches a session claimed a moment ago.
      await manager.delete(Membership, { workspaceId, userId });
      return releaseClaimedSessions(manager, workspaceId, userId);
    });

    this.afterAccessReduced(workspaceId, userId, released, reason);
  }

  // After commit, never inside the transaction: a broadcast can't be rolled back, so telling
  // agents "this session is back in the queue" before the commit is final would be telling
  // them something that might not become true.
  private afterAccessReduced(workspaceId: number, userId: number, releasedSessionIds: string[], reason: string): void {
    for (const sessionId of releasedSessionIds) {
      this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-escalated', { sessionId });
    }
    this.broadcaster.revokeRoom(agentUserRoom(workspaceId, userId), 'access-revoked', { workspaceId, reason });
  }

  async getWidgetSettings(workspaceId: number) {
    const workspace = await this.findWorkspaceOrThrow(workspaceId);
    return { publicKey: workspace.publicKey, allowedOrigins: workspace.allowedOrigins };
  }

  async updateAllowedOrigins(workspaceId: number, allowedOrigins: string[]) {
    const workspace = await this.findWorkspaceOrThrow(workspaceId);
    workspace.allowedOrigins = allowedOrigins;
    await this.workspaces.save(workspace);
    return { publicKey: workspace.publicKey, allowedOrigins: workspace.allowedOrigins };
  }

  private async findWorkspaceOrThrow(workspaceId: number): Promise<Workspace> {
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
    if (!workspace) {
      throw new NotFoundException('Workspace not found.');
    }
    return workspace;
  }
}

// Serialises every ownership-affecting change within one workspace. Exported because member
// removal, leaving and ownership transfer (invitations work) must take the same lock.
//
// Why a lock, when Phase 12's claim needed only a conditional UPDATE: the claim's condition
// (status = 'escalated') lives on the very row being updated, so one UPDATE ... WHERE is atomic.
// "Is there another owner?" is a condition across OTHER rows. Two owners demoting each other at
// the same instant would each count 2 owners, each pass, and leave the workspace with none —
// write skew, which no single-row conditional update prevents. Locking the workspace row makes
// the second transaction wait until the first commits, so its count is correct.
export async function lockWorkspace(manager: EntityManager, workspaceId: number): Promise<void> {
  const rows = await manager.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  if (rows.length === 0) {
    throw new NotFoundException('Workspace not found.');
  }
}

// Only meaningful with the workspace already locked (lockWorkspace) in the same transaction —
// otherwise the count can be stale by the time it is acted on.
export async function assertAnotherOwnerRemains(manager: EntityManager, workspaceId: number): Promise<void> {
  const owners = await manager.count(Membership, { where: { workspaceId, role: MembershipRole.OWNER } });
  if (owners <= 1) {
    throw new ConflictException(
      'A workspace must always have at least one owner. Make someone else an owner first, or transfer ownership.',
    );
  }
}

// Hands someone's claimed conversations back to the queue when they can no longer work them.
// Back to 'escalated' rather than 'open': these customers asked for a human and are still
// waiting for one. escalated_at is left alone on purpose, so the queue shows how long they have
// REALLY been waiting (and priority keeps rising) rather than restarting their clock.
// Resolved sessions keep claimed_by_user_id: that is history ("who handled this"), not access.
async function releaseClaimedSessions(manager: EntityManager, workspaceId: number, userId: number): Promise<string[]> {
  const [rows] = await manager.query(
    `UPDATE conversation_sessions
     SET status = 'escalated', claimed_by_user_id = NULL, claimed_at = NULL
     WHERE workspace_id = $1 AND claimed_by_user_id = $2 AND status = 'claimed'
     RETURNING session_id AS "sessionId"`,
    [workspaceId, userId],
  );
  return rows.map((row: { sessionId: string }) => row.sessionId);
}
