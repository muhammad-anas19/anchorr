import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

const MAX_MESSAGES = 20;
const WINDOW_SECONDS = 60;

// Mirrors LoginThrottleGuard's shape (Phase 2) — a narrow, Redis-backed stopgap ahead of Phase
// 15's general rate limiting, same justification: this is the first surface protected only by
// a credential that's necessarily visible to anyone who views the embedding page's own HTML.
// Keyed by publicKey, not by socket id or IP — the key itself is what could be copied and
// abused from anywhere, so the throttle has to follow the key, not any one connection using it.
@Injectable()
export class WidgetRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const publicKey = client.handshake.auth?.publicKey as string | undefined;
    const key = `widget-messages:${publicKey}`;

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }

    if (count > MAX_MESSAGES) {
      throw new WsException('Too many messages. Please slow down.');
    }

    return true;
  }
}
