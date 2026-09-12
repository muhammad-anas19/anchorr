import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { TenantContextService } from './tenant-context.service';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Membership])],
  providers: [TenantContextService, WorkspaceGuard, RolesGuard],
  exports: [TenantContextService, WorkspaceGuard, RolesGuard],
})
export class TenancyModule {}
