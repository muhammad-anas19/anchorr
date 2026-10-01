import { AnswerCacheService } from '../../../../cache/answer-cache.service';
import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Document } from '../../../../database/entities/document.entity';
import { DocumentChunk } from '../../../../database/entities/document-chunk.entity';
import { DocumentStatus } from '../../../../database/entities/document-status.enum';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../../../../embedding/embedding-provider.interface';
import { DOCUMENT_EMBEDDING_QUEUE, DocumentEmbeddingJobData } from './document-embedding.constants';
import { EMBEDDING_MODEL } from '../../../../embedding/gemini-embedding.provider';
import { UsageMeter } from '../../../../metering/usage-meter.service';

@Processor(DOCUMENT_EMBEDDING_QUEUE, { concurrency: 5 })
export class DocumentEmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentEmbeddingProcessor.name);

  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @InjectRepository(DocumentChunk) private readonly chunks: Repository<DocumentChunk>,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
    private readonly answerCache: AnswerCacheService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly meter: UsageMeter,
  ) {
    super();
  }

  async process(job: Job<DocumentEmbeddingJobData>): Promise<void> {
    const { documentId } = job.data;
    const document = await this.documents.findOne({ where: { id: documentId } });

    if (!document) {
      this.logger.warn(`Document ${documentId} no longer exists; skipping.`);
      return;
    }

    // Same idempotency guard shape as Phase 5/6's processor — a redelivered job for an
    // already-finished document is a safe no-op.
    if (document.status === DocumentStatus.READY || document.status === DocumentStatus.FAILED) {
      this.logger.log(`Document ${documentId} already "${document.status}"; skipping (idempotent no-op).`);
      return;
    }

    // Only the chunks still missing an embedding — a redelivered job (retry, stall
    // recovery) must not re-pay for chunks a previous attempt already embedded successfully.
    const pendingChunks = await this.chunks.find({
      where: { documentId },
      order: { chunkIndex: 'ASC' },
    });
    const total = pendingChunks.length;
    const alreadyDone = pendingChunks.filter((c) => c.embedding).length;

    await job.updateProgress({ stage: 'embedding', completed: alreadyDone, total });

    let completed = alreadyDone;
    for (const chunk of pendingChunks) {
      if (chunk.embedding) {
        continue;
      }
      const embedding = await this.embeddingProvider.embed(chunk.content);
      await this.saveAndMeter(document.workspaceId, documentId, chunk, embedding);
      completed += 1;
      await job.updateProgress({ stage: 'embedding', completed, total });
    }

    // Only reached once every chunk in the loop above succeeded — a thrown error from
    // embeddingProvider.embed() propagates out of process() and fails the whole job,
    // leaving status at 'processing' so a retry picks up exactly where this attempt left off.
    // now(), not `new Date()`: these are `timestamp without time zone` columns and the pg
    // driver writes a JS Date as the HOST's local wall clock, while every other timestamp in
    // this table (created_at) comes from Postgres in UTC. Mixing the two put readyAt five
    // hours ahead of createdAt for the same document — visible in the "Last indexed" column
    // as a time in the future.
    await this.documents.update(documentId, { status: DocumentStatus.READY, readyAt: () => 'now()' });
    // Every chunk is now visible to vector search too. Any answer cached while this document
    // was half-indexed (keyword-visible, vector-invisible) was grounded in an incomplete
    // knowledge base and must not outlive this moment.
    await this.answerCache.bumpKnowledgeVersion(document.workspaceId);
  }

  // One chunk's embedding and its usage event, in one transaction — the same guarantee the
  // answer path has: a chunk is never embedded without being metered, or metered without
  // being embedded.
  //
  // Two layers stop a double charge when a job runs twice (a retry, or BullMQ's stall
  // detection handing a still-running job to a second worker, Phase 4):
  //   - the UPDATE only fills an embedding that is still NULL, and reports whether it did;
  //   - the event's key is the chunk id, so even a second insert is a no-op.
  // The chunk id is the right unit on purpose: reprocessing a document replaces its chunks
  // with NEW ids (Phase 6's delete-then-insert), so a genuine re-embed is billed again while a
  // retried job for the same chunks is not.
  //
  // What it cannot stop: two workers racing on one chunk both CALL Gemini before either
  // commits. We pay twice; the customer is charged once.
  private async saveAndMeter(workspaceId: number, documentId: number, chunk: DocumentChunk, embedding: number[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [, filled] = await manager.query(
        `UPDATE document_chunks SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL`,
        [`[${embedding.join(',')}]`, chunk.id],
      );
      if (filled === 0) return; // another run got here first — and metered it

      await this.meter.record(manager, {
        workspaceId,
        metric: 'chunk_embedded',
        quantity: 1,
        billable: true,
        idempotencyKey: `chunk:${chunk.id}`,
        documentId,
        attributes: { chunkId: chunk.id, characters: chunk.content.length, model: EMBEDDING_MODEL },
      });
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<DocumentEmbeddingJobData> | undefined): Promise<void> {
    if (!job) {
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }
    await this.documents.update(job.data.documentId, {
      status: DocumentStatus.FAILED,
      failureReason: job.failedReason ?? 'Embedding failed after all retry attempts.',
    });
  }
}
