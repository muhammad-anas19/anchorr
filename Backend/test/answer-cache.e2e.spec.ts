import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { AnswerCacheService, normalizeQuestion } from '../src/cache/answer-cache.service';

// Both providers are counting substitutes, and that is the point rather than a shortcut:
// "a hit is fast" proves nothing, "a hit made ZERO embedding calls and ZERO generation calls"
// proves the cache actually short-circuits the pipeline. Real retrieval SQL and real Redis
// run underneath. Real Gemini is not needed for any assertion here and would burn the 20/day
// generation quota on a suite that deliberately asks the same question repeatedly.
const DIM = 768;
const unit = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

describe('Answer cache (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let answerCache: AnswerCacheService;
  const calls = { embed: 0, generate: 0 };
  let failGeneration = false;
  // Delays let concurrent requests genuinely overlap. With instant stubs, 20 "concurrent"
  // requests can finish one after another and a stampede test would pass without any lock.
  let embedDelayMs = 0;
  let generationDelayMs = 0;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue({
        embed: async () => {
          calls.embed++;
          if (embedDelayMs) await pause(embedDelayMs);
          return unit(0);
        },
      })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async () => {
          calls.generate++;
          if (generationDelayMs) await pause(generationDelayMs);
          if (failGeneration) throw new Error('simulated provider outage');
          return { text: `Refunds take 5-7 business days [1]. (#${calls.generate})`, promptTokens: 40, totalTokens: 60 };
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    redis = moduleRef.get(REDIS_CLIENT);
    answerCache = moduleRef.get(AnswerCacheService);
  });

  afterAll(async () => {
    await app.close();
  });

  // Deliberately NO Redis cleanup here. Workspace ids restart at 1 every test while Redis
  // persists, so a key built from the integer id alone would let this test's workspace 1
  // inherit the previous test's cached answers. The cache key includes each workspace's
  // random publicKey precisely so that cannot happen — and leaving Redis dirty is what makes
  // every test in this file an implicit proof of it.
  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
    calls.embed = 0;
    calls.generate = 0;
    failGeneration = false;
    embedDelayMs = 0;
    generationDelayMs = 0;
  });

  async function register(email: string, workspaceName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery', workspaceName });
    const [{ workspace_id: workspaceId }] = await dataSource.query(
      `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    return { token: res.body.accessToken as string, workspaceId: Number(workspaceId) };
  }

  async function seedChunk(workspaceId: number, content: string, vector: number[]): Promise<number> {
    const suffix = `${workspaceId}-${Math.random().toString(36).slice(2)}`;
    const [doc] = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, 'policy.pdf', $2, 'application/pdf', 10, $3, 'ready') RETURNING id`,
      [workspaceId, `key-${suffix}`, suffix.padEnd(64, '0').slice(0, 64)],
    );
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, $2, 0, $3, $4::vector)`,
      [doc.id, content, content.length, `[${vector.join(',')}]`],
    );
    return doc.id;
  }

  function ask(token: string, workspaceId: number, question: string, sessionId?: string) {
    return request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send(sessionId ? { question, sessionId } : { question })
      .expect(201);
  }

  describe('normalisation', () => {
    it('collapses only differences that cannot change meaning', () => {
      expect(normalizeQuestion('  How do I get a REFUND?? ')).toBe('how do i get a refund');
      expect(normalizeQuestion('How   do I\tget a refund')).toBe('how do i get a refund');
      // Internal punctuation survives: these may be different product codes, and "can't"
      // is not "cant". Loosening this is how an exact cache starts serving wrong answers.
      expect(normalizeQuestion('What is E-4021?')).not.toBe(normalizeQuestion('What is E4021?'));
      expect(normalizeQuestion("I can't log in")).not.toBe(normalizeQuestion('I cant log in'));
    });
  });

  describe('serving', () => {
    it('serves a normalised repeat from cache, calling NEITHER external provider', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));

      const first = await ask(token, workspaceId, 'How long do refunds take?');
      expect(first.body).toMatchObject({ status: 'answered', cache: 'miss' });
      expect(calls).toEqual({ embed: 1, generate: 1 });

      const second = await ask(token, workspaceId, '  how long do refunds TAKE ');
      expect(second.body).toMatchObject({ status: 'answered', cache: 'hit' });
      // The whole point: no embedding, no generation, on the second request.
      expect(calls).toEqual({ embed: 1, generate: 1 });
      // Same answer and citations, but a hit consumed no tokens — Phase 15 meters on these.
      expect(second.body.answer).toBe(first.body.answer);
      expect(second.body.citations).toEqual(first.body.citations);
      expect(second.body.promptTokens).toBe(0);
      expect(second.body.totalTokens).toBe(0);

      // A hit is still a real customer exchange and is still logged as one.
      const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM conversations');
      expect(count).toBe(2);
    });

    it('does not serve an answer for a different question', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));

      await ask(token, workspaceId, 'Can I get a refund within 30 days?');
      const res = await ask(token, workspaceId, 'Can I get a refund after 30 days?');

      // The pair the whole design is built around: 0.053 apart in embedding space, opposite
      // answers. An exact-match cache cannot confuse them.
      expect(res.body.cache).toBe('miss');
      expect(calls.generate).toBe(2);
    });

    it('never serves one workspace another workspace\'s cached answer', async () => {
      const northwind = await register('anas@northwind.com', 'Northwind Devices');
      const acme = await register('sam@acme.com', 'Acme Corp');
      await seedChunk(northwind.workspaceId, 'Northwind refunds take 5-7 days.', unit(0));
      await seedChunk(acme.workspaceId, 'Acme refunds take 30 days.', unit(0));

      await ask(northwind.token, northwind.workspaceId, 'How long do refunds take?');
      const acmeRes = await ask(acme.token, acme.workspaceId, 'How long do refunds take?');

      expect(acmeRes.body.cache).toBe('miss');
      expect(calls.generate).toBe(2);
    });

    it('a new workspace that reuses an old integer id does not inherit its cache', async () => {
      const first = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(first.workspaceId, 'Refunds take 5-7 days.', unit(0));
      await ask(first.token, first.workspaceId, 'How long do refunds take?');

      // Exactly what the test harness does between tests — and what a restored backup or a
      // RESTART IDENTITY does in real life. Redis is untouched.
      await dataSource.query(
        'TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
      );
      const second = await register('someone@else.com', 'A Different Company');
      expect(second.workspaceId).toBe(first.workspaceId);
      await seedChunk(second.workspaceId, 'Refunds take 90 days here.', unit(0));

      const res = await ask(second.token, second.workspaceId, 'How long do refunds take?');
      expect(res.body.cache).toBe('miss');
    });
  });

  describe('what is never cached', () => {
    it('never caches a refusal', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      // Orthogonal to every query vector: cosine distance 1.0, far above the 0.45 threshold.
      await seedChunk(workspaceId, 'Unrelated content.', unit(1));

      const first = await ask(token, workspaceId, 'What is the capital of France?');
      const second = await ask(token, workspaceId, 'What is the capital of France?');

      expect(first.body.status).toBe('refused');
      expect(second.body).toMatchObject({ status: 'refused', cache: 'miss' });
      expect(calls.embed).toBe(2);
    });

    it('never caches an escalation, so a transient outage does not become a persistent one', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));

      failGeneration = true;
      const during = await ask(token, workspaceId, 'How long do refunds take?');
      expect(during.body.status).toBe('escalated');

      // The provider recovers. The customer must get a real answer, not a cached failure.
      failGeneration = false;
      const after = await ask(token, workspaceId, 'How long do refunds take?');
      expect(after.body).toMatchObject({ status: 'answered', cache: 'miss' });
    });

    it('bypasses the cache for any turn that uses conversation history, in both directions', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));

      // Standalone first question in a fresh session: eligible, and gets cached.
      const opening = await ask(token, workspaceId, 'How long do refunds take?', 'session-a');
      expect(opening.body.cache).toBe('miss');

      // A follow-up in the same session uses history: never cached...
      const followUp = await ask(token, workspaceId, 'And for enterprise plans?', 'session-a');
      expect(followUp.body.cache).toBe('bypass');

      // ...and a cached entry is never SERVED into a conversation that has history either,
      // even for a question whose exact text is cached.
      const generatedBefore = calls.generate;
      const repeatMidConversation = await ask(token, workspaceId, 'How long do refunds take?', 'session-a');
      expect(repeatMidConversation.body.cache).toBe('bypass');
      expect(calls.generate).toBe(generatedBefore + 1);

      // The same question in a brand-new session is a clean first turn, and hits.
      const otherVisitor = await ask(token, workspaceId, 'How long do refunds take?', 'session-b');
      expect(otherVisitor.body.cache).toBe('hit');
    });
  });

  describe('stampede protection', () => {
    it('20 concurrent identical questions make exactly ONE embedding and ONE generation call', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      // Slow enough that all 20 requests are in flight while the first is still generating —
      // the only condition under which a stampede can happen at all.
      generationDelayMs = 800;

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => ask(token, workspaceId, 'How long do refunds take?')),
      );

      expect(calls.generate).toBe(1);
      expect(calls.embed).toBe(1);
      // Everyone got the same real answer...
      const answers = new Set(responses.map((r) => r.body.answer));
      expect(answers.size).toBe(1);
      expect(responses.every((r) => r.body.status === 'answered')).toBe(true);
      // ...one generated it, nineteen were served the result of that single call.
      const outcomes = responses.map((r) => r.body.cache).sort();
      expect(outcomes.filter((o) => o === 'miss')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'hit')).toHaveLength(19);
      // All twenty are still real, logged customer exchanges.
      const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM conversations');
      expect(count).toBe(20);
    }, 30000);

    // The PREMISE of the test above, asserted rather than assumed. If these 20 requests were
    // being serialised somewhere else — a connection pool, a single-threaded stub — the
    // "exactly one call" test would pass with no lock at all and prove nothing. Disabling the
    // lock must turn the same burst into a real stampede, or that test is not testing it.
    it('without the lock, the same burst really is a stampede', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      generationDelayMs = 800;

      const realAcquire = answerCache.locks.acquire.bind(answerCache.locks);
      answerCache.locks.acquire = async () => ({ state: 'unavailable', token: 'no-lock-was-taken' });
      try {
        await Promise.all(Array.from({ length: 20 }, () => ask(token, workspaceId, 'How long do refunds take?')));
      } finally {
        answerCache.locks.acquire = realAcquire;
      }

      expect(calls.generate).toBe(20);
    }, 30000);

    it('waiters stop waiting as soon as the holder finishes without caching, instead of sitting out the full wait', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Unrelated content.', unit(1)); // every question is refused
      embedDelayMs = 500;

      const started = Date.now();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => ask(token, workspaceId, 'What is the capital of France?')),
      );
      const elapsed = Date.now() - started;

      expect(responses.every((r) => r.body.status === 'refused')).toBe(true);
      // Refusals are never cached, so no waiter is ever served one — each does its own work.
      expect(calls.embed).toBe(10);
      // The wait budget is 10 seconds. Without the "lock gone, stop waiting" check, every
      // waiter behind a refused question would sit out all of it. Measured here: the holder
      // (~0.5s) plus one poll plus each waiter's own work (~0.5s), nowhere near 10s.
      expect(elapsed).toBeLessThan(4000);
    }, 30000);

    // Found by freezing Redis with `docker pause`, not by reasoning about the code. A lock
    // request that times out on OUR side was still sent, so Redis executes it on waking,
    // leaving a lock nobody believes they own. This reproduces that state directly: the lock
    // exists, holding the token of a request that was told 'unavailable'.
    it('cleans up a lock that landed after the request had already given up on it', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      const identity = await answerCache.getIdentity(workspaceId);
      const key = answerCache.buildKey(identity!, 1, 'How long do refunds take?');

      const lateToken = 'token-from-a-timed-out-acquire';
      await redis.set(`lock:${key}`, lateToken, 'PX', 15000);

      const realAcquire = answerCache.locks.acquire.bind(answerCache.locks);
      answerCache.locks.acquire = async () => ({ state: 'unavailable', token: lateToken });
      try {
        await ask(token, workspaceId, 'How long do refunds take?');
      } finally {
        answerCache.locks.acquire = realAcquire;
      }

      // Without the fix this lock sits ownerless for its whole TTL; any refused question
      // behind it would make every waiter sit out the full 10-second wait budget.
      expect(await redis.exists(`lock:${key}`)).toBe(0);
    });

    it('releasing a lock never deletes a lock that now belongs to someone else', async () => {
      const key = `answer:test:ownership:${Date.now()}`;
      const first = await answerCache.locks.acquire(key);
      expect(first.state).toBe('acquired');

      // Simulate the dangerous interleaving: A's lock expires mid-generation and B acquires a
      // fresh one. Overwriting the value is exactly what an expiry followed by B's SET NX does.
      await redis.set(`lock:${key}`, 'token-belonging-to-B', 'PX', 15000);

      // A finishes and releases with its own, now stale, token.
      const released = await answerCache.locks.release(key, (first as { token: string }).token);

      expect(released).toBe(false);
      expect(await redis.get(`lock:${key}`)).toBe('token-belonging-to-B');
      await redis.del(`lock:${key}`);
    });

    it('a second request cannot acquire a lock that is already held', async () => {
      const key = `answer:test:mutual-exclusion:${Date.now()}`;
      const first = await answerCache.locks.acquire(key);
      const second = await answerCache.locks.acquire(key);

      expect(first.state).toBe('acquired');
      expect(second.state).toBe('held');
      // And it carries a TTL, so a holder that crashes cannot lock this question out forever.
      const pttl = await redis.pttl(`lock:${key}`);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(15000);
      await redis.del(`lock:${key}`);
    });
  });

  describe('invalidation', () => {
    it('deleting a document invalidates every cached answer for the workspace', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      const docId = await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      await seedChunk(workspaceId, 'Refunds for enterprise plans take 30 days.', unit(0));

      await ask(token, workspaceId, 'How long do refunds take?');
      expect((await ask(token, workspaceId, 'How long do refunds take?')).body.cache).toBe('hit');

      // Through the real endpoint, so the hook in DocumentsService.remove is what is tested.
      await request(app.getHttpServer())
        .delete(`/workspaces/${workspaceId}/documents/${docId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const after = await ask(token, workspaceId, 'How long do refunds take?');
      expect(after.body.cache).toBe('miss');
    });

    it('a version bump makes old entries unreachable without deleting them', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      await ask(token, workspaceId, 'How long do refunds take?');

      const before = await answerCache.getIdentity(workspaceId);
      const oldKey = answerCache.buildKey(before!, 1, 'How long do refunds take?');
      await answerCache.bumpKnowledgeVersion(workspaceId);

      // The old entry is still physically in Redis — nothing was scanned or deleted — yet a
      // lookup can no longer reach it, because every new key carries the new version.
      expect(await redis.exists(oldKey)).toBe(1);
      expect((await ask(token, workspaceId, 'How long do refunds take?')).body.cache).toBe('miss');
    });

    it('writes entries with a jittered TTL around 24 hours', async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedChunk(workspaceId, 'Refunds are issued within 5-7 business days.', unit(0));
      await ask(token, workspaceId, 'How long do refunds take?');

      const identity = await answerCache.getIdentity(workspaceId);
      const ttl = await redis.ttl(answerCache.buildKey(identity!, 1, 'How long do refunds take?'));
      // 24h ± 10%. Without an expiry, orphaned entries from old versions would live forever.
      expect(ttl).toBeGreaterThan(24 * 3600 * 0.89);
      expect(ttl).toBeLessThanOrEqual(24 * 3600 * 1.1);
    });
  });
});
