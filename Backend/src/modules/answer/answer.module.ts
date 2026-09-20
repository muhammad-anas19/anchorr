import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { GenerationModule } from '../../generation/generation.module';
import { AnswerController } from './answer.controller';
import { AnswerService } from './answer.service';

@Module({
  imports: [TypeOrmModule.forFeature([Membership, Conversation]), TenancyModule, RetrievalModule, GenerationModule],
  controllers: [AnswerController],
  providers: [AnswerService],
  exports: [AnswerService],
})
export class AnswerModule {}
