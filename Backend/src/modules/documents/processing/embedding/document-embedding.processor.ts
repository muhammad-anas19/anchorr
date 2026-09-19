import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Document } from '../../../../database/entities/document.entity';
import { DocumentChunk } from '../../../../database/entities/document-chunk.entity';
import { DocumentStatus } from '../../../../database/entities/document-status.enum';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../../../../embedding/embedding-provider.interface';
import { DOCUMENT_EMBEDDING_QUEUE, DocumentEmbeddingJobData } from './document-embedding.constants';

@Processor(DOCUMENT_EMBEDDING_QUEUE, { concurrency: 5 })
export class DocumentEmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentEmbeddingProcessor.name);

  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @InjectRepository(DocumentChunk) private readonly chunks: Repository<DocumentChunk>,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
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

    for (const chunk of pendingChunks) {
      if (chunk.embedding) {
        continue;
      }
      const embedding = await this.embeddingProvider.embed(chunk.content);
      await this.chunks.update(chunk.id, { embedding });
    }

    // Only reached once every chunk in the loop above succeeded — a thrown error from
    // embeddingProvider.embed() propagates out of process() and fails the whole job,
    // leaving status at 'processing' so a retry picks up exactly where this attempt left off.
    await this.documents.update(documentId, { status: DocumentStatus.READY });
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
