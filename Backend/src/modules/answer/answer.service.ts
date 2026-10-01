import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DEFAULT_K, RetrievalService } from '../retrieval/retrieval.service';
import { GENERATION_MODEL } from '../../generation/gemini-answer-generation.provider';
import { RetrievedChunk } from '../retrieval/retrieved-chunk.interface';
import {
  ANSWER_GENERATION_PROVIDER,
  AnswerGenerationProvider,
  GenerateResult,
} from '../../generation/answer-generation-provider.interface';
import { Conversation } from '../../database/entities/conversation.entity';
import { ConversationStatus } from '../../database/entities/conversation-status.enum';
import { HandoffService } from '../handoff/handoff.service';
import { AnswerConfig, AnswerResult, CacheOutcome, Citation, EscalationReason } from './answer-result.interface';
import { AnswerCacheService, CachedAnswer, WorkspaceCacheIdentity } from '../../cache/answer-cache.service';
import { isBillableAnswer, UsageMeter } from '../../metering/usage-meter.service';
import { QuotaExceededException, QuotaService } from '../../metering/quota.service';
import { isUniqueViolation } from '../../common/utils/postgres-errors';

const NO_INFORMATION_ANSWER = "I don't have information about that.";
const ESCALATION_ANSWER =
  "I'm having trouble generating an answer right now — let me connect you with a member of our team who can help.";
const HANDOFF_ANSWER = 'Let me connect you with a member of our team who can help with that.';
const CITATION_PATTERN = /\[(\d+)\]/g;

export const CONFIDENT_DISTANCE_THRESHOLD = 0.45;

export const ANSWER_PROMPT_VERSION = 1;

interface ConversationRecord {
  identity: WorkspaceCacheIdentity | null;
  questionEmbedding: number[] | null;
  shadow: { conversationId: number; distance: number } | null;
  idempotencyKey: string | null;
}


@Injectable()
export class AnswerService {
  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(ANSWER_GENERATION_PROVIDER) private readonly generationProvider: AnswerGenerationProvider,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly handoffService: HandoffService,
    private readonly answerCache: AnswerCacheService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly meter: UsageMeter,
    private readonly quota: QuotaService,
  ) {}

  async getConfig(workspaceId: number): Promise<AnswerConfig> {
    return {
      searchMode: 'Hybrid',
      topK: DEFAULT_K,
      model: GENERATION_MODEL,
      confidenceThreshold: CONFIDENT_DISTANCE_THRESHOLD,
      searchableChunks: await this.retrievalService.countSearchableChunks(workspaceId),
    };
  }

  async answer(
    workspaceId: number,
    question: string,
    sessionId: string | null = null,
    idempotencyKey: string | null = null,
  ): Promise<AnswerResult> {

    if (idempotencyKey) {
      const prior = await this.findReplay(workspaceId, idempotencyKey);
      if (prior) return prior;
    }

    const reservation = await this.quota.reserve(workspaceId);
    if (reservation.state === 'exhausted' || reservation.state === 'expired') {
      throw new QuotaExceededException(reservation);
    }

    let result: AnswerResult;
    try {
      result = await this.produce(workspaceId, question, sessionId, idempotencyKey);
    } catch (error) {
      await this.quota.refund(reservation); // nothing was delivered, so nothing is counted
      throw error;
    }

    if (!isBillableAnswer(result.status) || result.replayed) {
      await this.quota.refund(reservation);
    }
    return result;
  }

  async escalateUnanswered(
    workspaceId: number,
    question: string,
    sessionId: string | null,
    reason: EscalationReason,
  ): Promise<AnswerResult> {
    return this.persistAndReturn(
      workspaceId,
      question,
      {
        answer: HANDOFF_ANSWER,
        citations: [],
        status: ConversationStatus.ESCALATED,
        minDistance: null,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks: [],
        cache: 'bypass',
        escalationReason: reason,
      },
      sessionId,
      { identity: null, questionEmbedding: null, shadow: null, idempotencyKey: null },
    );
  }

  private async produce(
    workspaceId: number,
    question: string,
    sessionId: string | null,
    idempotencyKey: string | null,
  ): Promise<AnswerResult> {
    const identity = await this.answerCache.getIdentity(workspaceId);
    const cacheKey = identity ? this.answerCache.buildKey(identity, ANSWER_PROMPT_VERSION, question) : null;

    const hasHistory = sessionId ? await this.hasPriorTurns(workspaceId, sessionId) : false;
    const eligible = cacheKey !== null && !hasHistory;

    if (!eligible) {
      return this.runPipeline(workspaceId, question, sessionId, hasHistory, null, identity, idempotencyKey);
    }

    const cached = await this.answerCache.get(cacheKey);
    if (cached) return this.serveHit(workspaceId, question, sessionId, cached, identity, idempotencyKey);

    // Single-flight. Without this, 200 customers asking the same new question in the same
    // second all miss and all call Gemini — enough to exhaust the whole 20/day generation
    // quota in one burst and leave the product escalating everyone for the rest of the day.
    const lock = await this.answerCache.locks.acquire(cacheKey);

    if (lock.state === 'held') {
      const waited = await this.answerCache.locks.waitForEntry(cacheKey, (key) => this.answerCache.get(key));
      if (waited) return this.serveHit(workspaceId, question, sessionId, waited, identity, idempotencyKey);
      // The holder finished without caching (a refusal or an escalation), or ran past the wait
      // budget. Fall through and do the work — waiting forever is never the right answer.
    }

    try {
      return await this.runPipeline(workspaceId, question, sessionId, hasHistory, cacheKey, identity, idempotencyKey);
    } finally {
      // finally, not after the return: a thrown error must release the lock too, or this
      // question would be locked out until the TTL expired.
      //
      // 'unavailable' is released too. A lock request that timed out on our side may still
      // execute when Redis recovers; this compare-and-delete queues behind it and removes it,
      // instead of leaving an ownerless lock that stalls every waiter. The token check makes
      // it harmless when no such lock exists, or when someone else legitimately holds one.
      if (lock.state === 'acquired' || lock.state === 'unavailable') {
        await this.answerCache.locks.release(cacheKey, lock.token);
      }
    }
  }

  private serveHit(
    workspaceId: number,
    question: string,
    sessionId: string | null,
    cached: CachedAnswer,
    identity: WorkspaceCacheIdentity | null,
    idempotencyKey: string | null,
  ): Promise<AnswerResult> {
    // No embedding and no generation call happened, so none are reported — Phase 15 meters
    // on these fields. It is still a real customer exchange, so it is still logged. No
    // embedding was computed, so there is nothing for the shadow tier to compare.
    return this.persistAndReturn(
      workspaceId,
      question,
      { ...cached, promptTokens: 0, totalTokens: 0, cache: 'hit' },
      sessionId,
      { identity, questionEmbedding: null, shadow: null, idempotencyKey },
    );
  }

  // The Phase 8-13 pipeline, unchanged in substance. `cacheKey` is non-null only when this
  // turn is eligible to populate the cache.
  private async runPipeline(
    workspaceId: number,
    question: string,
    sessionId: string | null,
    hasHistory: boolean,
    cacheKey: string | null,
    identity: WorkspaceCacheIdentity | null,
    idempotencyKey: string | null,
  ): Promise<AnswerResult> {
    const cacheOutcome: CacheOutcome = hasHistory ? 'bypass' : 'miss';
    // Embedding the question calls Gemini too, and until Phase 15 a failure here escaped as a
    // raw 500 — a widget visitor got an error where a generation failure (Phase 10) would have
    // got a handoff. Same treatment now: escalate, never cache, never bill.
    let retrieved: Awaited<ReturnType<RetrievalService['retrieveRelevantChunks']>>;
    try {
      retrieved = await this.retrievalService.retrieveRelevantChunks(workspaceId, question);
    } catch {
      return this.persistAndReturn(workspaceId, question, {
        answer: ESCALATION_ANSWER,
        citations: [],
        status: ConversationStatus.ESCALATED,
        minDistance: null,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks: [],
        cache: cacheOutcome,
        escalationReason: 'retrieval_failed',
      }, sessionId, { identity, questionEmbedding: null, shadow: null, idempotencyKey });
    }
    const { chunks, queryEmbedding } = retrieved;

    // Shadow tier: what WOULD a semantic cache have served here? Recorded, never used. Runs
    // before the refuse/answer branch on purpose — a semantic cache serving a cached ANSWER to
    // a question fresh retrieval would REFUSE is one of the most important failure modes to
    // measure, and it only shows up if refused turns are recorded too. Only eligible turns are
    // looked up: a follow-up could never legally be served from any cache.
    const shadow =
      cacheKey && identity
        ? await this.answerCache.findShadowCandidate(identity, ANSWER_PROMPT_VERSION, queryEmbedding)
        : null;
    const record: ConversationRecord = { identity, questionEmbedding: queryEmbedding, shadow, idempotencyKey };

    const distances = chunks.map((chunk) => chunk.distance).filter((d) => Number.isFinite(d));
    const minDistance = distances.length > 0 ? Math.min(...distances) : null;

    const retrievedChunks = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      originalFilename: chunk.originalFilename,
      distance: chunk.distance,
      snippet: chunk.content.slice(0, 160),
      vectorRank: chunk.vectorRank,
      keywordRank: chunk.keywordRank,
    }));
    if (minDistance === null || minDistance >= CONFIDENT_DISTANCE_THRESHOLD) {
      // Refusals are never cached. They skip generation already, so caching saves little,
      // and a refusal means "no document covers this" — precisely the answer that becomes
      // wrong the moment someone uploads one.
      return this.persistAndReturn(workspaceId, question, {
        answer: NO_INFORMATION_ANSWER,
        citations: [],
        status: ConversationStatus.REFUSED,
        minDistance,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks,
        cache: cacheOutcome,
      }, sessionId, record);
    }
    // The answer below is a function of (question, history, chunks). Only when history is
    // empty is it a function of the question alone — the only case where one customer's
    // answer is correct for another customer asking the same words. The existence check
    // already told us whether there is any, so a first turn skips this query entirely.
    const history = hasHistory && sessionId ? await this.fetchRecentHistory(workspaceId, sessionId) : [];

    const systemPrompt = buildSystemPrompt(chunks, history);
    let generated: GenerateResult;
    try {
      generated = await this.generationProvider.generate(systemPrompt, question);
    } catch {
      // Never cached. An escalation here means generation FAILED — usually transiently.
      // Caching it would turn a 30-second provider outage into a day of "I'm having trouble"
      // for everyone asking the same question.
      return this.persistAndReturn(workspaceId, question, {
        answer: ESCALATION_ANSWER,
        citations: [],
        status: ConversationStatus.ESCALATED,
        minDistance,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks,
        cache: cacheOutcome,
        escalationReason: 'generation_failed',
      }, sessionId, record);
    }

    const citations = resolveCitations(generated.text, chunks);
    const result: AnswerResult = {
      answer: generated.text,
      citations,
      status: ConversationStatus.ANSWERED,
      minDistance,
      promptTokens: generated.promptTokens,
      totalTokens: generated.totalTokens,
      retrievedChunks,
      cache: cacheOutcome,
    };

    if (cacheKey) {
      const { cache: _cache, promptTokens: _p, totalTokens: _t, ...cacheable } = result;
      await this.answerCache.set(cacheKey, cacheable);
    }

    return this.persistAndReturn(workspaceId, question, result, sessionId, record);
  }

  // Existence only — eligibility needs to know WHETHER history exists, not what it says, so
  // this fetches one id rather than the last five full turns.
  private async hasPriorTurns(workspaceId: number, sessionId: string): Promise<boolean> {
    const prior = await this.conversations.findOne({
      where: { workspaceId, sessionId },
      select: { id: true },
    });
    return prior !== null;
  }

  private async fetchRecentHistory(workspaceId: number, sessionId: string): Promise<Conversation[]> {
    const rows = await this.conversations.find({
      where: { workspaceId, sessionId },
      order: { createdAt: 'DESC' },
      take: 5,
    });
    return rows.reverse();
  }

  // The conversation row and its usage event are written in ONE transaction: both exist or
  // neither does. There is no instant at which the customer has received an answer that was
  // recorded but not metered — the gap a separate write after commit would leave open.
  private async persistAndReturn(
    workspaceId: number,
    question: string,
    result: AnswerResult,
    sessionId: string | null,
    record: ConversationRecord,
  ): Promise<AnswerResult> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(Conversation, {
          workspaceId,
          sessionId,
          question,
          answer: result.answer,
          status: result.status,
          minDistance: result.minDistance,
          citations: result.citations,
          questionEmbedding: record.questionEmbedding,
          knowledgeVersion: record.identity?.knowledgeVersion ?? null,
          promptVersion: ANSWER_PROMPT_VERSION,
          cacheOutcome: result.cache,
          nearestPriorConversationId: record.shadow?.conversationId ?? null,
          nearestPriorDistance: record.shadow?.distance ?? null,
          idempotencyKey: record.idempotencyKey,
        });

        await this.meter.record(manager, {
          workspaceId,
          metric: 'answer',
          quantity: 1,
          billable: isBillableAnswer(result.status),
          // One event per conversation row, by construction.
          idempotencyKey: `conversation:${saved.id}`,
          conversationId: saved.id,
          attributes: {
            status: result.status,
            cache: result.cache,
            promptTokens: result.promptTokens,
            totalTokens: result.totalTokens,
            // Only an answer that actually called the model has one to name.
            model: result.totalTokens ? GENERATION_MODEL : null,
            ...(result.escalationReason ? { escalationReason: result.escalationReason } : {}),
          },
        });
      });
    } catch (error) {

      if (record.idempotencyKey && isUniqueViolation(error, 'UQ_conversations_idempotency')) {
        const winner = await this.findReplay(workspaceId, record.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }

    if (result.status === ConversationStatus.ESCALATED && sessionId) {
      await this.handoffService.recordEscalation(workspaceId, sessionId);
    }

    return result;
  }

  private async findReplay(workspaceId: number, idempotencyKey: string): Promise<AnswerResult | null> {
    const [row] = await this.dataSource.query(
      `SELECT c.answer, c.citations, c.status, c.min_distance AS "minDistance", c.cache_outcome AS "cacheOutcome",
              ue.attributes
       FROM conversations c
       LEFT JOIN usage_events ue ON ue.conversation_id = c.id AND ue.metric = 'answer'
       WHERE c.workspace_id = $1 AND c.idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    if (!row) return null;
    const attributes = (row.attributes ?? {}) as { promptTokens?: number | null; totalTokens?: number | null };
    return {
      answer: row.answer,
      citations: row.citations,
      status: row.status,
      minDistance: row.minDistance,
      promptTokens: attributes.promptTokens ?? null,
      totalTokens: attributes.totalTokens ?? null,
      retrievedChunks: [],
      cache: row.cacheOutcome ?? 'miss',
      replayed: true,
    };
  }
}

function buildSystemPrompt(chunks: RetrievedChunk[], history: Conversation[]): string {
  const context = chunks.map((chunk, i) => `[${i + 1}] ${chunk.content}`).join('\n');
  const historySection =
    history.length > 0
      ? '\n\nPrevious turns in this conversation (for context only — citations above still ' +
        'refer only to the numbered context, not to these prior turns):\n' +
        history.map((turn) => `Customer: ${turn.question}\nAssistant: ${turn.answer}`).join('\n')
      : '';
  return (
    "You are a customer support assistant. Answer the customer's question using ONLY the " +
    'information in the context below — do not use any outside knowledge. If the answer is ' +
    `not contained in the context, reply with exactly: "${NO_INFORMATION_ANSWER}"\n\n` +
    'When you use information from the context, cite it by putting the matching bracketed ' +
    'number(s) immediately after the relevant sentence, like [1] or [1][2].\n\n' +
    `Context:\n${context}${historySection}`
  );
}

function resolveCitations(rawAnswer: string, chunks: RetrievedChunk[]): Citation[] {
  const referencedIndexes = new Set<number>();
  for (const match of rawAnswer.matchAll(CITATION_PATTERN)) {
    referencedIndexes.add(Number(match[1]));
  }

  const citations: Citation[] = [];
  for (const index of referencedIndexes) {
    const chunk = chunks[index - 1]; // prompt numbers chunks 1..k; array is 0-indexed
    if (!chunk) {
      // The model cited a number that doesn't correspond to any chunk we actually sent —
      // a real possibility (models don't always follow instructions perfectly, per Q12).
      // Silently dropped rather than surfaced as an error: an unresolvable citation number
      // shouldn't break the whole response.
      continue;
    }
    citations.push({
      index,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      originalFilename: chunk.originalFilename,
      distance: chunk.distance,
    });
  }
  return citations.sort((a, b) => a.index - b.index);
}
