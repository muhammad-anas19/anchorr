import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const email = request.body?.email ?? 'unknown';
    const key = `login-attempts:${email}:${request.ip}`;

    const attempts = await this.redis.incr(key);
    if (attempts === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }

    if (attempts > MAX_ATTEMPTS) {
      throw new HttpException('Too many login attempts. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }
}
