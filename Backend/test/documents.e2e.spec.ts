import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { rm, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { EMBEDDING_PROVIDER } from '../src/embedding/embedding-provider.interface';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DOCUMENT_PROCESSING_QUEUE } from '../src/modules/documents/processing/document-processing.constants';
import { DOCUMENT_EMBEDDING_QUEUE } from '../src/modules/documents/processing/embedding/document-embedding.constants';

const STORAGE_DIR = join(process.cwd(), 'storage');
const FIXTURES_DIR = join(process.cwd(), 'src/modules/documents/processing/extraction/fixtures');
const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake pdf content for testing')]);
const FAKE_PDF_2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('a different fake pdf')]);
const DISGUISED_FILE = Buffer.from('just plain text, not a real pdf at all');

describe('Documents (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let processingQueue: Queue;
  let embeddingQueue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    processingQueue = moduleRef.get(getQueueToken(DOCUMENT_PROCESSING_QUEUE));
    embeddingQueue = moduleRef.get(getQueueToken(DOCUMENT_EMBEDDING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
    await rm(STORAGE_DIR, { recursive: true, force: true });
    // Redis has to be reset for the same reason Postgres is, and it is easy to forget because
    // only Postgres is visible in the line above. TRUNCATE ... RESTART IDENTITY sends document
    // ids back to 1 every test, while BullMQ's job history persists — so a leftover job from an
    // earlier test still matches `data.documentId === 1` and gets reported as the live job for
    // a completely different document. Obliterating the two document queues (rather than a
    // blanket FLUSHALL) keeps this scoped to what this suite actually enqueues.
    await processingQueue.obliterate({ force: true });
    await embeddingQueue.obliterate({ force: true });
  });

  async function registerOwner() {
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });
    return res.body.accessToken as string;
  }

  it('uploads a valid PDF, storing it under a generated key with the sniffed mime type', async () => {
    const token = await registerOwner();

    const res = await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF, 'report.pdf')
      .expect(201);

    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.originalFilename).toBe('report.pdf');
    expect(res.body.status).toBe('uploaded');
    expect(res.body.storageKey).not.toBe('report.pdf');

    const filesOnDisk = await readdir(STORAGE_DIR);
    expect(filesOnDisk).toEqual([res.body.storageKey]);
  });

  it('rejects a file whose content does not match its claimed type, regardless of filename/extension', async () => {
    const token = await registerOwner();

    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', DISGUISED_FILE, 'totally-a-real.pdf')
      .expect(422);
  });

  it('rejects a duplicate upload of the same content, even under a different filename', async () => {
    const token = await registerOwner();

    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF, 'first-name.pdf')
      .expect(201);

    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF, 'completely-different-name.pdf')
      .expect(409);

    // A genuinely different file's content must still be accepted.
    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF_2, 'second-name.pdf')
      .expect(201);
  });

  it('handles two truly concurrent uploads of the same content — exactly one wins, no orphaned file', async () => {
    const token = await registerOwner();

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/workspaces/1/documents')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', FAKE_PDF, 'race-a.pdf'),
      request(app.getHttpServer())
        .post('/workspaces/1/documents')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', FAKE_PDF, 'race-b.pdf'),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await dataSource.query('SELECT * FROM documents');
    expect(rows).toHaveLength(1);

    const filesOnDisk = await readdir(STORAGE_DIR);
    expect(filesOnDisk).toHaveLength(1);
  });

  it('lists and fetches documents scoped to the workspace, and deletes both the row and the stored file', async () => {
    const token = await registerOwner();

    const uploadRes = await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF, 'report.pdf')
      .expect(201);
    const documentId = uploadRes.body.id;

    const listRes = await request(app.getHttpServer())
      .get('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listRes.body).toHaveLength(1);

    await request(app.getHttpServer())
      .get(`/workspaces/1/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/workspaces/1/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/workspaces/1/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    const filesOnDisk = await readdir(STORAGE_DIR).catch(() => []);
    expect(filesOnDisk).toHaveLength(0);
  });

  it('blocks a viewer from uploading or deleting, but still lets them list', async () => {
    const ownerToken = await registerOwner();

    const uploadRes = await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('file', FAKE_PDF, 'report.pdf')
      .expect(201);

    const viewerUser = await dataSource.getRepository(User).save({
      email: 'viewer@northwind.com',
      passwordHash: 'unused-in-this-test',
    });
    await dataSource.getRepository(Membership).save({
      workspaceId: 1,
      userId: viewerUser.id,
      role: MembershipRole.VIEWER,
    });
    const viewerToken = jwt.sign({ sub: viewerUser.id }, process.env.JWT_SECRET!, { expiresIn: '15m' });

    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${viewerToken}`)
      .attach('file', FAKE_PDF_2, 'other.pdf')
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/workspaces/1/documents/${uploadRes.body.id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/workspaces/1/documents')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
  });

  it(
    'list and detail responses carry a real chunk count and the uploader\'s own email',
    async () => {
      const token = await registerOwner();

      const uploadRes = await request(app.getHttpServer())
        .post('/workspaces/1/documents')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', FAKE_PDF, 'report.pdf')
        .expect(201);
      const documentId = uploadRes.body.id;

      // Checked immediately after upload, before the real background worker has any chance
      // to create chunks — chunkCount should be a real, honest 0, not undefined or omitted.
      const listRes = await request(app.getHttpServer())
        .get('/workspaces/1/documents')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(listRes.body[0]).toMatchObject({ chunkCount: 0, uploadedByEmail: 'anas@northwind.com' });

      const detailRes = await request(app.getHttpServer())
        .get(`/workspaces/1/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detailRes.body).toMatchObject({ chunkCount: 0, uploadedByEmail: 'anas@northwind.com' });
    },
    15000,
  );

  it(
    'the progress endpoint reflects a real, currently-running embedding job, then returns null once nothing is live',
    async () => {
      // A deliberately slow, controllable embedding provider — real enough to genuinely run
      // the pipeline, slow enough to have time to observe the live 'embedding' stage before
      // it finishes, matching this project's own established pattern for these scenarios.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue({
          embed: async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return Array.from({ length: 768 }, (_, i) => i / 1000);
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();
      const isolatedDataSource = moduleRef.get(DataSource);

      const registerRes = await request(isolatedApp.getHttpServer()).post('/auth/register').send({
        email: 'anas@northwind.com',
        password: 'correct-horse-battery',
        workspaceName: 'Northwind Devices',
      });
      const token = registerRes.body.accessToken as string;

      const pdfBuffer = await readFile(join(FIXTURES_DIR, 'sample.pdf'));
      const uploadRes = await request(isolatedApp.getHttpServer())
        .post('/workspaces/1/documents')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', pdfBuffer, 'sample.pdf')
        .expect(201);
      const documentId = uploadRes.body.id;

      // Poll until a live 'embedding' stage actually shows up — real background timing,
      // not a fixed sleep, since exactly when the worker picks the job up isn't guaranteed.
      let progress: { stage?: string } | null = null;
      for (let attempt = 0; attempt < 150; attempt++) {
        const res = await request(isolatedApp.getHttpServer())
          .get(`/workspaces/1/documents/${documentId}/progress`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        progress = res.body;
        if (progress?.stage === 'embedding') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(progress?.stage).toBe('embedding');

      // Wait for the document to actually finish, then confirm progress genuinely goes back
      // to null — there's no live job left to report on once processing is truly done.
      let finalStatus: string | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        const [row] = await isolatedDataSource.query('SELECT status FROM documents WHERE id = $1', [documentId]);
        finalStatus = row?.status;
        if (finalStatus === 'ready' || finalStatus === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(finalStatus).toBe('ready');

      // A `null` controller return serializes as a genuinely empty body (0 bytes), not the
      // text "null" — supertest's own convention parses an empty body as `{}`, not `null`,
      // which is what this asserts on; the real Frontend's fetch-based client already treats
      // an empty body as `undefined` correctly (shared/api/client.ts), so this is purely
      // about matching supertest's parsing convention, not a real behavior difference.
      const finalProgress = await request(isolatedApp.getHttpServer())
        .get(`/workspaces/1/documents/${documentId}/progress`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(finalProgress.text).toBe('');

      await isolatedApp.close();
    },
    60000,
  );

  it('rejects a file larger than the configured limit before it is fully accepted', async () => {
    const token = await registerOwner();
    const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(51 * 1024 * 1024, 'a')]);

    await request(app.getHttpServer())
      .post('/workspaces/1/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', oversized, 'huge.pdf')
      .expect(413);
  }, 20000);
});
