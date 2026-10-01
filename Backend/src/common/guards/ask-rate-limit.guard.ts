import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Response } from 'express';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { rateLimitHeaders, TokenBucketRateLimiter } from '../rate-limit/token-bucket-rate-limiter';

// 20 questions at once after being idle, 20 a minute sustained, per workspace. Per workspace
// rather than per user, because what it protects is shared: the Gemini quota and the capacity
// every tenant draws on. A tenant's own members share their tenant's budget.
export const ASK_LIMIT = { capacity: 20, refillPerSecond: 20 / 60 };
export const askBucketKey = (workspaceId: number) => `ask:${workspaceId}`;

// Rate limit, not quota (diagnostic Q1): "too fast", answered 429, retry in a moment. The
// quota — "too much this period", 402 — is checked later, in AnswerService.
@Injectable()
export class AskRateLimitGuard implements CanActivate {
  private readonly limiter: TokenBucketRateLimiter;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.limiter = new TokenBucketRateLimiter(redis, new Logger(AskRateLimitGuard.name), ASK_LIMIT);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const workspaceId = Number(http.getRequest().params.workspaceId);
    const response = http.getResponse<Response>();

    const result = await this.limiter.take(askBucketKey(workspaceId));
    // Set before any throw: Nest's exception filter writes its 429 through the same response
    // object, so these headers ride along on the refusal too.
    response.set(rateLimitHeaders(result));

    if (!result.allowed) {
      throw new HttpException(
        { statusCode: 429, error: 'rate_limited', message: 'Too many questions at once. Slow down and retry shortly.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
