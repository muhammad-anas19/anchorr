import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { TokenBucketRateLimiter } from '../../common/rate-limit/token-bucket-rate-limiter';

// Two buckets, both of which must have a token.
//
// Per public key — the whole embedding site. The key is visible in the page's HTML, so anyone
// can copy it and send messages from anywhere; this caps what one leaked key can cost.
//
// Per visitor session — fairness within a site. With only the site-wide bucket, one visitor
// hammering the chat would spend the budget every other visitor on that site shares.
//
// A token is taken from the site bucket only when the visitor's own bucket allowed the
// message, so a single abusive visitor can't drain the site's budget with refused requests.
export const WIDGET_SITE_LIMIT = { capacity: 60, refillPerSecond: 1 };
export const WIDGET_SESSION_LIMIT = { capacity: 10, refillPerSecond: 1 / 3 };

// Replaces Phase 11's fixed window (20 per minute per key). Fails open to per-instance buckets
// when Redis is unavailable, as decided in Phase 14.
@Injectable()
export class WidgetRateLimitGuard implements CanActivate {
  private readonly site: TokenBucketRateLimiter;
  private readonly session: TokenBucketRateLimiter;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    const logger = new Logger(WidgetRateLimitGuard.name);
    this.site = new TokenBucketRateLimiter(redis, logger, WIDGET_SITE_LIMIT);
    this.session = new TokenBucketRateLimiter(redis, logger, WIDGET_SESSION_LIMIT);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const publicKey = client.handshake.auth?.publicKey as string | undefined;
    const sessionId = client.handshake.auth?.sessionId as string | undefined;

    const own = await this.session.take(`widget-session:${publicKey}:${sessionId}`);
    const result = own.allowed ? await this.site.take(`widget-site:${publicKey}`) : own;

    if (!result.allowed) {
      // A named event with the wait, not a generic exception: the widget can tell the visitor
      // how long to wait instead of showing a raw error. The message is dropped, not queued —
      // queueing would just replay the burst the limit is refusing.
      client.emit('rate-limited', { retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) });
      return false;
    }
    return true;
  }
}
