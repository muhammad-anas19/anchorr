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

describe('DocumentEmbeddingProcessor', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let documents: Repository<Document>;
  let chunks: Repository<DocumentChunk>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    documents = dataSource.getRepository(Document);
    chunks = dataSource.getRepository(DocumentChunk);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
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
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider);

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
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider);

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
      const processor = new DocumentEmbeddingProcessor(documents, chunks, provider);

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
    const processor = new DocumentEmbeddingProcessor(documents, chunks, provider);

    await processor.process({ data: { documentId: document.id }, updateProgress: async () => {} } as unknown as Job<DocumentEmbeddingJobData>);

    expect(calls).toBe(0);
  });
});
