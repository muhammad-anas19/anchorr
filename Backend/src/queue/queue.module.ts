import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // 'bull' is BullMQ's own default. Tests override it (test/setup-env.ts) so their jobs
        // can never be consumed by a dev server's workers sharing the same Redis, or vice versa.
        prefix: config.get<string>('QUEUE_PREFIX') ?? 'bull',
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
