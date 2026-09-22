import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationSession } from '../../database/entities/conversation-session.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { Membership } from '../../database/entities/membership.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversationSession, Conversation, Membership]),
    TenancyModule,
    RealtimeModule,
  ],
  controllers: [HandoffController],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}
