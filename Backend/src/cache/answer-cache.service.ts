import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { withTimeout } from '../common/utils/with-timeout';
import type { AnswerResult } from '../modules/answer/answer-result.interface';

// What a cache entry stores. Deliberately excludes token counts (a hit consumed none, so it
// must not report the original call's usage — that matters to Phase 15 metering) and the
// cache outcome itself, which describes a request, not an answer.
export type CachedAnswer = Omit<AnswerResult, 'cache' | 'promptTokens' | 'totalTokens'>;

export interface WorkspaceCacheIdentity {
  workspaceId: number;
  publicKey: string;
  knowledgeVersion: number;
}

const BASE_TTL_SECONDS = 24 * 60 * 60;
// ±10%. Entries written in the same burst would otherwise all expire in the same second and
// cause a synchronised wave of misses — a self-inflicted stampede.
const TTL_JITTER_FRACTION = 0.1;
// A cache is an optimisation. If Redis is slow or unreachable, a request must degrade to a
// miss quickly rather than wait: ioredis queues commands while disconnected and retries them,
// which would otherwise add seconds to every /ask for the whole length of an outage.
const REDIS_TIMEOUT_MS = 250;

// Exact-match normalisation, and nothing looser. It collapses only differences that cannot
// change the meaning of a question: case, surrounding and repeated whitespace, and trailing
// punctuation. Internal punctuation is kept on purpose — "E-4021" and "E4021" may be
// different product codes, and "can't" is not "cant". Semantic equivalence is NOT attempted
// here: measured against this project's embedding model, "refund AFTER 30 days" and "refund
// WITHIN 30 days" sit 0.053 apart while genuine paraphrases sit 0.19-0.26 apart, so no
// similarity threshold can serve paraphrases without also serving opposite answers.
export function normalizeQuestion(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.]+$/u, '');
}

@Injectable()
export class AnswerCacheService {
  private readonly logger = new Logger(AnswerCacheService.name);
  readonly locks: AnswerCacheLocks;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.locks = new AnswerCacheLocks(redis, this.logger);
  }

  async getIdentity(workspaceId: number): Promise<WorkspaceCacheIdentity | null> {
    const rows = await this.dataSource.query(
      `SELECT public_key AS "publicKey", knowledge_version AS "knowledgeVersion"
       FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    if (rows.length === 0) return null;
    return { workspaceId, publicKey: rows[0].publicKey, knowledgeVersion: Number(rows[0].knowledgeVersion) };
  }

  // Called wherever the set of chunks retrieval can see for a workspace changes. Bumping too
  // often only costs cache misses; bumping too rarely serves answers grounded in content that
  // no longer exists — so every such path bumps, even when two bumps land close together.
  async bumpKnowledgeVersion(workspaceId: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE workspaces SET knowledge_version = knowledge_version + 1 WHERE id = $1`,
      [workspaceId],
    );
  }

  // Every component is here because leaving it out causes a specific wrong answer:
  //   workspaceId      — without it, one tenant is served another tenant's answers.
  //   publicKey        — a random per-workspace token that is never reused. Integer ids CAN
  //                      be reused (a TRUNCATE ... RESTART IDENTITY, a restored backup), and
  //                      this project's own test suite does exactly that between every test
  //                      while Redis persists, so a new "workspace 1" would otherwise inherit
  //                      the old workspace 1's cache.
  //   knowledgeVersion — bumping it makes every entry for the old knowledge base unreachable.
  //   promptVersion    — a changed prompt, model or threshold must not serve answers
  //                      generated under the old one.
  //   question hash    — the normalised question itself.
  buildKey(identity: WorkspaceCacheIdentity, promptVersion: number, question: string): string {
    const hash = createHash('sha256').update(normalizeQuestion(question)).digest('hex');
    return `answer:${identity.workspaceId}:${identity.publicKey}:v${identity.knowledgeVersion}:p${promptVersion}:${hash}`;
  }

  // SHADOW semantic tier. Finds the earlier answer a semantic cache WOULD have served for this
  // question, so its distance can be recorded — and never serves it. That is the whole design:
  // measured on this model, a negation pair with opposite answers ("refund after 30 days" /
  // "within 30 days") sits 0.053 apart, closer than every genuine paraphrase (0.19-0.26), so
  // no threshold is safe to serve on. Recording what it would have done, against real traffic,
  // is how that gets settled with data instead of a guess.
  //
  // Every WHERE condition mirrors a rule a real cache would have to obey, so the candidates
  // measured are ones that could actually have been served:
  //   same workspace, knowledge version and prompt version — the same key components the
  //     exact tier uses;
  //   status 'answered' — refusals and escalations are never cached;
  //   cache_outcome 'miss' — an ORIGINAL, history-free generated answer: not a follow-up
  //     turn (bypass), and not a hit (which is only a copy of some earlier miss).
  async findShadowCandidate(
    identity: WorkspaceCacheIdentity,
    promptVersion: number,
    queryEmbedding: number[],
  ): Promise<{ conversationId: number; distance: number } | null> {
    try {
      const rows = await this.dataSource.query(
        `SELECT id, question_embedding <=> $1::vector AS distance
         FROM conversations
         WHERE workspace_id = $2
           AND knowledge_version = $3
           AND prompt_version = $4
           AND status = 'answered'
           AND cache_outcome = 'miss'
           AND question_embedding IS NOT NULL
         ORDER BY question_embedding <=> $1::vector
         LIMIT 1`,
        [`[${queryEmbedding.join(',')}]`, identity.workspaceId, identity.knowledgeVersion, promptVersion],
      );
      if (rows.length === 0) return null;
      return { conversationId: rows[0].id, distance: Number(rows[0].distance) };
    } catch (err) {
      // A measurement must never cost a customer their answer. Logged, not swallowed.
      this.logger.warn(`Shadow cache lookup failed; recording nothing: ${(err as Error).message}`);
      return null;
    }
  }

  // Fail OPEN, deliberately the opposite of Phase 11's allowlist, which fails closed. The
  // difference is what failure costs: a security check that errors must deny, but a cache
  // that errors should simply not be used. The error is still logged — a swallowed failure
  // with no trace is exactly the silent-bug shape this project keeps finding.
  async get(key: string): Promise<CachedAnswer | null> {
    try {
      const raw = await withTimeout(this.redis.get(key), REDIS_TIMEOUT_MS);
      return raw ? (JSON.parse(raw) as CachedAnswer) : null;
    } catch (err) {
      this.logger.warn(`Answer cache read failed, treating as a miss: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: CachedAnswer): Promise<void> {
    const jitter = 1 + (Math.random() * 2 - 1) * TTL_JITTER_FRACTION;
    const ttlSeconds = Math.round(BASE_TTL_SECONDS * jitter);
    try {
      await withTimeout(this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds), REDIS_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(`Answer cache write failed, answer not cached: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Stampede protection
// ---------------------------------------------------------------------------------------

// Longer than a realistic miss (embed ~0.5s + retrieve + generate ~2s, measured), short
// enough that a request which crashes while holding the lock blocks this question for
// seconds rather than forever. The TTL is the lock's only defence against a dead holder.
const LOCK_TTL_MS = 15_000;
// A waiter never waits longer than this. Past it, doing the work itself is better than
// making a customer stare at a spinner because someone else's request is slow.
const MAX_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

// Release only if the lock is still OURS. Without the token check this is the classic
// distributed-lock bug: request A's lock expires while A is still generating, request B
// acquires a fresh lock, A finishes and runs a plain DEL — deleting B's lock, letting C in,
// and quietly reopening the stampede. GET-compare-DEL must also be ONE atomic step (hence a
// Lua script, which Redis runs without interleaving); as two separate commands, the lock
// could change hands between the GET and the DEL.
const RELEASE_IF_OWNED = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export type LockOutcome =
  | { state: 'acquired'; token: string }
  // Someone else is already generating this answer.
  | { state: 'held' }
  // Redis could not be reached. Distinct from 'held' on purpose: waiting on a lock system
  // that is down would add MAX_WAIT_MS to every request for the length of the outage.
  //
  // It still carries the token, and that was found by breaking it, not designed up front.
  // With Redis frozen (docker pause), the SET NX times out on OUR side — but it was already
  // sent, so Redis executes it the moment it wakes. That leaves a lock nobody believes they
  // own, alive for its full TTL, making every waiter behind it sit out MAX_WAIT_MS. Because
  // commands on one connection execute in order, releasing with this token after the work is
  // done queues the compare-and-delete BEHIND that late SET, and removes it.
  | { state: 'unavailable'; token: string };

export class AnswerCacheLocks {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async acquire(cacheKey: string): Promise<LockOutcome> {
    const token = randomUUID();
    try {
      const reply = await withTimeout(
        this.redis.set(lockKey(cacheKey), token, 'PX', LOCK_TTL_MS, 'NX'),
        REDIS_TIMEOUT_MS,
      );
      return reply === 'OK' ? { state: 'acquired', token } : { state: 'held' };
    } catch (err) {
      this.logger.warn(`Answer cache lock unavailable, proceeding unlocked: ${(err as Error).message}`);
      return { state: 'unavailable', token };
    }
  }

  async release(cacheKey: string, token: string): Promise<boolean> {
    try {
      const deleted = await withTimeout(
        this.redis.eval(RELEASE_IF_OWNED, 1, lockKey(cacheKey), token) as Promise<number>,
        REDIS_TIMEOUT_MS,
      );
      return deleted === 1;
    } catch (err) {
      // Not fatal: the lock's own TTL will free it. Logged so a pattern of these is visible.
      this.logger.warn(`Answer cache lock release failed; it will expire on its own: ${(err as Error).message}`);
      return false;
    }
  }

  // Polls until the entry appears, the holder gives up (lock gone, no entry — a refusal or an
  // escalation, neither of which is cached), or the wait budget runs out. Stopping as soon as
  // the lock disappears matters: without it, every waiter behind a refused question would sit
  // out the full MAX_WAIT_MS for an entry that is never coming.
  async waitForEntry(cacheKey: string, read: (key: string) => Promise<CachedAnswer | null>): Promise<CachedAnswer | null> {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const entry = await read(cacheKey);
      if (entry) return entry;
      try {
        const stillHeld = await withTimeout(this.redis.exists(lockKey(cacheKey)), REDIS_TIMEOUT_MS);
        if (!stillHeld) return null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function lockKey(cacheKey: string): string {
  return `lock:${cacheKey}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
