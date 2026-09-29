import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { AppModule } from '../../app.module';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter';

describe('FixedWindowRateLimiter', () => {
  let app: INestApplication;
  let redis: Redis;
  const silentLogger = new Logger('test');
  silentLogger.warn = () => {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueKey = () => `rl-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  describe('with real Redis', () => {
    it('counts, limits after the configured number of hits, and is not degraded', async () => {
      const limiter = new FixedWindowRateLimiter(redis, silentLogger, { limit: 3, windowSeconds: 60 });
      const key = uniqueKey();

      const results = [];
      for (let i = 0; i < 4; i++) results.push(await limiter.hit(key));

      expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
      expect(results.map((r) => r.limited)).toEqual([false, false, false, true]);
      expect(results.every((r) => !r.degraded)).toBe(true);
      await redis.del(key);
    });

    // The bug the old INCR-then-EXPIRE pair had: a crash between the two left a counter with
    // no expiry, locking one email+IP out of login permanently. Done atomically, the very first
    // hit always carries its TTL.
    it('sets the expiry in the same atomic step as the first increment', async () => {
      const limiter = new FixedWindowRateLimiter(redis, silentLogger, { limit: 5, windowSeconds: 60 });
      const key = uniqueKey();

      await limiter.hit(key);
      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      await redis.del(key);
    });
  });

  describe('when Redis hangs', () => {
    // A HANG, not an error: this is what `docker pause` produced — an open connection that
    // never replies. A real hanging Redis cannot be produced inside the suite without freezing
    // it for every other test, so this one case uses a promise that never settles.
    const hangingRedis = { eval: () => new Promise(() => {}) } as unknown as Redis;

    it('answers within the timeout instead of hanging, and reports degraded', async () => {
      const limiter = new FixedWindowRateLimiter(hangingRedis, silentLogger, { limit: 5, windowSeconds: 60 });

      const started = Date.now();
      const result = await limiter.hit(uniqueKey());

      expect(Date.now() - started).toBeLessThan(1000);
      expect(result).toMatchObject({ count: 1, limited: false, degraded: true });
    });

    // Fail open, but NOT to "no limit": an attacker who notices or causes a Redis outage must
    // not get unlimited login attempts.
    it('still enforces the limit per-instance while degraded', async () => {
      const limiter = new FixedWindowRateLimiter(hangingRedis, silentLogger, { limit: 2, windowSeconds: 60 });
      const key = uniqueKey();

      const results = [];
      for (let i = 0; i < 3; i++) results.push(await limiter.hit(key));

      expect(results.map((r) => r.limited)).toEqual([false, false, true]);
    });

    it('the in-process window resets, so a degraded limiter never becomes a permanent lockout', async () => {
      const limiter = new FixedWindowRateLimiter(hangingRedis, silentLogger, { limit: 1, windowSeconds: 1 });
      const key = uniqueKey();

      await limiter.hit(key);
      expect((await limiter.hit(key)).limited).toBe(true);

      await new Promise((r) => setTimeout(r, 1100));
      expect((await limiter.hit(key)).limited).toBe(false);
    });
  });
});
