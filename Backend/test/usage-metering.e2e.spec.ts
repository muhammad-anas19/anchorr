import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { UsageMeter } from '../src/metering/usage-meter.service';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { resetDatabase } from './helpers/reset-database';

// Counting substitute providers, as in answer-cache.e2e: the assertions here are about how
// many times work was done and metered, which a real Gemini call can't make deterministic —
// and this suite asks the same question many times, which would burn the daily quota.
// Retrieval SQL, Postgres, Redis and the transaction are all real.
const DIM = 768;
const unit = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

describe('Usage metering (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let baseUrl: string;
  const calls = { generate: 0 };
  let failGeneration = false;
  let generationDelayMs = 0;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Questions containing "unrelated" land on an orthogonal vector (distance 1 → refused);
      // everything else lands on the seeded chunk's vector (distance 0 → answered).
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue({ embed: async (text: string) => (text.includes('unrelated') ? unit(1) : unit(0)) })
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
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    calls.generate = 0;
    failGeneration = false;
    generationDelayMs = 0;
    jest.restoreAllMocks();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  async function setup() {
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

  function ask(token: string, question: string, idempotencyKey?: string) {
    const req = request(app.getHttpServer()).post('/workspaces/1/ask').set('Authorization', `Bearer ${token}`);
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send({ question });
  }

  const events = () =>
    dataSource.query(
      `SELECT metric, quantity, billable, idempotency_key AS key, conversation_id AS "conversationId", attributes
       FROM usage_events ORDER BY id`,
    );
  const count = async (table: string) => (await dataSource.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  describe('what gets metered', () => {
    it('meters an answered question once, in the same row-set as its conversation', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?').expect(201);

      const [conversation] = await dataSource.query(`SELECT id FROM conversations`);
      expect(await events()).toEqual([
        {
          metric: 'answer',
          quantity: 1,
          billable: true,
          key: `conversation:${conversation.id}`,
          conversationId: conversation.id,
          attributes: { status: 'answered', cache: 'miss', promptTokens: 40, totalTokens: 60, model: expect.any(String) },
        },
      ]);
    });

    it('meters a refusal as billable (the customer got a response), with no tokens', async () => {
      const token = await setup();
      const res = await ask(token, 'Something unrelated entirely').expect(201);
      expect(res.body.status).toBe('refused');

      const [event] = await events();
      expect(event).toMatchObject({ billable: true, attributes: { status: 'refused', totalTokens: null, model: null } });
    });

    it('records an escalation caused by our own failure, but not as billable', async () => {
      const token = await setup();
      failGeneration = true;
      const res = await ask(token, 'How long do refunds take?').expect(201);
      expect(res.body.status).toBe('escalated');

      const [event] = await events();
      expect(event).toMatchObject({ billable: false, attributes: { status: 'escalated' } });
    });

    it('meters a cache hit as billable with zero tokens — value-based, per the product decision', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?').expect(201);
      const hit = await ask(token, 'How long do refunds take?').expect(201);
      expect(hit.body.cache).toBe('hit');

      const [, second] = await events();
      expect(second).toMatchObject({ billable: true, attributes: { cache: 'hit', totalTokens: 0 } });
    });
  });

  // Break-it: the whole point of writing both rows in one transaction. If recording usage
  // fails, the conversation must not exist either — otherwise the customer got an answer
  // that will never be billed, and nothing anywhere would say so.
  it('never leaves a conversation without its usage event: a failing meter rolls both back', async () => {
    const token = await setup();
    jest.spyOn(app.get(UsageMeter), 'record').mockRejectedValueOnce(new Error('usage_events unavailable'));

    await ask(token, 'How long do refunds take?').expect(500);

    expect(await count('conversations')).toBe(0);
    expect(await count('usage_events')).toBe(0);
  });

  describe('idempotency', () => {
    it('replays the original answer for a retried key: one pipeline run, one charge', async () => {
      const token = await setup();
      const first = await ask(token, 'How long do refunds take?', 'retry-1').expect(201);
      const second = await ask(token, 'How long do refunds take?', 'retry-1').expect(201);

      expect(first.body.replayed).toBeUndefined();
      expect(second.body).toMatchObject({ replayed: true, answer: first.body.answer, totalTokens: 60 });
      expect(calls.generate).toBe(1);
      expect(await count('conversations')).toBe(1);
      expect(await count('usage_events')).toBe(1);
    });

    // The race: every request passes the replay check before any has committed. Only the
    // UNIQUE constraint decides; the losers' transactions roll back entirely.
    it('charges once when the same key arrives concurrently', async () => {
      const token = await setup();
      generationDelayMs = 300;

      const results = await Promise.all(Array.from({ length: 5 }, () => ask(token, 'How long do refunds take?', 'race-1')));

      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.answer)).size).toBe(1);
      expect(await count('conversations')).toBe(1);
      expect(await count('usage_events')).toBe(1);
    });

    it('treats a different key, or no key, as a new request', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?', 'a').expect(201);
      await ask(token, 'How long do refunds take?', 'b').expect(201);
      await ask(token, 'How long do refunds take?').expect(201);
      expect(await count('usage_events')).toBe(3);
    });

    // Keys are namespaced by caller. Another member sending the same raw key must get their
    // own answer, not a replay of (and so a way to read) someone else's.
    it('scopes keys per caller: the same raw key from another member is a separate request', async () => {
      const ownerToken = await setup();
      const agent = await dataSource.getRepository(User).save({ email: 'agent@northwind.com', passwordHash: 'x' });
      await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: agent.id, role: MembershipRole.AGENT });
      const agentToken = await jwtService.signAsync({ sub: agent.id });

      await ask(ownerToken, 'How long do refunds take?', 'shared').expect(201);
      const other = await ask(agentToken, 'How long do refunds take?', 'shared').expect(201);

      expect(other.body.replayed).toBeUndefined();
      expect(await count('usage_events')).toBe(2);
    });

    it('rejects a malformed key rather than storing it', async () => {
      const token = await setup();
      await ask(token, 'How long do refunds take?', "'; DROP TABLE conversations; --").expect(400);
      expect(await count('conversations')).toBe(0);
    });

    it('deduplicates a widget message re-sent with the same clientMessageId', async () => {
      const token = await setup();
      const settings = await request(app.getHttpServer())
        .patch('/workspaces/1/widget-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ allowedOrigins: ['http://widget-host.example'] })
        .expect(200);

      const client = io(`${baseUrl}/widget`, {
        auth: { publicKey: settings.body.publicKey, sessionId: 'visitor-1' },
        extraHeaders: { origin: 'http://widget-host.example' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clients.push(client);
      await new Promise<void>((resolve) => client.once('ready', () => resolve()));

      const answers: Array<{ replayed?: boolean }> = [];
      client.on('answer', (a) => answers.push(a));
      client.emit('message', { question: 'How long do refunds take?', clientMessageId: 'm-1' });
      await new Promise((r) => setTimeout(r, 400));
      client.emit('message', { question: 'How long do refunds take?', clientMessageId: 'm-1' });
      await new Promise((r) => setTimeout(r, 400));

      expect(answers).toHaveLength(2);
      expect(answers[1].replayed).toBe(true);
      expect(await count('usage_events')).toBe(1);
    });
  });
});
