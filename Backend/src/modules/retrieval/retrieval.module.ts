import { Module } from '@nestjs/common';
import { Membership } from '../../database/entities/membership.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EmbeddingModule } from '../../embedding/embedding.module';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

@Module({
  // Membership registered here too, for the same transitive-request-scope reason
  // documented in DocumentsModule — WorkspaceGuard needs Repository<Membership>
  // reconstructable within whichever module actually consumes it.
  imports: [TypeOrmModule.forFeature([Membership]), TenancyModule, EmbeddingModule],
  controllers: [RetrievalController],
  providers: [RetrievalService],
})
export class RetrievalModule {}
