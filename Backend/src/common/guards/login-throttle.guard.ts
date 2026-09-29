import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { FixedWindowRateLimiter } from '../rate-limit/fixed-window-rate-limiter';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

// Fails open to a per-instance fallback when Redis is unavailable — a product decision made in
// Phase 14 after observing login hang for 12 seconds during a Redis freeze. See
// FixedWindowRateLimiter for the reasoning.
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly limiter: FixedWindowRateLimiter;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.limiter = new FixedWindowRateLimiter(redis, new Logger(LoginThrottleGuard.name), {
      limit: MAX_ATTEMPTS,
      windowSeconds: WINDOW_SECONDS,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const email = request.body?.email ?? 'unknown';
    const { limited } = await this.limiter.hit(`login-attempts:${email}:${request.ip}`);

    if (limited) {
      throw new HttpException('Too many login attempts. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
