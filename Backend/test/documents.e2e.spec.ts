import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { rm, readdir } from 'fs/promises';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';

const STORAGE_DIR = join(process.cwd(), 'storage');
const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake pdf content for testing')]);
const FAKE_PDF_2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('a different fake pdf')]);
const DISGUISED_FILE = Buffer.from('just plain text, not a real pdf at all');

describe('Documents (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
    await rm(STORAGE_DIR, { recursive: true, force: true });
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
