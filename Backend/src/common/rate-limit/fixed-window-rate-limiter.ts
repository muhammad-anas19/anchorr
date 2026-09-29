import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { withTimeout } from '../utils/with-timeout';

// INCR and EXPIRE as ONE atomic step. Issued as two separate commands (as both guards did until
// Phase 14), a crash between them leaves a counter with no expiry — and for the login throttle
// that means one email+IP pair locked out of logging in permanently.
const INCR_WITH_EXPIRY = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

const REDIS_TIMEOUT_MS = 250;
// During an outage every request fails over, so warning on each one would bury the logs in
// thousands of identical lines. Once every 10 seconds is enough to be unmissable.
const WARN_INTERVAL_MS = 10_000;
// Bound on the in-process fallback map, so an outage under heavy traffic cannot grow it without
// limit. Expired entries are swept when it gets this large.
const LOCAL_SWEEP_THRESHOLD = 10_000;

export interface RateLimitResult {
  count: number;
  limited: boolean;
  // True when Redis was unavailable and the in-process fallback answered instead.
  degraded: boolean;
}

// A fixed-window counter that FAILS OPEN — but to a weaker limit, not to no limit at all.
//
// Why open: a rate limiter protects the service, and must not become the thing that takes it
// down. Failing closed would turn a Redis blip into "nobody can log in" (observed: /auth/login
// hung for the full 12 seconds of a `docker pause` before this existed). This is also the
// industry default — Envoy's global rate limiter, for one, ships with failure_mode_deny off.
//
// Why not fully open: an attacker who notices, or causes, a Redis outage would otherwise get
// unlimited attempts. So during an outage each API process keeps its own in-memory count.
// That is weaker — N instances allow N × limit — but protection degrades rather than vanishes.
// For login there is a further layer regardless: bcrypt at 12 rounds costs ~250 ms per attempt.
export class FixedWindowRateLimiter {
  private readonly local = new Map<string, { count: number; resetAt: number }>();
  private lastWarnAt = 0;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly options: { limit: number; windowSeconds: number },
  ) {}

  async hit(key: string): Promise<RateLimitResult> {
    try {
      const count = (await withTimeout(
        this.redis.eval(INCR_WITH_EXPIRY, 1, key, this.options.windowSeconds) as Promise<number>,
        REDIS_TIMEOUT_MS,
      )) as number;
      return { count, limited: count > this.options.limit, degraded: false };
    } catch (err) {
      this.warnThrottled(err as Error);
      const count = this.hitLocal(key);
      return { count, limited: count > this.options.limit, degraded: true };
    }
  }

  private hitLocal(key: string): number {
    const now = Date.now();
    if (this.local.size > LOCAL_SWEEP_THRESHOLD) {
      for (const [k, entry] of this.local) {
        if (entry.resetAt <= now) this.local.delete(k);
      }
    }
    const existing = this.local.get(key);
    if (!existing || existing.resetAt <= now) {
      this.local.set(key, { count: 1, resetAt: now + this.options.windowSeconds * 1000 });
      return 1;
    }
    existing.count++;
    return existing.count;
  }

  private warnThrottled(err: Error): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      `Rate limiter degraded to in-process counting (Redis unavailable: ${err.message}). ` +
        `Limits are now per-instance until Redis recovers.`,
    );
  }
}
