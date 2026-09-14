import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../../database/entities/document.entity';
import { Membership } from '../../database/entities/membership.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STORAGE_ADAPTER } from './storage/storage-adapter.interface';
import { LocalDiskStorageAdapter } from './storage/local-disk-storage.adapter';

@Module({
  // Membership must be imported here too (not just inside TenancyModule) because WorkspaceGuard
  // is transitively request-scoped (it depends on TenantContextService) — Nest rebuilds its whole
  // dependency chain fresh per request, from whichever module is actually consuming the guard.
  imports: [TypeOrmModule.forFeature([Document, Membership]), TenancyModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, { provide: STORAGE_ADAPTER, useClass: LocalDiskStorageAdapter }],
})
export class DocumentsModule {}
