import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';

describe('Answer (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let embeddingProvider: EmbeddingProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    embeddingProvider = moduleRef.get(EMBEDDING_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
  });

  async function register(email: string, workspaceName: string) {
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email,
      password: 'correct-horse-battery',
      workspaceName,
    });
    const [{ workspace_id: workspaceId }] = await dataSource.query(
      `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    return { token: res.body.accessToken as string, workspaceId: Number(workspaceId) };
  }

  async function seedEmbeddedChunk(workspaceId: number, suffix: string, content: string): Promise<void> {
    const doc = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, $2, $3, 'application/pdf', 10, $4, 'processing') RETURNING id`,
      [workspaceId, `${suffix}.pdf`, `key-${suffix}-${workspaceId}`, suffix.repeat(8).slice(0, 64).padEnd(64, '0')],
    );
    const embedding = await embeddingProvider.embed(content);
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, $2, 0, $3, $4::vector)`,
      [doc[0].id, content, content.length, `[${embedding.join(',')}]`],
    );
  }

  it(
    'answers a question grounded in the workspace\'s own documentation, with a resolved citation',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      const res = await request(app.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How many days do I have to request a refund?' })
        .expect(201);

      expect(res.body.answer.toLowerCase()).toContain('30 day');
      expect(res.body.citations).toHaveLength(1);
      expect(res.body.citations[0]).toMatchObject({ index: 1, originalFilename: 'refunds.pdf' });
      expect(res.body.status).toBe('answered');

      const [saved] = await dataSource.query('SELECT * FROM conversations WHERE workspace_id = $1', [workspaceId]);
      expect(saved.status).toBe('answered');
      expect(saved.min_distance).toBeLessThan(0.45);
      expect(saved.citations).toHaveLength(1);
    },
    20000,
  );

  it(
    'returns the fixed "no information" answer without calling the generation provider when nothing is retrieved',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      // No chunks seeded for this workspace at all.

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: () => {
            throw new Error('generation provider should never be called when retrieval is empty');
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();

      const res = await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'Anything at all' })
        .expect(201);

      expect(res.body.answer).toBe("I don't have information about that.");
      expect(res.body.citations).toEqual([]);
      expect(res.body.status).toBe('refused');

      const isolatedDataSource = moduleRef.get(DataSource);
      const [saved] = await isolatedDataSource.query('SELECT * FROM conversations WHERE workspace_id = $1', [
        workspaceId,
      ]);
      expect(saved.status).toBe('refused');
      expect(saved.min_distance).toBeNull();

      await isolatedApp.close();
    },
    15000,
  );

  it(
    'refuses (rather than answering from a weak match) when the closest retrieved chunk is not actually relevant',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: () => {
            throw new Error('generation provider should never be called for a weak, below-threshold match');
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();
      const isolatedDataSource = moduleRef.get(DataSource);

      // A real, genuinely unrelated question — measured directly against this project's own
      // embedding model at ~0.56 distance vs. the refund chunk, above the 0.45 threshold —
      // real chunks come back from retrieval (k defaults to 5, so *something* is always
      // returned), but none of them are actually close enough to trust.
      const res = await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'What is the airspeed velocity of an unladen swallow?' })
        .expect(201);

      expect(res.body.answer).toBe("I don't have information about that.");
      expect(res.body.status).toBe('refused');

      const [saved] = await isolatedDataSource.query('SELECT * FROM conversations WHERE workspace_id = $1', [
        workspaceId,
      ]);
      expect(saved.status).toBe('refused');
      expect(Number(saved.min_distance)).toBeGreaterThanOrEqual(0.45);

      await isolatedApp.close();
    },
    15000,
  );

  it(
    'never answers using another workspace\'s documentation',
    async () => {
      const northwind = await register('anas@northwind.com', 'Northwind Devices');
      const acme = await register('sam@acme.com', 'Acme Corp');
      await seedEmbeddedChunk(acme.workspaceId, 'acme-refunds', 'Acme refunds are available within 30 days.');

      const res = await request(app.getHttpServer())
        .post(`/workspaces/${northwind.workspaceId}/ask`)
        .set('Authorization', `Bearer ${northwind.token}`)
        .send({ question: 'How many days do I have to request a refund?' })
        .expect(201);

      expect(res.body.answer).toBe("I don't have information about that.");
      expect(res.body.citations).toEqual([]);
    },
    20000,
  );

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).post('/workspaces/1/ask').send({ question: 'anything' }).expect(401);
  });

  it('rejects a request from a user with no membership in the target workspace', async () => {
    const northwind = await register('anas@northwind.com', 'Northwind Devices');
    const acme = await register('sam@acme.com', 'Acme Corp');

    await request(app.getHttpServer())
      .post(`/workspaces/${acme.workspaceId}/ask`)
      .set('Authorization', `Bearer ${northwind.token}`)
      .send({ question: 'anything' })
      .expect(403);
  });

  it(
    'silently drops a citation number the model invented that does not correspond to any retrieved chunk',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          // A real, possible model behavior (per Q12: models don't always follow
          // instructions perfectly) — citing [1] (real) and [7] (doesn't exist, since
          // only one chunk was ever sent).
          generate: async () => 'Refunds are available within 30 days [1], according to policy [7].',
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();

      const res = await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How many days for a refund?' })
        .expect(201);

      // The real [1] resolves; the invented [7] is dropped rather than crashing the
      // whole response or surfacing a broken/incomplete citation entry.
      expect(res.body.citations).toHaveLength(1);
      expect(res.body.citations[0].index).toBe(1);

      await isolatedApp.close();
    },
    15000,
  );

  it(
    'escalates gracefully — not a raw 500 — when the generation provider itself fails, and persists the escalation',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: async () => {
            throw new Error('Simulated Gemini outage.');
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();
      const isolatedDataSource = moduleRef.get(DataSource);

      // Phase 9's raw 500 is now Phase 10's graceful escalation — a real, concrete reason to
      // flag a conversation for a human, unlike a guessed confidence middle-zone. No retry
      // either way: the customer is waiting live (Q10's reasoning still holds).
      const res = await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How many days for a refund?' })
        .expect(201);

      expect(res.body.status).toBe('escalated');
      expect(res.body.citations).toEqual([]);

      const [saved] = await isolatedDataSource.query('SELECT * FROM conversations WHERE workspace_id = $1', [
        workspaceId,
      ]);
      expect(saved.status).toBe('escalated');

      await isolatedApp.close();
    },
  );

  it(
    'includes the last turns of the same session as prior conversation context in the prompt',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      const sessionId = 'session-abc-123';
      await dataSource.query(
        `INSERT INTO conversations (workspace_id, session_id, question, answer, status, min_distance, citations)
         VALUES ($1, $2, 'What is your refund policy?', 'Refunds are available within 30 days.', 'answered', 0.1, '[]')`,
        [workspaceId, sessionId],
      );

      let capturedPrompt = '';
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: async (systemPrompt: string) => {
            capturedPrompt = systemPrompt;
            return 'Yes, 30 days from purchase [1].';
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();

      await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'And does that apply to sale items too?', sessionId })
        .expect(201);

      expect(capturedPrompt).toContain('What is your refund policy?');
      expect(capturedPrompt).toContain('Refunds are available within 30 days.');

      const isolatedDataSource = moduleRef.get(DataSource);
      const rows = await isolatedDataSource.query(
        'SELECT * FROM conversations WHERE workspace_id = $1 AND session_id = $2 ORDER BY id',
        [workspaceId, sessionId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[1].session_id).toBe(sessionId);

      await isolatedApp.close();
    },
    15000,
  );

  it(
    'never leaks a different session\'s history into the prompt',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');

      await dataSource.query(
        `INSERT INTO conversations (workspace_id, session_id, question, answer, status, min_distance, citations)
         VALUES ($1, 'a-different-session', 'What are your store hours?', 'We are open 9-5.', 'answered', 0.1, '[]')`,
        [workspaceId],
      );

      let capturedPrompt = '';
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: async (systemPrompt: string) => {
            capturedPrompt = systemPrompt;
            return 'Refunds are available within 30 days [1].';
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();

      await request(isolatedApp.getHttpServer())
        .post(`/workspaces/${workspaceId}/ask`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How many days for a refund?', sessionId: 'this-session' })
        .expect(201);

      expect(capturedPrompt).not.toContain('store hours');

      await isolatedApp.close();
    },
    15000,
  );

  it('rejects an empty question', async () => {
    const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');

    await request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: '' })
      .expect(400);
  });
});
