import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { QuotaService } from '../src/metering/quota.service';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { WIDGET_SESSION_LIMIT } from '../src/modules/widget-chat/widget-rate-limit.guard';
import type Redis from 'ioredis';
import { resetDatabase } from './helpers/reset-database';

// Counting substitute providers (see usage-metering.e2e for why). Questions containing
// "unrelated" are refused; "explode" makes the question's embedding fail.
const DIM = 768;
const unit = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

describe('Quotas (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let baseUrl: string;
  const calls = { generate: 0 };
  let failGeneration = false;
  let generationDelayMs = 0;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue({
        embed: async (text: string) => {
          if (text.includes('explode')) throw new Error('simulated embedding outage');
          return text.includes('unrelated') ? unit(1) : unit(0);
        },
      })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async () => {
          calls.generate++;
          if (generationDelayMs) await new Promise((r) => setTimeout(r, generationDelayMs));
          if (failGeneration) throw new Error('simulated provider outage');
          return { text: 'Refunds take 5-7 business days [1].', promptTokens: 40, totalTokens: 60 };
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // The /ask rate-limit bucket is keyed by workspace id, which restarts at 1 each test while
    // Redis persists — without this, earlier tests' requests would drain this test's budget
    // and the quota assertions would see 429s (rate limit) instead of 402s (quota).
    await app.get<Redis>(REDIS_CLIENT).del('ask:1');
    calls.generate = 0;
    failGeneration = false;
    generationDelayMs = 0;
    jest.restoreAllMocks();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  async function setup(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'owner@northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind' })
      .expect(201);
    const [doc] = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES (1, 'refunds.pdf', 'k1', 'application/pdf', 10, $1, 'ready') RETURNING id`,
      ['a'.repeat(64)],
    );
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, 'Refunds take 5-7 business days.', 0, 32, $2::vector)`,
      [doc.id, `[${unit(0).join(',')}]`],
    );
    return res.body.accessToken as string;
  }

  const ask = (token: string, question: string, key?: string) => {
    const req = request(app.getHttpServer()).post('/workspaces/1/ask').set('Authorization', `Bearer ${token}`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ question });
  };
  const used = async () => (await dataSource.query(`SELECT used FROM workspace_quotas WHERE workspace_id = 1`))[0].used;
  const setQuota = (sql: string) => dataSource.query(`UPDATE workspace_quotas SET ${sql} WHERE workspace_id = 1`);
  const count = async (table: string) => (await dataSource.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  describe('the trial', () => {
    it('is created with the workspace: 200 answers for 7 days, by the database clock', async () => {
      await setup();
      const [row] = await dataSource.query(
        `SELECT allowance, used, source,
                abs(extract(epoch FROM (period_end - period_start)) - 7 * 86400) AS "lengthDrift",
                abs(extract(epoch FROM (now() - period_start))) AS "startDrift"
         FROM workspace_quotas`,
      );
      expect(row).toMatchObject({ allowance: 200, used: 0, source: 'trial' });
      expect(Number(row.lengthDrift)).toBeLessThan(1);
      expect(Number(row.startDrift)).toBeLessThan(60);
    });

    // Registration is one transaction now. Before, a failure after the workspace was saved but
    // before its quota row would leave a workspace with NO quota rows — which reads as
    // unlimited. Break it: make the trial insert fail and check nothing was left behind.
    it('is atomic with registration: if the trial row fails, no account is created', async () => {
      jest.spyOn(app.get(QuotaService), 'createTrial').mockRejectedValueOnce(new Error('quota insert failed'));
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'owner@northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind' })
        .expect(500);

      expect(await count('users')).toBe(0);
      expect(await count('workspaces')).toBe(0);
      expect(await count('memberships')).toBe(0);
    });
  });

  describe('what consumes the allowance', () => {
    it('counts answered, refused and cache-hit turns; refunds an escalation caused by our failure', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?').expect(201); // answered
      await ask(token, 'How long do refunds take?').expect(201); // cache hit
      await ask(token, 'Something unrelated').expect(201); // refused
      expect(await used()).toBe(3);

      failGeneration = true;
      const escalated = await ask(token, 'A brand new question').expect(201);
      expect(escalated.body.status).toBe('escalated');
      expect(await used()).toBe(3); // reserved, then refunded
    });

    it('escalates gracefully (not a 500) when embedding the question fails, and does not count it', async () => {
      const token = await setup();
      const res = await ask(token, 'please explode').expect(201);
      expect(res.body).toMatchObject({ status: 'escalated', escalationReason: 'retrieval_failed' });
      expect(await used()).toBe(0);
      const [event] = await dataSource.query(`SELECT billable, attributes FROM usage_events`);
      expect(event).toMatchObject({ billable: false, attributes: { escalationReason: 'retrieval_failed' } });
    });

    it('does not count a replay: a retried idempotency key consumes one unit, not two', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?', 'k-1').expect(201);
      await ask(token, 'How long do refunds take?', 'k-1').expect(201);
      expect(await used()).toBe(1);
    });
  });

  describe('enforcement', () => {
    it('refuses with 402 once exhausted — before any work is done', async () => {
      const token = await setup();
      await setQuota('used = allowance');

      const res = await ask(token, 'How long do refunds take?').expect(402);
      expect(res.body).toMatchObject({ error: 'quota_exhausted' });
      expect(calls.generate).toBe(0);
      expect(await count('conversations')).toBe(0);
      expect(await count('usage_events')).toBe(0);
    });

    // The distinction that must not collapse: "has had quota rows, none current" is an ended
    // trial, not a pay-as-you-go workspace.
    it('refuses an ended trial (402 trial_ended) rather than treating it as unlimited', async () => {
      const token = await setup();
      await setQuota(`period_start = now() - interval '8 days', period_end = now() - interval '1 day'`);
      const res = await ask(token, 'How long do refunds take?').expect(402);
      expect(res.body.error).toBe('trial_ended');
    });

    it('treats a workspace that has never had a quota row as unlimited (pay-as-you-go)', async () => {
      const token = await setup();
      await dataSource.query(`DELETE FROM workspace_quotas`);
      await ask(token, 'How long do refunds take?').expect(201);
    });

    // Break-it: the race the atomic reservation exists for. 10 units left, 20 concurrent
    // requests, each a different question (so the cache lock can't serialise them). Exactly
    // 10 may get through — check-then-increment in application code would let most of 20 in.
    it('lets exactly as many concurrent requests through as there are units left', async () => {
      const token = await setup();
      await setQuota('allowance = 500, used = 490');
      generationDelayMs = 200;

      // 20 requests is exactly the /ask burst, so the rate-limit bucket must be full here, or
      // some requests come back 429 and this stops being a test of the quota at all.
      await app.get<Redis>(REDIS_CLIENT).del('ask:1');
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ask(token, `Refund question number ${i}`)));
      const statuses = results.map((r) => r.status);
      // Asserted first so a failure names the real cause — a 429 is the rate limit, not the quota.
      expect(statuses).not.toContain(429);

      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.filter((s) => s === 402)).toHaveLength(10);
      expect(await used()).toBe(500);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM usage_events WHERE billable`);
      expect(n).toBe(10);
    });

    // A crash between reserve() and the usage event leaks a unit. The counter is a cache of
    // the meter, so the meter can always repair it.
    it('reconciles a leaked counter back to what the meter says', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?').expect(201);
      await ask(token, 'Something unrelated').expect(201);
      await setQuota('used = used + 5'); // five "crashed" reservations

      const repaired = await app.get(QuotaService).reconcile(1);
      expect(repaired).toEqual({ before: 7, after: 2 });
      expect(await used()).toBe(2);
    });
  });

  describe('the widget', () => {
    async function connect(token: string, sessionId = 'visitor-1') {
      const settings = await request(app.getHttpServer())
        .patch('/workspaces/1/widget-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ allowedOrigins: ['http://widget-host.example'] })
        .expect(200);
      const client = io(`${baseUrl}/widget`, {
        auth: { publicKey: settings.body.publicKey, sessionId },
        extraHeaders: { origin: 'http://widget-host.example' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clients.push(client);
      await new Promise<void>((resolve) => client.once('ready', () => resolve()));
      // Buckets are keyed by the workspace's public key, which is new each test — but clear
      // them anyway so a test never depends on that.
      const redis = app.get<Redis>(REDIS_CLIENT);
      await redis.del(`widget-session:${settings.body.publicKey}:${sessionId}`, `widget-site:${settings.body.publicKey}`);
      return client;
    }

    async function burst(client: ClientSocket, messages: number) {
      let answered = 0;
      let limited: { retryAfterSeconds: number } | null = null;
      const onAnswer = () => answered++;
      const onLimited = (payload: { retryAfterSeconds: number }) => (limited = payload);
      client.on('answer', onAnswer);
      client.on('rate-limited', onLimited);
      for (let i = 0; i < messages; i++) client.emit('message', { question: `Refund question ${Math.random()}` });
      await new Promise((r) => setTimeout(r, 1500));
      client.off('answer', onAnswer);
      client.off('rate-limited', onLimited);
      return { answered, limited: limited as { retryAfterSeconds: number } | null };
    }

    // Phase 15's two buckets: one visitor gets a burst of WIDGET_SESSION_LIMIT.capacity, then
    // a named 'rate-limited' event with the wait. Their refusals are not charged to the site.
    it('limits one visitor past their burst, with the wait, while other visitors carry on', async () => {
      const token = await setup();
      const noisy = await connect(token, 'noisy-visitor');

      const first = await burst(noisy, WIDGET_SESSION_LIMIT.capacity + 3);
      expect(first.answered).toBe(WIDGET_SESSION_LIMIT.capacity);
      expect(first.limited).toEqual({ retryAfterSeconds: expect.any(Number) });
      expect(first.limited!.retryAfterSeconds).toBeLessThanOrEqual(3); // one token at 1 per 3 s

      // A different visitor on the same site is unaffected: the site bucket still has budget.
      const calm = await connect(token, 'calm-visitor');
      const second = await burst(calm, 1);
      expect(second).toEqual({ answered: 1, limited: null });

      // Refused messages cost nothing: only answered ones consumed the quota.
      expect(await used()).toBe(WIDGET_SESSION_LIMIT.capacity + 1);
      // Two 1.5 s listening windows plus setup and two socket handshakes: past Jest's 5 s
      // default under full-suite load, which is how this first failed.
    }, 20000);
    const nextAnswer = (client: ClientSocket) =>
      new Promise<Record<string, unknown>>((resolve) => client.once('answer', resolve));

    it('hands an over-quota visitor to a human, and never mentions billing', async () => {
      const token = await setup();
      await setQuota('used = allowance');
      const client = await connect(token);

      const answer = nextAnswer(client);
      client.emit('message', { question: 'How long do refunds take?' });
      const payload = await answer;

      expect(payload).toEqual({ answer: expect.stringMatching(/connect you with a member of our team/), status: 'escalated', citations: [] });
      expect(JSON.stringify(payload)).not.toMatch(/quota|billing|plan|limit/i);
      expect(calls.generate).toBe(0);

      // The business still gets the conversation: it's in the agent queue.
      const [session] = await dataSource.query(`SELECT status FROM conversation_sessions WHERE session_id = 'visitor-1'`);
      expect(session.status).toBe('escalated');
      const [event] = await dataSource.query(`SELECT billable, attributes FROM usage_events`);
      expect(event).toMatchObject({ billable: false, attributes: { escalationReason: 'quota_exhausted' } });
    });

    it('sends a visitor only the public fields — no retrieval internals', async () => {
      const token = await setup();
      const client = await connect(token);

      const answer = nextAnswer(client);
      client.emit('message', { question: 'How long do refunds take?' });
      const payload = await answer;

      expect(Object.keys(payload).sort()).toEqual(['answer', 'citations', 'status']);
      expect(payload.citations).toEqual([{ index: 1, documentId: 1, originalFilename: 'refunds.pdf' }]);
    });
  });
});
