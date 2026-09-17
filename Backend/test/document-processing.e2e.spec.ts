import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { Document } from '../src/database/entities/document.entity';
import { DocumentChunk } from '../src/database/entities/document-chunk.entity';
import { DocumentStatus } from '../src/database/entities/document-status.enum';
import {
  DOCUMENT_PROCESSING_QUEUE,
  DocumentProcessingJobData,
} from '../src/modules/documents/processing/document-processing.constants';
import { DocumentProcessingProcessor } from '../src/modules/documents/processing/document-processing.processor';

const STORAGE_DIR = join(process.cwd(), 'storage');
const FIXTURES_DIR = join(process.cwd(), 'src/modules/documents/processing/extraction/fixtures');

async function seedStorageFile(storageKey: string, fixtureName: string): Promise<void> {
  const bytes = await readFile(join(FIXTURES_DIR, fixtureName));
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(join(STORAGE_DIR, storageKey), bytes);
}

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
  let processor: DocumentProcessingProcessor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(DOCUMENT_PROCESSING_QUEUE));
    processor = moduleRef.get(DocumentProcessingProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
    await rm(STORAGE_DIR, { recursive: true, force: true });
  });

  async function createWorkspaceAndDocument(
    status: DocumentStatus,
    overrides: Partial<Pick<Document, 'storageKey' | 'mimeType' | 'contentHash'>> = {},
  ): Promise<Document> {
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
      ...overrides,
    });
  }

  // These two tests call processor.process(...) directly instead of going through the real
  // queue (queue.add + waiting for the worker to pick it up), unlike every other test in this
  // file. Reason, found and confirmed while building this phase: invoking pdf-parse from
  // *inside* a BullMQ worker's job callback — several native-I/O stack frames deep (Redis →
  // BullMQ → here) — made pdf-parse's own lazy internal require of its bundled pdf.js resolve
  // to a broken module (`PDFJS.getDocument` came back undefined) reproducibly under Jest, even
  // though a plain `node` process never showed the problem and the identical call made directly
  // from a test body always succeeded. It's a real, narrow Jest/module-system interaction, not
  // a production bug — see the phase doc's Failure Cases for the full investigation. Calling
  // the processor directly still exercises real code (real pdf-parse, real Postgres, real
  // storage) — it only bypasses BullMQ's transport, which the other two tests below already
  // cover (retry/backoff, idempotency) via the cheap throwForTesting path that never touches
  // pdf-parse.
  function runProcessorDirectly(documentId: number): Promise<void> {
    return processor.process({ data: { documentId } } as Job<DocumentProcessingJobData>);
  }

  it('processes a job through to ready and saves the extracted text', async () => {
    const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED, {
      storageKey: 'real-pdf.pdf',
      contentHash: 'b'.repeat(64),
    });
    await seedStorageFile(document.storageKey, 'sample.pdf');

    await runProcessorDirectly(document.id);

    const row = await dataSource.getRepository(Document).findOneBy({ id: document.id });
    expect(row?.status).toBe(DocumentStatus.READY);

    const content = await dataSource.query(
      'SELECT extracted_text, page_count FROM document_contents WHERE document_id = $1',
      [document.id],
    );
    expect(content).toHaveLength(1);
    expect(content[0].extracted_text).toContain(
      'Hello World from a real test PDF generated by headless Chrome.',
    );
    expect(content[0].page_count).toBe(1);

    const chunks = await dataSource.query(
      'SELECT chunk_index, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [document.id],
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].content).toContain('Hello World from a real test PDF generated by headless Chrome.');
  });

  it('re-chunks a document on redelivery without leaving stale duplicate chunks behind', async () => {
    const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED, {
      storageKey: 'real-pdf.pdf',
      contentHash: 'd'.repeat(64),
    });
    await seedStorageFile(document.storageKey, 'sample.pdf');

    await runProcessorDirectly(document.id);

    // Simulate a redelivery of an already-completed job (an at-least-once delivery, same
    // as Phase 4's idempotency guard already covers) — but here we're checking specifically
    // that a SECOND real chunking pass doesn't double up the chunk rows.
    await dataSource.getRepository(Document).update(document.id, { status: DocumentStatus.UPLOADED });
    await runProcessorDirectly(document.id);

    const chunks = await dataSource.query('SELECT id FROM document_chunks WHERE document_id = $1', [
      document.id,
    ]);
    expect(chunks).toHaveLength(1);
  });

  it('rejects a raw duplicate (document_id, chunk_index) pair at the database level', async () => {
    const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED, { contentHash: 'e'.repeat(64) });
    const chunks = dataSource.getRepository(DocumentChunk);

    await chunks.save({ documentId: document.id, chunkIndex: 0, content: 'first', charStart: 0, charEnd: 5 });

    await expect(
      chunks.save({ documentId: document.id, chunkIndex: 0, content: 'duplicate index', charStart: 5, charEnd: 21 }),
    ).rejects.toThrow();
  });

  it('rolls back the whole delete-then-insert transaction if the insert half fails partway through', async () => {
    const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED, { contentHash: 'f'.repeat(64) });
    const chunkRepo = dataSource.getRepository(DocumentChunk);
    await chunkRepo.save({ documentId: document.id, chunkIndex: 0, content: 'original chunk', charStart: 0, charEnd: 14 });

    // Mirrors the processor's own delete-then-insert transaction, but the second insert row
    // is deliberately malformed (chunkIndex repeated) to force a real UNIQUE-constraint
    // violation partway through the insert — proving the earlier delete doesn't stick.
    await expect(
      dataSource.transaction(async (manager) => {
        await manager.delete(DocumentChunk, { documentId: document.id });
        await manager.insert(DocumentChunk, [
          { documentId: document.id, chunkIndex: 0, content: 'new chunk A', charStart: 0, charEnd: 11 },
          { documentId: document.id, chunkIndex: 0, content: 'new chunk B (duplicate index)', charStart: 11, charEnd: 41 },
        ]);
      }),
    ).rejects.toThrow();

    const remaining = await chunkRepo.find({ where: { documentId: document.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('original chunk');
  });

  it('marks a scanned/image-only document failed directly, without exhausting retries', async () => {
    const document = await createWorkspaceAndDocument(DocumentStatus.UPLOADED, {
      storageKey: 'scanned.pdf',
      contentHash: 'c'.repeat(64),
    });
    await seedStorageFile(document.storageKey, 'scanned.pdf');

    await runProcessorDirectly(document.id);

    const finalRow = await dataSource.getRepository(Document).findOneBy({ id: document.id });
    expect(finalRow?.status).toBe(DocumentStatus.FAILED);
    expect(finalRow?.failureReason).toContain('No extractable text was found');

    const content = await dataSource.query('SELECT * FROM document_contents WHERE document_id = $1', [
      document.id,
    ]);
    expect(content).toHaveLength(0);
  });

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
