import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Workspace } from '../../database/entities/workspace.entity';
import { Membership } from '../../database/entities/membership.entity';
import { ConversationSession } from '../../database/entities/conversation-session.entity';
import { RedisModule } from '../../redis/redis.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { AnswerModule } from '../answer/answer.module';
import { WidgetChatGateway } from './widget-chat.gateway';
import { WidgetRateLimitGuard } from './widget-rate-limit.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace, Membership, ConversationSession]),
    RedisModule,
    RealtimeModule,
    AnswerModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [WidgetChatGateway, WidgetRateLimitGuard],
})
export class WidgetChatModule {}
