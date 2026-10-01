import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../../../app.module';
import { Document } from '../../../../database/entities/document.entity';
import { DocumentChunk } from '../../../../database/entities/document-chunk.entity';
import { DocumentStatus } from '../../../../database/entities/document-status.enum';
import { DocumentEmbeddingProcessor } from './document-embedding.processor';
import { EmbeddingProvider } from '../../../../embedding/embedding-provider.interface';
import { Job } from 'bullmq';
import { DocumentEmbeddingJobData } from './document-embedding.constants';
import { AnswerCacheService } from '../../../../cache/answer-cache.service';
import { UsageMeter } from '../../../../metering/usage-meter.service';
import { resetDatabase } from '../../../../../test/helpers/reset-database';

describe('DocumentEmbeddingProcessor', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let documents: Repository<Document>;
  let chunks: Repository<DocumentChunk>;
  let answerCache: AnswerCacheService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    documents = dataSource.getRepository(Document);
    chunks = dataSource.getRepository(DocumentChunk);
    answerCache = moduleRef.get(AnswerCacheService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  async function createDocumentWithChunks(chunkCount: number): Promise<Document> {
    await dataSource.query(
      `INSERT INTO workspaces (name, public_key) VALUES ('Test Workspace', gen_random_uuid())`,
    );
    const document = await documents.save({
      workspaceId: 1,
      originalFilename: 'report.pdf',
      storageKey: 'unused',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      contentHash: 'a'.repeat(64),
      status: DocumentStatus.PROCESSING,
    });
    for (let i = 0; i < chunkCount; i++) {
      await chunks.save({
        documentId: document.id,
        chunkIndex: i,
        content: `chunk number ${i}`,
        charStart: 0,
        charEnd: 10,
      });
    }
    return document;
  }

  function fakeVector(seed: number): number[] {
    return Array.from({ length: 768 }, (_, i) => (i + seed) / 1000);
  }

  it('embeds every chunk and flips the document to ready', async () => {
    const document = await createDocumentWithChunks(3);
    let calls = 0;
    const provider: EmbeddingProvider = {
      embed: async () => fakeVector(calls++),
    };
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider, answerCache, dataSource, new UsageMeter());

    await processor.process({ data: { documentId: document.id }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>);

    expect(calls).toBe(3);
    const finalDoc = await documents.findOneBy({ id: document.id });
    expect(finalDoc?.status).toBe(DocumentStatus.READY);
    const savedChunks = await chunks.find({ where: { documentId: document.id }, order: { chunkIndex: 'ASC' } });
    for (const chunk of savedChunks) {
      expect(chunk.embedding).toHaveLength(768);
    }
  });

  it('skips chunks that already have an embedding on a redelivered job', async () => {
    const document = await createDocumentWithChunks(3);
    await chunks.update({ documentId: document.id, chunkIndex: 0 }, { embedding: fakeVector(999) });

    let calls = 0;
    const provider: EmbeddingProvider = {
      embed: async () => fakeVector(calls++),
    };
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider, answerCache, dataSource, new UsageMeter());

    await processor.process({ data: { documentId: document.id }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>);

    // Only the 2 chunks that didn't already have an embedding should have triggered a call —
    // proving a retry doesn't re-pay for chunks a previous attempt already embedded.
    expect(calls).toBe(2);
    const chunk0 = await chunks.findOneBy({ documentId: document.id, chunkIndex: 0 });
    expect(chunk0?.embedding?.[0]).toBeCloseTo(999 / 1000);
  });

  it(
    'leaves earlier successfully-embedded chunks in place and the document in "processing" ' +
      'when a later chunk fails',
    async () => {
      const document = await createDocumentWithChunks(3);
      let calls = 0;
      const provider: EmbeddingProvider = {
        embed: async () => {
          calls++;
          if (calls === 2) {
            throw new Error('Simulated Gemini API failure on the second chunk.');
          }
          return fakeVector(calls);
        },
      };
      const processor = new DocumentEmbeddingProcessor(documents, chunks, provider, answerCache, dataSource, new UsageMeter());

      await expect(
        processor.process({ data: { documentId: document.id }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>),
      ).rejects.toThrow('Simulated Gemini API failure');

      const finalDoc = await documents.findOneBy({ id: document.id });
      expect(finalDoc?.status).toBe(DocumentStatus.PROCESSING);

      const chunk0 = await chunks.findOneBy({ documentId: document.id, chunkIndex: 0 });
      const chunk1 = await chunks.findOneBy({ documentId: document.id, chunkIndex: 1 });
      const chunk2 = await chunks.findOneBy({ documentId: document.id, chunkIndex: 2 });
      expect(chunk0?.embedding).toHaveLength(768);
      expect(chunk1?.embedding).toBeNull();
      expect(chunk2?.embedding).toBeNull();
    },
  );

  it('is idempotent: does nothing for an already-ready document', async () => {
    const document = await createDocumentWithChunks(1);
    await documents.update(document.id, { status: DocumentStatus.READY });
    let calls = 0;
    const provider: EmbeddingProvider = { embed: async () => { calls++; return fakeVector(0); } };
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider, answerCache, dataSource, new UsageMeter());

    await processor.process({ data: { documentId: document.id }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>);

    expect(calls).toBe(0);
  });

  describe('usage metering', () => {
    const run = (processor: DocumentEmbeddingProcessor, documentId: number) =>
      processor.process({ data: { documentId }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>);
    const usage = () =>
      dataSource.query(
        `SELECT metric, billable, idempotency_key AS key, document_id AS "documentId", attributes
         FROM usage_events ORDER BY id`,
      );

    it('records one billable chunk_embedded event per chunk, keyed by chunk id', async () => {
      const document = await createDocumentWithChunks(3);
      let calls = 0;
      const processor = new DocumentEmbeddingProcessor(
        documents, chunks, { embed: async () => fakeVector(calls++) }, answerCache, dataSource, new UsageMeter(),
      );
      await run(processor, document.id);

      const ids = (await chunks.find({ where: { documentId: document.id }, order: { chunkIndex: 'ASC' } })).map((c) => c.id);
      expect(await usage()).toEqual(
        ids.map((id) => ({
          metric: 'chunk_embedded',
          billable: true,
          key: `chunk:${id}`,
          documentId: document.id,
          attributes: { chunkId: id, characters: 'chunk number 0'.length, model: 'gemini-embedding-001' },
        })),
      );
    });

    // A failure part-way, then the retry: the chunks the first attempt finished were metered
    // in the same transaction as their embedding, so the retry skips them and meters only
    // the rest. Total: exactly one event per chunk.
    it('meters each chunk exactly once across a failed attempt and its retry', async () => {
      const document = await createDocumentWithChunks(3);
      let calls = 0;
      const flaky = new DocumentEmbeddingProcessor(
        documents,
        chunks,
        {
          embed: async () => {
            calls++;
            if (calls === 2) throw new Error('Simulated Gemini failure');
            return fakeVector(calls);
          },
        },
        answerCache,
        dataSource,
        new UsageMeter(),
      );
      await expect(run(flaky, document.id)).rejects.toThrow('Simulated Gemini failure');
      expect(await usage()).toHaveLength(1);

      await run(flaky, document.id); // the retry
      const events = await usage();
      expect(events).toHaveLength(3);
      expect(new Set(events.map((e: { key: string }) => e.key)).size).toBe(3);
    });

    // BullMQ's stall detection can hand a still-running job to a second worker (Phase 4).
    // Both embed the same chunks; the conditional UPDATE lets only one fill each chunk, and
    // only that one meters it. Gemini is paid twice — the customer is charged once.
    it('charges once when two workers run the same job concurrently', async () => {
      const document = await createDocumentWithChunks(3);
      let calls = 0;
      const slow = { embed: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return fakeVector(calls); } };
      const a = new DocumentEmbeddingProcessor(documents, chunks, slow, answerCache, dataSource, new UsageMeter());
      const b = new DocumentEmbeddingProcessor(documents, chunks, slow, answerCache, dataSource, new UsageMeter());

      await Promise.all([run(a, document.id), run(b, document.id)]);

      expect(calls).toBe(6); // both really called the provider
      expect(await usage()).toHaveLength(3); // but each chunk was charged once
    });

    // Reprocessing replaces a document's chunks with new rows (Phase 6's delete-then-insert),
    // so they have new ids and new keys: a genuine re-embed IS billed again.
    it('bills a reprocessed document again, because its chunks are new', async () => {
      const document = await createDocumentWithChunks(2);
      let calls = 0;
      const processor = new DocumentEmbeddingProcessor(
        documents, chunks, { embed: async () => fakeVector(calls++) }, answerCache, dataSource, new UsageMeter(),
      );
      await run(processor, document.id);

      await chunks.delete({ documentId: document.id });
      for (let i = 0; i < 2; i++) {
        await chunks.save({ documentId: document.id, chunkIndex: i, content: `new chunk ${i}`, charStart: 0, charEnd: 10 });
      }
      await documents.update(document.id, { status: DocumentStatus.PROCESSING });
      await run(processor, document.id);

      expect(await usage()).toHaveLength(4);
    });
  });
});
