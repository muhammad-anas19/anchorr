import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { AppModule } from '../../app.module';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { rateLimitHeaders, TokenBucketRateLimiter } from './token-bucket-rate-limiter';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter';

describe('TokenBucketRateLimiter', () => {
  let app: INestApplication;
  let redis: Redis;
  const silentLogger = new Logger('test');
  silentLogger.warn = () => {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const uniqueKey = () => `tb-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows a burst of `capacity`, then refuses with the time until the next token', async () => {
    const limiter = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 5, refillPerSecond: 1 });
    const key = uniqueKey();

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await limiter.take(key));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
    // One token at 1/s: just under a second away, allowing for the time the loop took.
    expect(results[5].retryAfterMs).toBeGreaterThan(900);
    expect(results[5].retryAfterMs).toBeLessThanOrEqual(1000);
    expect(results.every((r) => !r.degraded)).toBe(true);
  });

  // The rate is slow relative to the gaps between calls on purpose. The first version refilled
  // at 20/s — one token every 50 ms — and failed under full-suite load, where ~50 ms between two
  // Redis calls was enough to refill the token the test asserted must be missing. At 2/s a
  // token takes 500 ms, far more than back-to-back calls ever take.
  it('refills continuously at the configured rate', async () => {
    const limiter = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 2, refillPerSecond: 2 });
    const key = uniqueKey();
    await limiter.take(key);
    await limiter.take(key);
    expect((await limiter.take(key)).allowed).toBe(false);

    await sleep(1100); // 2/s → ~2.2 tokens, capped at 2
    expect((await limiter.take(key)).allowed).toBe(true);
    expect((await limiter.take(key)).allowed).toBe(true);
    expect((await limiter.take(key)).allowed).toBe(false);
  });

  // Diagnostic Q2, measured. A fixed window forgets everything at its boundary, so a client
  // that fills one window right before it ends gets a full second allowance immediately
  // after: 2x the limit in an instant. A token bucket has no boundary to exploit.
  it('does not allow the boundary burst a fixed window does', async () => {
    const fixed = new FixedWindowRateLimiter(redis, silentLogger, { limit: 5, windowSeconds: 1 });
    const bucket = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 5, refillPerSecond: 5 });
    const fixedKey = uniqueKey();
    const bucketKey = uniqueKey();

    // Open the fixed window, then wait until just before it ends.
    await fixed.hit(fixedKey);
    await sleep(850);
    let fixedAccepted = 1;
    let bucketAccepted = 0;
    const burstStartedAt = Date.now();
    for (let i = 0; i < 4; i++) if (!(await fixed.hit(fixedKey)).limited) fixedAccepted++;
    for (let i = 0; i < 5; i++) if ((await bucket.take(bucketKey)).allowed) bucketAccepted++;
    await sleep(200); // the fixed window rolls over
    for (let i = 0; i < 5; i++) if (!(await fixed.hit(fixedKey)).limited) fixedAccepted++;
    for (let i = 0; i < 5; i++) if ((await bucket.take(bucketKey)).allowed) bucketAccepted++;
    const elapsedMs = Date.now() - burstStartedAt;

    // Fixed window: 10 accepted inside well under a second.
    expect(fixedAccepted).toBe(10);
    // Token bucket: the burst of 5, plus only what refilled during the elapsed time (5/s).
    expect(bucketAccepted).toBeLessThanOrEqual(5 + Math.ceil((elapsedMs / 1000) * 5));
    expect(bucketAccepted).toBeLessThan(fixedAccepted);
  });

  // The atomicity the Lua script exists for. Read-compute-write in application code would let
  // concurrent requests read the same token count and all spend it.
  it('grants exactly `capacity` tokens to many concurrent requests', async () => {
    const limiter = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 10, refillPerSecond: 0.001 });
    const key = uniqueKey();
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.take(key)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('expires an idle bucket once it would have refilled completely', async () => {
    const limiter = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 4, refillPerSecond: 2 });
    const key = uniqueKey();
    await limiter.take(key);
    const ttl = await redis.pttl(key);
    // Full refill takes 4 / 2 = 2 s, plus a 1 s margin.
    expect(ttl).toBeGreaterThan(2500);
    expect(ttl).toBeLessThanOrEqual(3000);
  });

  // The Phase 14 decision, applied to the new limiter: a Redis that never answers must neither
  // hang the request nor remove the limit. It fails open to a per-instance bucket.
  it('fails open to a per-instance bucket when Redis hangs, still enforcing the limit', async () => {
    const hanging = { eval: () => new Promise(() => {}) } as unknown as Redis;
    const limiter = new TokenBucketRateLimiter(hanging, silentLogger, { capacity: 3, refillPerSecond: 0.001 });
    const key = uniqueKey();

    const startedAt = Date.now();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.take(key));

    expect(results.every((r) => r.degraded)).toBe(true);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(Date.now() - startedAt).toBeLessThan(4 * 400); // each call gave up at ~250 ms
  });

  it('builds the standard headers, adding Retry-After only on a refusal', () => {
    expect(rateLimitHeaders({ allowed: true, remaining: 7, limit: 20, retryAfterMs: 0, resetMs: 39_000, degraded: false })).toEqual({
      'RateLimit-Limit': '20',
      'RateLimit-Remaining': '7',
      'RateLimit-Reset': '39',
    });
    expect(
      rateLimitHeaders({ allowed: false, remaining: 0, limit: 20, retryAfterMs: 2_100, resetMs: 60_000, degraded: false }),
    ).toMatchObject({ 'Retry-After': '3', 'RateLimit-Remaining': '0' });
  });

  it('peeks at the level without spending a token', async () => {
    const limiter = new TokenBucketRateLimiter(redis, silentLogger, { capacity: 5, refillPerSecond: 0.001 });
    const key = uniqueKey();
    expect(await limiter.peek(key)).toBe(5); // untouched bucket = full
    await limiter.take(key);
    await limiter.take(key);
    expect(await limiter.peek(key)).toBe(3);
    expect(await limiter.peek(key)).toBe(3); // peeking twice changed nothing
  });
});
