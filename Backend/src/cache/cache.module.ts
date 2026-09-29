import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { AnswerCacheService } from './answer-cache.service';

// Top-level shared infrastructure, a sibling of redis/ and embedding/: AnswerModule reads and
// writes the cache, DocumentsModule invalidates it, and neither should depend on the other.
@Module({
  imports: [RedisModule],
  providers: [AnswerCacheService],
  exports: [AnswerCacheService],
})
export class CacheModule {}
