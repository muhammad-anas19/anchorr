import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { Document } from '../../database/entities/document.entity';
import { DocumentStatus } from '../../database/entities/document-status.enum';
import { STORAGE_ADAPTER, StorageAdapter } from './storage/storage-adapter.interface';
import { sniffMimeType } from './mime-sniffer';

interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
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

    try {
      return await this.documents.save({
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
  }

  listForWorkspace(workspaceId: number): Promise<Document[]> {
    return this.documents.find({ where: { workspaceId }, order: { createdAt: 'DESC' } });
  }

  async getOne(workspaceId: number, documentId: number): Promise<Document> {
    const document = await this.documents.findOne({ where: { id: documentId, workspaceId } });
    if (!document) {
      throw new NotFoundException('Document not found.');
    }
    return document;
  }

  async remove(workspaceId: number, documentId: number): Promise<void> {
    const document = await this.getOne(workspaceId, documentId);
    await this.storage.delete(document.storageKey);
    await this.documents.remove(document);
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
  }
}
