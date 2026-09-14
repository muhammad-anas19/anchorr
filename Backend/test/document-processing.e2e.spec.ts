import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { rm } from 'fs/promises';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { Document } from '../src/database/entities/document.entity';
import { DocumentStatus } from '../src/database/entities/document-status.enum';
import {
  DOCUMENT_PROCESSING_QUEUE,
  DocumentProcessingJobData,
} from '../src/modules/documents/processing/document-processing.constants';

const STORAGE_DIR = join(process.cwd(), 'storage');

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Document processing queue (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let queue: Queue<DocumentProcessingJobData & { throwForTesting?: boolean }>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(DOCUMENT_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
    await rm(STORAGE_DIR, { recursive: true, force: true });
  });

  async function createWorkspaceAndDocument(status: DocumentStatus): Promise<Document> {
    await dataSource.query(`INSERT INTO workspaces (name) VALUES ('Test Workspace')`);
    await dataSource.query(
      `INSERT INTO users (email, password_hash) VALUES ('anas@northwind.com', 'unused-in-this-test')`,
    );
    return dataSource.getRepository(Document).save({
      workspaceId: 1,
      uploadedByUserId: 1,
      originalFilename: 'report.pdf',
      storageKey: 'test-key-does-not-need-to-exist-on-disk',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      contentHash: 'a'.repeat(64),
      status,
    });
  }

  it(
    'processes a job through to ready',
    async () => {
      const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED);

      await queue.add('process', { documentId: document.id });

      await waitUntil(async () => {
        const row = await dataSource.getRepository(Document).findOneBy({ id: document.id });
        return row?.status === DocumentStatus.READY;
      }, 5000);
    },
    10000,
  );

  it(
    'retries with backoff on failure, then marks the document failed once attempts are exhausted',
    async () => {
      const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED);

      await queue.add(
        'process',
        { documentId: document.id, throwForTesting: true },
        { attempts: 3, backoff: { type: 'exponential', delay: 200 } },
      );

      // 3 attempts with exponential backoff starting at 200ms (200ms, then 400ms) should
      // exhaust well within 8s, including the trivial processing time itself.
      await waitUntil(async () => {
        const row = await dataSource.getRepository(Document).findOneBy({ id: document.id });
        return row?.status === DocumentStatus.FAILED;
      }, 8000);

      const finalRow = await dataSource.getRepository(Document).findOneBy({ id: document.id });
      expect(finalRow?.failureReason).toContain('Deliberate failure for testing');
    },
    10000,
  );

  it(
    'is idempotent: reprocessing an already-ready document is a safe no-op',
    async () => {
      const document = await createWorkspaceAndDocument(DocumentStatus.READY);

      // Simulates an at-least-once redelivery of a job whose first attempt already succeeded.
      await queue.add('process', { documentId: document.id });

      // Give the (idempotent no-op) handler time to run, then confirm nothing changed.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const row = await dataSource.getRepository(Document).findOneBy({ id: document.id });
      expect(row?.status).toBe(DocumentStatus.READY);
      expect(row?.failureReason).toBeNull();
    },
    10000,
  );
});
