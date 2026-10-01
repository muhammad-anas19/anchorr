import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { withTimeout } from '../utils/with-timeout';

// Refill, check and take as ONE atomic step. Split into read → compute → write in application
// code, two concurrent requests would both read "1 token left" and both spend it.
//
// The clock is Redis's own (TIME), not the caller's. Every API instance shares this bucket; if
// each passed its own Date.now(), a server whose clock ran 2 s ahead would refill everyone's
// bucket early, and one 2 s behind would see time run backwards. One shared clock — the same
// lesson as the five-hour timezone bug: decide which clock is authoritative.
//
// Numbers go back as strings: Redis converts a Lua number reply to an INTEGER, silently
// truncating 0.97 tokens to 0.
const TAKE = `
  local capacity = tonumber(ARGV[1])
  local perMs = tonumber(ARGV[2])
  local cost = tonumber(ARGV[3])
  local ttlMs = tonumber(ARGV[4])
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

  local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
  local tokens = tonumber(state[1])
  local ts = tonumber(state[2])
  if tokens == nil then
    tokens = capacity
    ts = now
  end

  tokens = math.min(capacity, tokens + math.max(0, now - ts) * perMs)
  local allowed = 0
  local retryMs = 0
  if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
  else
    retryMs = math.ceil((cost - tokens) / perMs)
  end

  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  return { allowed, tostring(tokens), retryMs }
`;

// Read-only: the bucket's level right now, refilled to the present, WITHOUT taking a token or
// writing anything back. Reporting must never spend the budget it reports on.
const PEEK = `
  local capacity = tonumber(ARGV[1])
  local perMs = tonumber(ARGV[2])
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
  local tokens = tonumber(state[1])
  if tokens == nil then return tostring(capacity) end
  return tostring(math.min(capacity, tokens + math.max(0, now - tonumber(state[2])) * perMs))
`;

const REDIS_TIMEOUT_MS = 250;
const WARN_INTERVAL_MS = 10_000;
const LOCAL_SWEEP_THRESHOLD = 10_000;

export interface TokenBucketOptions {
  // The burst: how much can be done at once after being idle.
  capacity: number;
  // The sustained rate: how the bucket refills.
  refillPerSecond: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  // Whole tokens left after this request — what RateLimit-Remaining reports.
  remaining: number;
  limit: number;
  // When refused: how long until one token is available (Retry-After).
  retryAfterMs: number;
  // How long until the bucket is full again (RateLimit-Reset).
  resetMs: number;
  // Redis was unavailable and the per-instance fallback answered.
  degraded: boolean;
}

// A token bucket (diagnostic Q3): a sustained rate plus a deliberate, capped burst. Unlike the
// fixed window, there is no boundary where two full allowances sit back to back (Q2) — a
// burst is only available if it was earned by being idle.
//
// Fails OPEN to a weaker limit, exactly like FixedWindowRateLimiter (the Phase 14 decision):
// during a Redis outage each API process keeps its own bucket — N instances allow up to N × the
// limit — so protection degrades rather than vanishes, and the limiter never takes the
// service down with it.
export class TokenBucketRateLimiter {
  private readonly local = new Map<string, { tokens: number; ts: number }>();
  private readonly perMs: number;
  private readonly ttlMs: number;
  private lastWarnAt = 0;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly options: TokenBucketOptions,
  ) {
    this.perMs = options.refillPerSecond / 1000;
    // Once a bucket has had time to refill completely it is indistinguishable from a new,
    // full one — so it can simply expire. Idle clients cost no memory.
    this.ttlMs = Math.ceil(options.capacity / this.perMs) + 1000;
  }

  async take(key: string, cost = 1): Promise<TokenBucketResult> {
    try {
      const [allowed, tokens, retryMs] = (await withTimeout(
        this.redis.eval(TAKE, 1, key, this.options.capacity, this.perMs, cost, this.ttlMs) as Promise<[number, string, number]>,
        REDIS_TIMEOUT_MS,
      )) as [number, string, number];
      return this.result(allowed === 1, Number(tokens), retryMs, false);
    } catch (err) {
      this.warnThrottled(err as Error);
      return this.takeLocal(key, cost);
    }
  }

  // Whole tokens available now, or null if Redis can't say (the report shows "unknown" rather
  // than a guess — the per-instance fallback is not the shared figure).
  async peek(key: string): Promise<number | null> {
    try {
      const tokens = await withTimeout(this.redis.eval(PEEK, 1, key, this.options.capacity, this.perMs) as Promise<string>, REDIS_TIMEOUT_MS);
      return Math.floor(Number(tokens));
    } catch {
      return null;
    }
  }

  private takeLocal(key: string, cost: number): TokenBucketResult {
    const now = Date.now();
    if (this.local.size > LOCAL_SWEEP_THRESHOLD) {
      for (const [k, entry] of this.local) {
        if (now - entry.ts > this.ttlMs) this.local.delete(k);
      }
    }
    const entry = this.local.get(key) ?? { tokens: this.options.capacity, ts: now };
    entry.tokens = Math.min(this.options.capacity, entry.tokens + (now - entry.ts) * this.perMs);
    entry.ts = now;
    const allowed = entry.tokens >= cost;
    if (allowed) entry.tokens -= cost;
    this.local.set(key, entry);
    return this.result(allowed, entry.tokens, allowed ? 0 : Math.ceil((cost - entry.tokens) / this.perMs), true);
  }

  private result(allowed: boolean, tokens: number, retryAfterMs: number, degraded: boolean): TokenBucketResult {
    return {
      allowed,
      remaining: Math.floor(tokens),
      limit: this.options.capacity,
      retryAfterMs,
      resetMs: Math.ceil((this.options.capacity - tokens) / this.perMs),
      degraded,
    };
  }

  private warnThrottled(err: Error): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      `Token-bucket limiter degraded to in-process buckets (Redis unavailable: ${err.message}). ` +
        `Limits are now per-instance until Redis recovers.`,
    );
  }
}

// The standard response headers. RateLimit-* follows the IETF draft (GitHub and others send
// the X-RateLimit-* equivalents); Retry-After is standard HTTP (RFC 9110). They go on EVERY
// response, not only the 429, so a well-behaved client can slow down before it is refused.
export function rateLimitHeaders(result: TokenBucketResult): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
  };
  if (!result.allowed) headers['Retry-After'] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  return headers;
}
