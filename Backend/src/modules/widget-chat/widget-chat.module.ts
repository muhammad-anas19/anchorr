import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../../database/entities/workspace.entity';
import { RedisModule } from '../../redis/redis.module';
import { AnswerModule } from '../answer/answer.module';
import { WidgetChatGateway } from './widget-chat.gateway';
import { WidgetRateLimitGuard } from './widget-rate-limit.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace]), RedisModule, AnswerModule],
  providers: [WidgetChatGateway, WidgetRateLimitGuard],
})
export class WidgetChatModule {}
