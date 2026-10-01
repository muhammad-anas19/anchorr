import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { ASK_LIMIT } from '../src/common/guards/ask-rate-limit.guard';
import { resetDatabase } from './helpers/reset-database';

const DIM = 768;
const unit = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

describe('/ask rate limiting (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue({ embed: async () => unit(0) })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({ generate: async () => ({ text: 'Five to seven days [1].', promptTokens: 10, totalTokens: 20 }) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // Workspace ids restart at 1 every test while Redis persists — the bucket is keyed by id.
    await redis.del('ask:1');
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'owner@northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind' });
    token = res.body.accessToken;
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
  });

  const ask = (i: number) =>
    request(app.getHttpServer())
      .post('/workspaces/1/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: `Question ${i}` });

  it('sends RateLimit headers on every response, counting down', async () => {
    const first = await ask(0).expect(201);
    const second = await ask(1).expect(201);

    expect(first.headers['ratelimit-limit']).toBe(String(ASK_LIMIT.capacity));
    expect(first.headers['ratelimit-remaining']).toBe(String(ASK_LIMIT.capacity - 1));
    expect(second.headers['ratelimit-remaining']).toBe(String(ASK_LIMIT.capacity - 2));
    expect(first.headers['retry-after']).toBeUndefined();
  });

  it('refuses the request after the burst with 429, Retry-After and the headers — and charges nothing for it', async () => {
    for (let i = 0; i < ASK_LIMIT.capacity; i++) await ask(i).expect(201);

    const refused = await ask(99).expect(429);
    expect(refused.body.error).toBe('rate_limited');
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    // One token at 20/min is ~3 s away.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(3);

    // The limit runs before AnswerService: no conversation, no usage event, no quota unit.
    const [{ used }] = await dataSource.query(`SELECT used FROM workspace_quotas WHERE workspace_id = 1`);
    expect(used).toBe(ASK_LIMIT.capacity);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM conversations`);
    expect(n).toBe(ASK_LIMIT.capacity);
  });

  it('does not limit /ask/config, which reads settings rather than spending the budget', async () => {
    for (let i = 0; i < ASK_LIMIT.capacity; i++) await ask(i).expect(201);
    await request(app.getHttpServer()).get('/workspaces/1/ask/config').set('Authorization', `Bearer ${token}`).expect(200);
  });
});
