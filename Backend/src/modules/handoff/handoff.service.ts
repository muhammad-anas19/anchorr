import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ConversationSession } from '../../database/entities/conversation-session.entity';
import { ConversationSessionStatus } from '../../database/entities/conversation-session-status.enum';
import { Conversation } from '../../database/entities/conversation.entity';
import { ConversationStatus } from '../../database/entities/conversation-status.enum';
import { Membership } from '../../database/entities/membership.entity';
import { RealtimeBroadcaster } from '../../realtime/realtime-broadcaster.service';
import { AgentPresenceService } from '../../realtime/agent-presence.service';
import { agentsRoom } from '../../realtime/rooms';
import {
  buildCursorPage,
  buildOffsetPage,
  CursorPage,
  OffsetPage,
} from '../../common/pagination/pagination';
import { DEFAULT_CURSOR_LIMIT, DEFAULT_PAGE_SIZE } from '../../common/pagination/pagination-query.dto';
import { QueueQueryDto } from './dto/queue-query.dto';
import {
  AgentPresenceRow,
  EscalationReason,
  HIGH_PRIORITY_WAIT_SECONDS,
  QueueRow,
  QueueStats,
} from './handoff-queue.interface';

@Injectable()
export class HandoffService {
  constructor(
    @InjectRepository(ConversationSession) private readonly sessions: Repository<ConversationSession>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly presence: AgentPresenceService,
    private readonly dataSource: DataSource,
  ) {}

  async listActive(workspaceId: number): Promise<ConversationSession[]> {
    return this.sessions.find({
      where: { workspaceId, status: In([ConversationSessionStatus.ESCALATED, ConversationSessionStatus.CLAIMED]) },
      order: { createdAt: 'ASC' },
    });
  }

  // Offset-paginated on purpose (see common/pagination/pagination.ts): the console shows page
  // numbers and per-tab totals, and a support queue is small enough that OFFSET's deep-page
  // cost never bites. Raw SQL because two LATERAL joins (latest turn, turn count) have no
  // clean query-builder equivalent — every user-supplied value goes in as a bound parameter,
  // never string-interpolated.
  async listQueue(workspaceId: number, query: QueueQueryDto): Promise<OffsetPage<QueueRow>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const params: unknown[] = [workspaceId];
    const where: string[] = ['cs.workspace_id = $1'];

    if (query.tab === 'waiting') {
      params.push(ConversationSessionStatus.ESCALATED);
      where.push(`cs.status = $${params.length}`);
    } else if (query.tab === 'active') {
      params.push(ConversationSessionStatus.CLAIMED);
      where.push(`cs.status = $${params.length}`);
    } else if (query.tab === 'resolved') {
      params.push(ConversationSessionStatus.RESOLVED);
      where.push(`cs.status = $${params.length}`);
    } else {
      // "All" still excludes OPEN — a session the AI is handling fine has never been handed
      // to a human and does not belong in a human's queue at all.
      params.push(ConversationSessionStatus.OPEN);
      where.push(`cs.status <> $${params.length}`);
    }

    const search = query.search?.trim();
    if (search) {
      // ILIKE with the wildcards added HERE, as part of the bound value — the pattern is
      // data, so a search for "100%" or "a_b" can never change the shape of the query.
      params.push(`%${search}%`);
      where.push(`(cs.session_id ILIKE $${params.length} OR latest.question ILIKE $${params.length})`);
    }

    if (query.priority) {
      params.push(HIGH_PRIORITY_WAIT_SECONDS);
      const comparison = query.priority === 'high' ? '>=' : '<';
      where.push(
        `EXTRACT(EPOCH FROM (now() - COALESCE(cs.escalated_at, cs.created_at))) ${comparison} $${params.length}`,
      );
    }

    // Built once and used by both the count and the page query, so the two can never drift
    // apart and report a total that does not match the rows actually returned. Both LEFT
    // JOINs are on at most one row each, so neither changes the count.
    const from = `
      FROM conversation_sessions cs
      LEFT JOIN users u ON u.id = cs.claimed_by_user_id
      LEFT JOIN LATERAL (
        SELECT c.question, c.status, c.min_distance
        FROM conversations c
        WHERE c.workspace_id = cs.workspace_id AND c.session_id = cs.session_id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      WHERE ${where.join(' AND ')}
    `;

    const countRows = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const total = countRows[0]?.total ?? 0;

    // cs.id is a tiebreaker, not decoration: without it, rows sharing a timestamp can come
    // back in a different order per request and the same row appears on two pages.
    const order =
      query.tab === 'resolved'
        ? 'ORDER BY cs.resolved_at DESC NULLS LAST, cs.id DESC'
        : 'ORDER BY COALESCE(cs.escalated_at, cs.created_at) ASC, cs.id ASC';

    const pageParams = [...params, pageSize, (page - 1) * pageSize];
    const rows = await this.dataSource.query(
      `
      SELECT
        cs.session_id                AS "sessionId",
        cs.status                    AS "status",
        cs.claimed_by_user_id        AS "claimedByUserId",
        cs.escalated_at              AS "escalatedAt",
        cs.resolved_at               AS "resolvedAt",
        cs.created_at                AS "createdAt",
        u.email                      AS "claimedByEmail",
        latest.question              AS "topic",
        latest.status                AS "lastTurnStatus",
        latest.min_distance          AS "lastTurnMinDistance",
        (
          SELECT COUNT(*)::int FROM conversations c2
          WHERE c2.workspace_id = cs.workspace_id AND c2.session_id = cs.session_id
        )                            AS "turnCount",
        GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(cs.escalated_at, cs.created_at)))::int, 0) AS "waitingSeconds"
      ${from}
      ${order}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
      `,
      pageParams,
    );

    return buildOffsetPage(rows.map(toQueueRow), total, page, pageSize);
  }

  async getStats(workspaceId: number): Promise<QueueStats> {
    const rows = await this.dataSource.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'escalated')::int AS waiting,
        COUNT(*) FILTER (WHERE status = 'claimed')::int   AS active,
        COUNT(*) FILTER (WHERE status = 'resolved')::int  AS resolved,
        COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at >= date_trunc('day', now()))::int AS "resolvedToday",
        COALESCE(
          MAX(EXTRACT(EPOCH FROM (now() - COALESCE(escalated_at, created_at)))) FILTER (WHERE status = 'escalated'),
          0
        )::int AS "longestWaitSeconds"
      FROM conversation_sessions
      WHERE workspace_id = $1
      `,
      [workspaceId],
    );

    const row = rows[0];
    return {
      waiting: row.waiting,
      active: row.active,
      resolved: row.resolved,
      resolvedToday: row.resolvedToday,
      longestWaitSeconds: row.longestWaitSeconds,
      agentsOnline: this.presence.onlineUserIds(workspaceId).length,
    };
  }

  // Real membership rows joined against who is genuinely holding a socket right now. There is
  // no "away" state and no last-seen timestamp: nothing in this system records either, and
  // inventing them would put a plausible-looking lie on an operations screen.
  async getPresence(workspaceId: number): Promise<AgentPresenceRow[]> {
    const members = await this.memberships.find({ where: { workspaceId }, relations: { user: true } });
    const activeCounts = await this.dataSource.query(
      `
      SELECT claimed_by_user_id AS "userId", COUNT(*)::int AS count
      FROM conversation_sessions
      WHERE workspace_id = $1 AND status = 'claimed' AND claimed_by_user_id IS NOT NULL
      GROUP BY claimed_by_user_id
      `,
      [workspaceId],
    );
    const byUser = new Map<number, number>(activeCounts.map((r: { userId: number; count: number }) => [r.userId, r.count]));

    return members
      .map((m) => ({
        userId: m.userId,
        email: m.user.email,
        role: m.role,
        online: this.presence.isOnline(workspaceId, m.userId),
        activeCount: byUser.get(m.userId) ?? 0,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.email.localeCompare(b.email));
  }

  // Only the two reasons this system can actually produce (Phase 10's state machine): a turn
  // is refused when retrieval was too weak, escalated when generation itself failed. The
  // prototype's third reason ("customer asked for a human") has no code path behind it yet.
  async getEscalationReasons(workspaceId: number): Promise<EscalationReason[]> {
    const rows = await this.dataSource.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM conversations
      WHERE workspace_id = $1
        AND status IN ('refused', 'escalated')
        AND created_at >= now() - interval '30 days'
      GROUP BY status
      `,
      [workspaceId],
    );

    const counts = new Map<string, number>(rows.map((r: { status: string; count: number }) => [r.status, r.count]));
    const refused = counts.get('refused') ?? 0;
    const escalated = counts.get('escalated') ?? 0;
    const total = refused + escalated;

    return [
      { label: 'Low retrieval confidence', count: refused, percent: total ? Math.round((refused / total) * 100) : 0 },
      { label: 'Generation failure', count: escalated, percent: total ? Math.round((escalated / total) * 100) : 0 },
    ];
  }

  // Cursor-paginated, unlike the queue above, and for a concrete reason: a transcript grows
  // at the end while an agent is reading it. With OFFSET, every new turn shifts older rows
  // down a page and "load older" starts repeating rows it already showed. A keyset cursor
  // anchors on a row id, so new arrivals cannot disturb the window being paged through.
  async listTurns(
    workspaceId: number,
    sessionId: string,
    cursor: string | undefined,
    limit = DEFAULT_CURSOR_LIMIT,
  ): Promise<CursorPage<Conversation>> {
    const qb = this.conversations
      .createQueryBuilder('c')
      .where('c.workspace_id = :workspaceId', { workspaceId })
      .andWhere('c.session_id = :sessionId', { sessionId })
      .orderBy('c.id', 'DESC')
      .take(limit + 1); // the +1 is what answers hasMore without a second COUNT

    if (cursor) {
      const cursorId = Number(cursor);
      if (!Number.isInteger(cursorId)) {
        throw new NotFoundException('Invalid cursor.');
      }
      qb.andWhere('c.id < :cursorId', { cursorId });
    }

    const rows = await qb.getMany();
    const pageData = buildCursorPage(rows, limit, (row) => String(row.id));
    // Fetched newest-first so the cursor can seek; returned oldest-first so a transcript
    // reads in the order it happened.
    return { ...pageData, items: [...pageData.items].reverse() };
  }

  async getDetail(workspaceId: number, sessionId: string): Promise<{ session: ConversationSession; turns: Conversation[] }> {
    const session = await this.sessions.findOne({ where: { workspaceId, sessionId } });
    if (!session) {
      throw new NotFoundException('No such conversation session in this workspace.');
    }
    const turns = await this.conversations.find({ where: { workspaceId, sessionId }, order: { createdAt: 'ASC' } });
    return { session, turns };
  }

  // The whole claim feature in one method: a single, atomically-conditional UPDATE — no
  // separate "check unclaimed, then update" steps (Q2/Q4). Whether *this* call's UPDATE
  // actually changed anything is the only truth that matters; the follow-up lookup on a
  // miss exists purely to give a precise error message, not to establish correctness.
  async claim(workspaceId: number, sessionId: string, userId: number): Promise<ConversationSession> {
    const result = await this.sessions
      .createQueryBuilder()
      .update(ConversationSession)
      .set({ status: ConversationSessionStatus.CLAIMED, claimedByUserId: userId, claimedAt: () => 'now()' })
      .where('workspace_id = :workspaceId', { workspaceId })
      .andWhere('session_id = :sessionId', { sessionId })
      .andWhere('status = :status', { status: ConversationSessionStatus.ESCALATED })
      .execute();

    if (result.affected === 0) {
      const existing = await this.sessions.findOne({ where: { workspaceId, sessionId } });
      if (!existing) {
        throw new NotFoundException('No such conversation session in this workspace.');
      }
      throw new ConflictException(`This conversation is already ${existing.status}.`);
    }

    const claimed = await this.sessions.findOneOrFail({ where: { workspaceId, sessionId } });

    // Tells every OTHER connected agent's console this session is no longer available, in
    // real time — the one agent who actually claimed it already knows from its own REST
    // response; this broadcast is for everyone else (Q9's "REST for the action, WebSocket
    // for telling everyone else" split).
    this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-claimed', {
      sessionId,
      claimedByUserId: userId,
    });

    return claimed;
  }

  // Same atomic-conditional-UPDATE shape as claim() — a double-resolve race is harmless in
  // practice (nothing bad happens if two agents both mark the same thing resolved a moment
  // apart), but the pattern is kept consistent rather than special-cased away.
  async resolve(workspaceId: number, sessionId: string): Promise<ConversationSession> {
    const result = await this.sessions
      .createQueryBuilder()
      .update(ConversationSession)
      .set({ status: ConversationSessionStatus.RESOLVED, resolvedAt: () => 'now()' })
      .where('workspace_id = :workspaceId', { workspaceId })
      .andWhere('session_id = :sessionId', { sessionId })
      .andWhere('status = :status', { status: ConversationSessionStatus.CLAIMED })
      .execute();

    if (result.affected === 0) {
      const existing = await this.sessions.findOne({ where: { workspaceId, sessionId } });
      if (!existing) {
        throw new NotFoundException('No such conversation session in this workspace.');
      }
      throw new ConflictException(`Cannot resolve a session that is ${existing.status}.`);
    }

    const resolved = await this.sessions.findOneOrFail({ where: { workspaceId, sessionId } });
    this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-resolved', { sessionId });
    return resolved;
  }

  // Called by AnswerService whenever a turn genuinely escalates. Deliberately never
  // downgrades a session that's already claimed or resolved back to escalated — a session
  // an agent already owns (or already closed out) shouldn't silently reappear in the queue
  // just because one more turn on it happened to fail.
  async recordEscalation(workspaceId: number, sessionId: string): Promise<void> {
    const existing = await this.sessions.findOne({ where: { workspaceId, sessionId } });
    if (!existing) {
      await this.sessions.save({
        workspaceId,
        sessionId,
        status: ConversationSessionStatus.ESCALATED,
        escalatedAt: new Date(),
      });
      this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-escalated', { sessionId });
      return;
    }
    if (existing.status === ConversationSessionStatus.OPEN) {
      existing.status = ConversationSessionStatus.ESCALATED;
      existing.escalatedAt = new Date();
      await this.sessions.save(existing);
      this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-escalated', { sessionId });
    }
  }
}

interface RawQueueRow {
  sessionId: string;
  status: ConversationSessionStatus;
  claimedByUserId: number | null;
  claimedByEmail: string | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  topic: string | null;
  lastTurnStatus: ConversationStatus | null;
  lastTurnMinDistance: string | number | null;
  turnCount: number;
  waitingSeconds: number;
}

function toQueueRow(raw: RawQueueRow): QueueRow {
  return {
    sessionId: raw.sessionId,
    status: raw.status,
    claimedByUserId: raw.claimedByUserId,
    claimedByEmail: raw.claimedByEmail,
    escalatedAt: raw.escalatedAt,
    resolvedAt: raw.resolvedAt,
    createdAt: raw.createdAt,
    topic: raw.topic,
    turnCount: raw.turnCount,
    waitingSeconds: raw.waitingSeconds,
    priority: raw.waitingSeconds >= HIGH_PRIORITY_WAIT_SECONDS ? 'high' : 'normal',
    reason: toReason(raw.lastTurnStatus),
    lastTurnStatus: raw.lastTurnStatus,
    // Postgres returns double precision through the driver as a string often enough that
    // parsing here is not defensive padding — it is the difference between a real number and
    // "0.31" silently reaching the UI's arithmetic.
    lastTurnMinDistance: raw.lastTurnMinDistance === null ? null : Number(raw.lastTurnMinDistance),
  };
}

function toReason(lastTurnStatus: ConversationStatus | null): QueueRow['reason'] {
  if (lastTurnStatus === ConversationStatus.REFUSED) return 'Low confidence';
  if (lastTurnStatus === ConversationStatus.ESCALATED) return 'Generation failure';
  return 'Unknown';
}
