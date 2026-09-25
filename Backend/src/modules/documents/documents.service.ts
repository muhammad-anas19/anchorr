import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { Document } from '../../database/entities/document.entity';
import { DocumentStatus } from '../../database/entities/document-status.enum';
import { STORAGE_ADAPTER, StorageAdapter } from './storage/storage-adapter.interface';
import { sniffMimeType } from './mime-sniffer';
import { DOCUMENT_PROCESSING_QUEUE, DocumentProcessingJobData } from './processing/document-processing.constants';
import { DOCUMENT_EMBEDDING_QUEUE, DocumentEmbeddingJobData } from './processing/embedding/document-embedding.constants';

interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
}

export interface DocumentSummary extends Document {
  chunkCount: number;
  uploadedByEmail: string | null;
}

// Whatever shape the currently-running job last reported via job.updateProgress() — see the
// processors themselves for exactly which stages exist. Redis-only, non-durable: null simply
// means "no live job right now," which is also the normal, permanent state for every document
// that's already ready or failed.
export type DocumentProgress = { stage: string; [key: string]: unknown } | null;

const POSTGRES_UNIQUE_VIOLATION = '23505';
const LIVE_JOB_STATES = ['active', 'waiting', 'delayed'] as const;

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @InjectQueue(DOCUMENT_PROCESSING_QUEUE) private readonly processingQueue: Queue<DocumentProcessingJobData>,
    @InjectQueue(DOCUMENT_EMBEDDING_QUEUE) private readonly embeddingQueue: Queue<DocumentEmbeddingJobData>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async upload(workspaceId: number, uploadedByUserId: number, file: UploadedFileLike): Promise<Document> {
    const mimeType = sniffMimeType(file.buffer);
    if (!mimeType) {
      throw new UnprocessableEntityException('Unsupported or unrecognized file type. Only PDF and DOCX are accepted.');
    }

    const contentHash = createHash('sha256').update(file.buffer).digest('hex');

    const existing = await this.documents.findOne({ where: { workspaceId, contentHash } });
    if (existing) {
      throw new ConflictException(`This exact file was already uploaded to this workspace (document #${existing.id}).`);
    }

    const storageKey = randomUUID();
    await this.storage.save(storageKey, file.buffer);

    let document: Document;
    try {
      document = await this.documents.save({
        workspaceId,
        uploadedByUserId,
        originalFilename: file.originalname,
        storageKey,
        mimeType,
        fileSizeBytes: file.buffer.length,
        contentHash,
        status: DocumentStatus.UPLOADED,
      });
    } catch (error) {
      await this.storage.delete(storageKey);
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('This exact file was already uploaded to this workspace.');
      }
      throw error;
    }

    // Enqueue only — this resolves as soon as the job is written to Redis, well before
    // the worker actually picks it up. The HTTP response goes out with status "uploaded".
    await this.processingQueue.add(
      'process',
      { documentId: document.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    return document;
  }

  async listForWorkspace(workspaceId: number): Promise<DocumentSummary[]> {
    const documents = await this.documents.find({ where: { workspaceId }, order: { createdAt: 'DESC' } });
    return this.enrich(documents);
  }

  async getOne(workspaceId: number, documentId: number): Promise<DocumentSummary> {
    const document = await this.documents.findOne({ where: { id: documentId, workspaceId } });
    if (!document) {
      throw new NotFoundException('Document not found.');
    }
    const [summary] = await this.enrich([document]);
    return summary;
  }

  async remove(workspaceId: number, documentId: number): Promise<void> {
    const document = await this.getOne(workspaceId, documentId);
    await this.storage.delete(document.storageKey);
    await this.documents.remove(document);
  }

  // Looks for a currently in-flight job (in either queue) for this document and returns
  // whatever it last reported. Deliberately not a source of truth for anything — a live UI
  // detail on top of the real, persisted `status`, which is unaffected if this returns null.
  async getProgress(workspaceId: number, documentId: number): Promise<DocumentProgress> {
    await this.getOne(workspaceId, documentId);

    const processingJob = await this.findLiveJob(this.processingQueue, documentId);
    if (processingJob) {
      return (processingJob.progress as DocumentProgress) ?? null;
    }

    const embeddingJob = await this.findLiveJob(this.embeddingQueue, documentId);
    if (embeddingJob) {
      return (embeddingJob.progress as DocumentProgress) ?? null;
    }

    return null;
  }

  // Scans recent jobs in a queue for one matching this document — fine at this project's
  // current scale (a handful of concurrent uploads per workspace), but a real limitation
  // worth naming: this doesn't scale to a queue with thousands of jobs in flight, since
  // there's no index from documentId to job id. A deterministic, documentId-derived job id
  // would be the real fix if this ever needed to.
  private async findLiveJob(
    queue: Queue<DocumentProcessingJobData> | Queue<DocumentEmbeddingJobData>,
    documentId: number,
  ) {
    const jobs = await queue.getJobs([...LIVE_JOB_STATES], 0, 50);
    const matches = jobs.filter((job) => job.data.documentId === documentId);
    if (matches.length === 0) {
      return null;
    }
    // More than one match is a real possibility even in production (a document's job data
    // is never unique-keyed) — the most recently created job is the one actually relevant
    // to what's live right now, not whichever happens to come first in Redis's own ordering.
    return matches.reduce((latest, job) => (job.timestamp > latest.timestamp ? job : latest));
  }

  private async enrich(documents: Document[]): Promise<DocumentSummary[]> {
    if (documents.length === 0) {
      return [];
    }

    const documentIds = documents.map((d) => d.id);
    const uploaderIds = [...new Set(documents.map((d) => d.uploadedByUserId).filter((id): id is number => id !== null))];

    const chunkCountRows: { document_id: number; count: string }[] = await this.dataSource.query(
      `SELECT document_id, COUNT(*)::int AS count FROM document_chunks WHERE document_id = ANY($1) GROUP BY document_id`,
      [documentIds],
    );
    const chunkCountByDocument = new Map(chunkCountRows.map((row) => [row.document_id, Number(row.count)]));

    const userRows: { id: number; email: string }[] = uploaderIds.length
      ? await this.dataSource.query(`SELECT id, email FROM users WHERE id = ANY($1)`, [uploaderIds])
      : [];
    const emailByUserId = new Map(userRows.map((row) => [row.id, row.email]));

    return documents.map((document) => ({
      ...document,
      chunkCount: chunkCountByDocument.get(document.id) ?? 0,
      uploadedByEmail: document.uploadedByUserId ? (emailByUserId.get(document.uploadedByUserId) ?? null) : null,
    }));
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
  }
}
