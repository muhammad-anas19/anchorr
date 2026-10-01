import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QuotaService, QuotaStatus } from '../../metering/quota.service';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { TokenBucketRateLimiter } from '../../common/rate-limit/token-bucket-rate-limiter';
import { ASK_LIMIT, askBucketKey } from '../../common/guards/ask-rate-limit.guard';

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface UsageReport {
  range: { from: string; to: string; timezone: 'UTC' };
  answers: {
    total: number;
    billable: number;
    byStatus: { answered: number; refused: number; escalated: number };
    cacheHits: number;
    promptTokens: number;
    totalTokens: number;
  };
  chunksEmbedded: { total: number; billable: number; characters: number };
  daily: Array<{ day: string; answers: number; billableAnswers: number; chunksEmbedded: number; totalTokens: number }>;
  quota: QuotaStatus;
  rateLimit: { burst: number; perMinute: number; available: number | null };
}

@Injectable()
export class UsageService {
  private readonly askLimiter: TokenBucketRateLimiter;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly quota: QuotaService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.askLimiter = new TokenBucketRateLimiter(redis, new Logger(UsageService.name), ASK_LIMIT);
  }

  async report(workspaceId: number, fromInput?: string, toInput?: string): Promise<UsageReport> {
    const quota = await this.quota.status(workspaceId);
    const { from, to } = resolveRange(fromInput, toInput, quota);

    // Totals: one pass, with FILTER per figure rather than a query per figure. Tokens and
    // characters come from the event attributes — the raw facts the meter recorded.
    const [totals] = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE metric = 'answer')::int AS "answers",
         count(*) FILTER (WHERE metric = 'answer' AND billable)::int AS "billableAnswers",
         count(*) FILTER (WHERE metric = 'answer' AND attributes->>'status' = 'answered')::int AS "answered",
         count(*) FILTER (WHERE metric = 'answer' AND attributes->>'status' = 'refused')::int AS "refused",
         count(*) FILTER (WHERE metric = 'answer' AND attributes->>'status' = 'escalated')::int AS "escalated",
         count(*) FILTER (WHERE metric = 'answer' AND attributes->>'cache' = 'hit')::int AS "cacheHits",
         coalesce(sum((attributes->>'promptTokens')::int) FILTER (WHERE metric = 'answer'), 0)::int AS "promptTokens",
         coalesce(sum((attributes->>'totalTokens')::int) FILTER (WHERE metric = 'answer'), 0)::int AS "totalTokens",
         coalesce(sum(quantity) FILTER (WHERE metric = 'chunk_embedded'), 0)::int AS "chunks",
         coalesce(sum(quantity) FILTER (WHERE metric = 'chunk_embedded' AND billable), 0)::int AS "billableChunks",
         coalesce(sum((attributes->>'characters')::int) FILTER (WHERE metric = 'chunk_embedded'), 0)::int AS "characters"
       FROM usage_events
       WHERE workspace_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      [workspaceId, from, to],
    );

    // Daily series in UTC. generate_series produces every day in the range; the LEFT JOIN
    // fills it, so a day with no events is a row of zeros rather than a missing row.
    const daily = await this.dataSource.query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC'),
           -- Stops at today when the range runs into the future (the current period does). A
           -- future day has no data YET; drawn as a zero it would claim "no usage" — a wrong
           -- answer, not a missing one.
           date_trunc('day', (least($3::timestamptz, now()) - interval '1 microsecond') AT TIME ZONE 'UTC'),
           interval '1 day'
         ) AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              count(e.id) FILTER (WHERE e.metric = 'answer')::int AS "answers",
              count(e.id) FILTER (WHERE e.metric = 'answer' AND e.billable)::int AS "billableAnswers",
              coalesce(sum(e.quantity) FILTER (WHERE e.metric = 'chunk_embedded'), 0)::int AS "chunksEmbedded",
              coalesce(sum((e.attributes->>'totalTokens')::int) FILTER (WHERE e.metric = 'answer'), 0)::int AS "totalTokens"
       FROM days d
       LEFT JOIN usage_events e
         ON e.workspace_id = $1
        AND e.occurred_at >= $2 AND e.occurred_at < $3
        AND date_trunc('day', e.occurred_at AT TIME ZONE 'UTC') = d.day
       GROUP BY d.day
       ORDER BY d.day`,
      [workspaceId, from, to],
    );

    return {
      range: { from: from.toISOString(), to: to.toISOString(), timezone: 'UTC' },
      answers: {
        total: totals.answers,
        billable: totals.billableAnswers,
        byStatus: { answered: totals.answered, refused: totals.refused, escalated: totals.escalated },
        cacheHits: totals.cacheHits,
        promptTokens: totals.promptTokens,
        totalTokens: totals.totalTokens,
      },
      chunksEmbedded: { total: totals.chunks, billable: totals.billableChunks, characters: totals.characters },
      daily,
      quota,
      rateLimit: {
        burst: ASK_LIMIT.capacity,
        perMinute: Math.round(ASK_LIMIT.refillPerSecond * 60),
        available: await this.askLimiter.peek(askBucketKey(workspaceId)),
      },
    };
  }
}

function resolveRange(fromInput: string | undefined, toInput: string | undefined, quota: QuotaStatus) {
  let from: Date;
  let to: Date;
  if (fromInput || toInput) {
    to = toInput ? new Date(toInput) : new Date();
    from = fromInput ? new Date(fromInput) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  } else if (quota.state !== 'unlimited') {
    // No range asked for: the allowance period, so the page and the quota bar agree.
    from = new Date(quota.periodStart);
    to = new Date(quota.periodEnd);
  } else {
    to = new Date();
    from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  }

  if (!(to.getTime() > from.getTime())) {
    throw new BadRequestException('"to" must be after "from".');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(`A usage report can cover at most ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to };
}
