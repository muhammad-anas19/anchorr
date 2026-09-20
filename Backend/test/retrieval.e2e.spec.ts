import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';

describe('Retrieval (e2e)', () => {
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

  async function seedEmbeddedChunk(workspaceId: number, documentSuffix: string, content: string): Promise<void> {
    const doc = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, $2, $3, 'application/pdf', 10, $4, 'processing') RETURNING id`,
      [workspaceId, `${documentSuffix}.pdf`, `key-${documentSuffix}-${workspaceId}`, documentSuffix.repeat(8).slice(0, 64).padEnd(64, '0')],
    );
    const embedding = await embeddingProvider.embed(content);
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, $2, 0, $3, $4::vector)`,
      [doc[0].id, content, content.length, `[${embedding.join(',')}]`],
    );
  }

  it(
    'retrieves the most semantically relevant chunk for the caller\'s workspace, ranked by distance',
    async () => {
      const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'refunds', 'Refunds are available within 30 days of purchase.');
      await seedEmbeddedChunk(workspaceId, 'shipping', 'Our warehouse ships orders Monday through Friday.');

      const res = await request(app.getHttpServer())
        .post(`/workspaces/${workspaceId}/retrieve`)
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'How do I get my money back?', k: 2 })
        .expect(201);

      expect(res.body).toHaveLength(2);
      expect(res.body[0].content).toContain('Refunds are available');
      expect(res.body[0].distance).toBeLessThan(res.body[1].distance);
      expect(res.body[0]).toHaveProperty('originalFilename', 'refunds.pdf');
      expect(res.body[0]).toHaveProperty('chunkIndex', 0);
    },
    20000,
  );

  it(
    'never returns chunks from a different workspace',
    async () => {
      const northwind = await register('anas@northwind.com', 'Northwind Devices');
      const acme = await register('sam@acme.com', 'Acme Corp');

      await seedEmbeddedChunk(
        acme.workspaceId,
        'acme-refunds',
        'Acme refunds are available within 30 days of purchase.',
      );

      const res = await request(app.getHttpServer())
        .post(`/workspaces/${northwind.workspaceId}/retrieve`)
        .set('Authorization', `Bearer ${northwind.token}`)
        .send({ query: 'How do I get my money back?', k: 5 })
        .expect(201);

      // Northwind has no chunks of its own and Acme's chunk must never surface here,
      // regardless of how semantically relevant it would otherwise be.
      expect(res.body).toHaveLength(0);
    },
    20000,
  );

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .post('/workspaces/1/retrieve')
      .send({ query: 'anything' })
      .expect(401);
  });

  it('rejects a request from a user with no membership in the target workspace', async () => {
    const northwind = await register('anas@northwind.com', 'Northwind Devices');
    const acme = await register('sam@acme.com', 'Acme Corp');

    await request(app.getHttpServer())
      .post(`/workspaces/${acme.workspaceId}/retrieve`)
      .set('Authorization', `Bearer ${northwind.token}`)
      .send({ query: 'anything' })
      .expect(403);
  });

  it('rejects an empty query', async () => {
    const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');

    await request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/retrieve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ query: '' })
      .expect(400);
  });
});
