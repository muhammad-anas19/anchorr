import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConversationSession } from '../../database/entities/conversation-session.entity';
import { ConversationSessionStatus } from '../../database/entities/conversation-session-status.enum';
import { Conversation } from '../../database/entities/conversation.entity';
import { RealtimeBroadcaster } from '../../realtime/realtime-broadcaster.service';
import { agentsRoom } from '../../realtime/rooms';

@Injectable()
export class HandoffService {
  constructor(
    @InjectRepository(ConversationSession) private readonly sessions: Repository<ConversationSession>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  async listActive(workspaceId: number): Promise<ConversationSession[]> {
    return this.sessions.find({
      where: { workspaceId, status: In([ConversationSessionStatus.ESCALATED, ConversationSessionStatus.CLAIMED]) },
      order: { createdAt: 'ASC' },
    });
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
      .set({ status: ConversationSessionStatus.RESOLVED })
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
      await this.sessions.save({ workspaceId, sessionId, status: ConversationSessionStatus.ESCALATED });
      this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-escalated', { sessionId });
      return;
    }
    if (existing.status === ConversationSessionStatus.OPEN) {
      existing.status = ConversationSessionStatus.ESCALATED;
      await this.sessions.save(existing);
      this.broadcaster.broadcast(agentsRoom(workspaceId), 'session-escalated', { sessionId });
    }
  }
}
