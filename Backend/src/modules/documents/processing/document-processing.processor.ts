import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Document } from '../../../database/entities/document.entity';
import { DocumentContent } from '../../../database/entities/document-content.entity';
import { DocumentChunk } from '../../../database/entities/document-chunk.entity';
import { DocumentStatus } from '../../../database/entities/document-status.enum';
import { DOCUMENT_PROCESSING_QUEUE, DocumentProcessingJobData } from './document-processing.constants';
import { STORAGE_ADAPTER, StorageAdapter } from '../storage/storage-adapter.interface';
import { extractText, isEffectivelyEmpty } from './extraction/extraction';
import { chunkText } from './chunking/chunking';

const EMPTY_TEXT_FAILURE_REASON =
  'No extractable text was found — the file may be a scan or image-only document.';

@Processor(DOCUMENT_PROCESSING_QUEUE, { concurrency: 5 })
export class DocumentProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentProcessingProcessor.name);

  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @InjectRepository(DocumentContent) private readonly documentContents: Repository<DocumentContent>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<DocumentProcessingJobData>): Promise<void> {
    const { documentId } = job.data;
    const document = await this.documents.findOne({ where: { id: documentId } });

    if (!document) {
      this.logger.warn(`Document ${documentId} no longer exists; skipping.`);
      return;
    }

    // Idempotency guard: a redelivered job (retry, stall recovery) must not redo work
    // a previous attempt already finished. Terminal states are left alone.
    if (document.status === DocumentStatus.READY || document.status === DocumentStatus.FAILED) {
      this.logger.log(`Document ${documentId} already "${document.status}"; skipping (idempotent no-op).`);
      return;
    }

    await this.documents.update(documentId, { status: DocumentStatus.PROCESSING });

    // A THROW_FOR_TESTING flag on the job data lets tests deliberately force a genuine
    // error, to exercise the retry/backoff/exhaustion path without needing real broken input.
    if ((job.data as DocumentProcessingJobData & { throwForTesting?: boolean }).throwForTesting) {
      throw new Error('Deliberate failure for testing retry/backoff behavior.');
    }

    const buffer = await this.storage.read(document.storageKey);
    const { text, pageCount } = await extractText(buffer, document.mimeType);

    if (isEffectivelyEmpty(text)) {
      // Deterministic, non-retryable outcome: this file will never produce text no matter
      // how many more attempts run, so we set failed directly rather than throwing — a
      // throw here would waste two more retries on the exact same guaranteed-empty result.
      await this.documents.update(documentId, {
        status: DocumentStatus.FAILED,
        failureReason: EMPTY_TEXT_FAILURE_REASON,
      });
      return;
    }

    // upsert (not insert) on the document_id conflict target: if a previous attempt already
    // wrote this row but crashed before the status update below, re-running lands on the
    // same final state instead of throwing a duplicate-key error on the UNIQUE constraint.
    await this.documentContents.upsert({ documentId, extractedText: text, pageCount }, ['documentId']);

    const chunks = chunkText(text);
    // Delete-then-insert, not upsert: a document can have a different NUMBER of chunks on
    // a re-run than it had before (a previous partial attempt, or an improved chunking
    // algorithm re-run later), so a per-row upsert alone could leave stale extra rows
    // behind. Both statements run in one transaction so a crash between them can never
    // leave a document with no chunks at all.
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(DocumentChunk, { documentId });
      await manager.insert(
        DocumentChunk,
        chunks.map((chunk, index) => ({
          documentId,
          chunkIndex: index,
          content: chunk.content,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        })),
      );
    });

    await this.documents.update(documentId, { status: DocumentStatus.READY });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<DocumentProcessingJobData> | undefined): Promise<void> {
    if (!job) {
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Not exhausted yet — BullMQ will retry this job after the configured backoff.
      return;
    }
    await this.documents.update(job.data.documentId, {
      status: DocumentStatus.FAILED,
      failureReason: job.failedReason ?? 'Processing failed after all retry attempts.',
    });
  }
}
