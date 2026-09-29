import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter';

const MAX_MESSAGES = 20;
const WINDOW_SECONDS = 60;

// A narrow stopgap ahead of Phase 15's general rate limiting. This is the first surface
// protected only by a credential visible to anyone who views the embedding page's own HTML.
// Keyed by publicKey, not by socket id or IP — the key itself is what could be copied and
// abused from anywhere, so the throttle has to follow the key, not any one connection using it.
//
// Fails open to a per-instance fallback when Redis is unavailable (Phase 14 decision): the
// widget stays usable during a Redis outage, while an abuser still cannot burn the Gemini
// quota without limit.
@Injectable()
export class WidgetRateLimitGuard implements CanActivate {
  private readonly limiter: FixedWindowRateLimiter;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.limiter = new FixedWindowRateLimiter(redis, new Logger(WidgetRateLimitGuard.name), {
      limit: MAX_MESSAGES,
      windowSeconds: WINDOW_SECONDS,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const publicKey = client.handshake.auth?.publicKey as string | undefined;
    const { limited } = await this.limiter.hit(`widget-messages:${publicKey}`);

    if (limited) {
      throw new WsException('Too many messages. Please slow down.');
    }
    return true;
  }
}
