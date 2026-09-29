import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [TypeOrmModule.forFeature([Membership, Workspace]), TenancyModule, RealtimeModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
})
export class WorkspacesModule {}
