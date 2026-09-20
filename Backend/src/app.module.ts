import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { Workspace } from './database/entities/workspace.entity';
import { User } from './database/entities/user.entity';
import { Membership } from './database/entities/membership.entity';
import { RefreshToken } from './database/entities/refresh-token.entity';
import { Document } from './database/entities/document.entity';
import { DocumentContent } from './database/entities/document-content.entity';
import { DocumentChunk } from './database/entities/document-chunk.entity';
import { Conversation } from './database/entities/conversation.entity';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { RetrievalModule } from './modules/retrieval/retrieval.module';
import { AnswerModule } from './modules/answer/answer.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        username: config.get<string>('DB_USERNAME'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        entities: [Workspace, User, Membership, RefreshToken, Document, DocumentContent, DocumentChunk, Conversation],
        synchronize: false,
      }),
    }),
    QueueModule,
    AuthModule,
    WorkspacesModule,
    DocumentsModule,
    RetrievalModule,
    AnswerModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
