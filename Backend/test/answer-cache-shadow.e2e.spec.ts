import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { AnswerCacheService } from '../src/cache/answer-cache.service';

// REAL Gemini embeddings, unlike answer-cache.e2e.spec.ts. This suite is about what real
// vectors do — above all, that a negation pair with opposite answers embeds almost identically
// — and fake vectors would make that fiction. Generation stays a counting stub: every assertion
// here is about what was RECORDED and what was SERVED, never about what the model wrote.
describe('Answer cache — shadow semantic tier (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let embeddings: EmbeddingProvider;
  let answerCache: AnswerCacheService;
  let generateCalls = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async (_system: string, question: string) => {
          generateCalls++;
          return { text: `Fresh answer to: ${question} [1]`, promptTokens: 30, totalTokens: 50 };
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    embeddings = moduleRef.get(EMBEDDING_PROVIDER);
    answerCache = moduleRef.get(AnswerCacheService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
    generateCalls = 0;
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

  const POLICY =
    'Refunds are available within 30 days of purchase, provided the item is unused. ' +
    'After 30 days, purchases are final and cannot be refunded. ' +
    'To reset your password, use the "Forgot password" link on the sign-in page.';

  async function seedPolicy(workspaceId: number): Promise<void> {
    const suffix = `${workspaceId}-${Math.random().toString(36).slice(2)}`;
    const [doc] = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, 'policy.pdf', $2, 'application/pdf', 10, $3, 'ready') RETURNING id`,
      [workspaceId, `key-${suffix}`, suffix.padEnd(64, '0').slice(0, 64)],
    );
    const vector = await embeddings.embed(POLICY);
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, $2, 0, $3, $4::vector)`,
      [doc.id, POLICY, POLICY.length, `[${vector.join(',')}]`],
    );
  }

  function ask(token: string, workspaceId: number, question: string, sessionId?: string) {
    return request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send(sessionId ? { question, sessionId } : { question })
      .expect(201);
  }

  async function shadowFor(question: string) {
    const [row] = await dataSource.query(
      `SELECT id, cache_outcome, nearest_prior_conversation_id AS "priorId",
              nearest_prior_distance AS "priorDistance",
              question_embedding IS NOT NULL AS "hasEmbedding"
       FROM conversations WHERE question = $1 ORDER BY id DESC LIMIT 1`,
      [question],
    );
    return row as { id: number; cache_outcome: string; priorId: number | null; priorDistance: number | null; hasEmbedding: boolean };
  }

  it(
    'THE CASE THE DESIGN IS BUILT ON: records that a semantic cache would have served the opposite answer — and serves a fresh one',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedPolicy(workspaceId);

      const within = await ask(token, workspaceId, 'Can I get a refund within 30 days?');
      const after = await ask(token, workspaceId, 'Can I get a refund after 30 days?');

      // Premise: both are genuinely answerable — neither was refused, so each really reached
      // the point where a cache could have served it.
      expect(within.body.status).toBe('answered');
      expect(after.body.status).toBe('answered');

      const shadow = await shadowFor('Can I get a refund after 30 days?');
      // The nearest eligible prior is the "within 30 days" question...
      expect(shadow.priorId).toBe((await shadowFor('Can I get a refund within 30 days?')).id);
      // ...and it is extraordinarily close — closer than any genuine paraphrase measured for
      // this project (0.19-0.26). Any semantic threshold loose enough to catch paraphrases
      // would have served this customer the answer to the OPPOSITE question.
      expect(Number(shadow.priorDistance)).toBeLessThan(0.1);

      // What actually happened: nothing was served from that match. A fresh answer was
      // generated for the question actually asked.
      expect(after.body.cache).toBe('miss');
      expect(after.body.answer).toContain('after 30 days');
      expect(generateCalls).toBe(2);
    },
    60000,
  );

  it(
    'records a genuine paraphrase as a candidate, still without serving it',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedPolicy(workspaceId);

      await ask(token, workspaceId, 'How do I reset my password?');
      const paraphrase = await ask(token, workspaceId, 'I forgot my password, what do I do?');

      const shadow = await shadowFor('I forgot my password, what do I do?');
      expect(shadow.priorId).not.toBeNull();
      // In the paraphrase band — a hit a semantic cache would want. Recorded as evidence of
      // what a semantic tier could gain, set against the negation case above, which is what it
      // would cost.
      expect(Number(shadow.priorDistance)).toBeGreaterThan(0.1);
      expect(Number(shadow.priorDistance)).toBeLessThan(0.4);
      expect(paraphrase.body.cache).toBe('miss');
      expect(generateCalls).toBe(2);
    },
    60000,
  );

  it(
    'only ever measures candidates a real cache could legally have served',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedPolicy(workspaceId);

      // An eligible, original answer...
      await ask(token, workspaceId, 'How do refunds work?', 'session-a');
      // ...and a follow-up in the same conversation, which is NOT eligible: its answer depends
      // on history that no other customer shares.
      await ask(token, workspaceId, 'And what about after 30 days?', 'session-a');
      const followUp = await shadowFor('And what about after 30 days?');
      expect(followUp.cache_outcome).toBe('bypass');
      // Follow-ups are never looked up — nothing could legally be served to them.
      expect(followUp.priorId).toBeNull();

      // A new visitor asks the follow-up's exact words as an opening question. The follow-up
      // row is the textually identical one, and must still NOT be the candidate.
      await ask(token, workspaceId, 'And what about after 30 days?', 'session-b');
      const opening = await shadowFor('And what about after 30 days?');
      expect(opening.priorId).not.toBe(followUp.id);
    },
    60000,
  );

  it(
    'a knowledge-base change removes every earlier answer from candidacy',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedPolicy(workspaceId);

      await ask(token, workspaceId, 'How do I reset my password?');
      await answerCache.bumpKnowledgeVersion(workspaceId);
      await ask(token, workspaceId, 'I forgot my password, what do I do?');

      // The earlier answer was grounded in the old knowledge base. A cache must not serve it,
      // so the shadow tier must not count it as something a cache could have served.
      expect((await shadowFor('I forgot my password, what do I do?')).priorId).toBeNull();
    },
    60000,
  );

  it(
    'never measures another workspace\'s conversations',
    async () => {
      const northwind = await register('anas@northwind.com', 'Northwind Devices');
      const acme = await register('sam@acme.com', 'Acme Corp');
      await seedPolicy(northwind.workspaceId);
      await seedPolicy(acme.workspaceId);

      await ask(northwind.token, northwind.workspaceId, 'How do I reset my password?');
      await ask(acme.token, acme.workspaceId, 'How do I reset my password?');

      // Identical text, but Acme's only possible candidates are Acme's own conversations.
      const acmeRow = await shadowFor('How do I reset my password?');
      expect(acmeRow.priorId).toBeNull();
    },
    60000,
  );

  it(
    'stores no embedding and runs no lookup on a cache hit, which embeds nothing',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedPolicy(workspaceId);

      await ask(token, workspaceId, 'How do I reset my password?');
      const hit = await ask(token, workspaceId, 'how do i reset my password');
      expect(hit.body.cache).toBe('hit');

      const rows = await dataSource.query(
        `SELECT cache_outcome, question_embedding IS NOT NULL AS "hasEmbedding", nearest_prior_conversation_id AS "priorId"
         FROM conversations ORDER BY id`,
      );
      expect(rows[0]).toMatchObject({ cache_outcome: 'miss', hasEmbedding: true });
      expect(rows[1]).toMatchObject({ cache_outcome: 'hit', hasEmbedding: false, priorId: null });
    },
    60000,
  );
});
