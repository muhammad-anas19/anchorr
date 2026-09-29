import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { TenantContextService } from './tenant-context.service';
import { PermissionsService } from './permissions.service';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Membership])],
  providers: [TenantContextService, PermissionsService, WorkspaceGuard, PermissionsGuard],
  exports: [TenantContextService, PermissionsService, WorkspaceGuard, PermissionsGuard],
})
export class TenancyModule {}
