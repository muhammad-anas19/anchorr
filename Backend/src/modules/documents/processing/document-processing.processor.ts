import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Document } from '../../../database/entities/document.entity';
import { DocumentStatus } from '../../../database/entities/document-status.enum';
import { DOCUMENT_PROCESSING_QUEUE, DocumentProcessingJobData } from './document-processing.constants';

@Processor(DOCUMENT_PROCESSING_QUEUE, { concurrency: 5 })
export class DocumentProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentProcessingProcessor.name);

  constructor(@InjectRepository(Document) private readonly documents: Repository<Document>) {
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

    // Trivial placeholder for real work — parsing/chunking/embedding arrive in Phases 5-7.
    // A THROW_FOR_TESTING flag on the job data lets tests deliberately force a failure
    // to exercise the retry/backoff/exhaustion path without needing real broken input.
    if ((job.data as DocumentProcessingJobData & { throwForTesting?: boolean }).throwForTesting) {
      throw new Error('Deliberate failure for testing retry/backoff behavior.');
    }

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
