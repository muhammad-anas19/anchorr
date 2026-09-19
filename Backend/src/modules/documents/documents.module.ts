import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Document } from '../../database/entities/document.entity';
import { DocumentContent } from '../../database/entities/document-content.entity';
import { DocumentChunk } from '../../database/entities/document-chunk.entity';
import { Membership } from '../../database/entities/membership.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STORAGE_ADAPTER } from './storage/storage-adapter.interface';
import { LocalDiskStorageAdapter } from './storage/local-disk-storage.adapter';
import { DOCUMENT_PROCESSING_QUEUE } from './processing/document-processing.constants';
import { DocumentProcessingProcessor } from './processing/document-processing.processor';
import { DOCUMENT_EMBEDDING_QUEUE } from './processing/embedding/document-embedding.constants';
import { DocumentEmbeddingProcessor } from './processing/embedding/document-embedding.processor';
import { EmbeddingModule } from '../../embedding/embedding.module';

@Module({
  // Membership must be imported here too (not just inside TenancyModule) because WorkspaceGuard
  // is transitively request-scoped (it depends on TenantContextService) — Nest rebuilds its whole
  // dependency chain fresh per request, from whichever module is actually consuming the guard.
  imports: [
    TypeOrmModule.forFeature([Document, DocumentContent, DocumentChunk, Membership]),
    TenancyModule,
    EmbeddingModule,
    BullModule.registerQueue({ name: DOCUMENT_PROCESSING_QUEUE }, { name: DOCUMENT_EMBEDDING_QUEUE }),
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentProcessingProcessor,
    DocumentEmbeddingProcessor,
    { provide: STORAGE_ADAPTER, useClass: LocalDiskStorageAdapter },
  ],
})
export class DocumentsModule {}
