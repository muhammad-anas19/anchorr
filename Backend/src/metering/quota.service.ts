import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

// The free trial, decided by the user on 2026-09-30.
export const TRIAL = { days: 7, answers: 200 } as const;

export type Reservation =
  | { state: 'reserved'; quotaId: number }
  // The workspace has never had a quota row: pay-as-you-go, nothing to enforce.
  | { state: 'unlimited' }
  | { state: 'exhausted'; allowance: number; periodEnd: Date }
  // It HAS had quota rows, but none covers now — the trial ended. Refused, not unlimited:
  // treating "no current row" as "no limit" would turn every expired trial into free usage.
  | { state: 'expired'; periodEnd: Date };

// A read-only view of the allowance, for reporting. Same four-way distinction as reserve():
// 'ended' (had an allowance, none current) is deliberately separate from 'unlimited'.
export type QuotaStatus =
  | { state: 'unlimited' }
  | {
      state: 'active' | 'exhausted' | 'ended';
      allowance: number;
      used: number;
      remaining: number;
      periodStart: string;
      periodEnd: string;
      source: string;
    };

// 402 Payment Required: the request is valid, and will succeed once the workspace has
// allowance again. Not 429, which tells a client "retry shortly" — retrying won't help here.
// Tenant-facing only: the widget catches it and hands the visitor to a human instead, so an
// end customer never learns anything about the business's billing state.
export class QuotaExceededException extends HttpException {
  constructor(readonly reservation: Extract<Reservation, { state: 'exhausted' | 'expired' }>) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: reservation.state === 'expired' ? 'trial_ended' : 'quota_exhausted',
        message:
          reservation.state === 'expired'
            ? `This workspace's allowance period ended on ${reservation.periodEnd.toISOString()}.`
            : `This workspace has used all ${reservation.allowance} answers for the current period, ` +
              `which ends ${reservation.periodEnd.toISOString()}.`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

@Injectable()
export class QuotaService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // Takes the caller's manager so the trial row is created in the SAME transaction as the
  // workspace: a workspace that exists without its trial row would be unlimited.
  async createTrial(manager: EntityManager, workspaceId: number): Promise<void> {
    await manager.query(
      `INSERT INTO workspace_quotas (workspace_id, metric, allowance, period_start, period_end, source)
       VALUES ($1, 'answer', $2, now(), now() + make_interval(days => $3), 'trial')`,
      [workspaceId, TRIAL.answers, TRIAL.days],
    );
  }

  async status(workspaceId: number): Promise<QuotaStatus> {
    // The current period if there is one, else the most recent — which is how an ended trial
    // is told apart from a workspace that never had an allowance.
    const [row] = await this.dataSource.query(
      `SELECT allowance, used, source, period_start AS "periodStart", period_end AS "periodEnd",
              (period_start <= now() AND now() < period_end) AS "current"
       FROM workspace_quotas WHERE workspace_id = $1 AND metric = 'answer'
       ORDER BY (period_start <= now() AND now() < period_end) DESC, period_end DESC
       LIMIT 1`,
      [workspaceId],
    );
    if (!row) return { state: 'unlimited' };
    return {
      state: !row.current ? 'ended' : row.used >= row.allowance ? 'exhausted' : 'active',
      allowance: row.allowance,
      used: row.used,
      remaining: Math.max(0, row.allowance - row.used),
      periodStart: new Date(row.periodStart).toISOString(),
      periodEnd: new Date(row.periodEnd).toISOString(),
      source: row.source,
    };
  }

  // One unit, reserved atomically BEFORE the work runs. Check-then-increment in application
  // code has a race: two requests at 499/500 both read 499, both pass, both run — 501. Here
  // the check and the increment are one statement, and the condition lives on the row being
  // updated, so Postgres serialises concurrent reservations on that row's lock (held for
  // microseconds, not for the Gemini call) and each re-checks `used < allowance` after the
  // previous one commits. Same shape as Phase 12's claim.
  async reserve(workspaceId: number): Promise<Reservation> {
    const [rows] = await this.dataSource.query(
      `UPDATE workspace_quotas SET used = used + 1
       WHERE workspace_id = $1 AND metric = 'answer'
         AND period_start <= now() AND now() < period_end
         AND used < allowance
       RETURNING id`,
      [workspaceId],
    );
    if (rows.length > 0) return { state: 'reserved', quotaId: rows[0].id };

    // Refused or unlimited — only reached off the happy path for limited workspaces, and on
    // every request for unlimited ones (one indexed lookup).
    const [current] = await this.dataSource.query(
      `SELECT allowance, period_end AS "periodEnd" FROM workspace_quotas
       WHERE workspace_id = $1 AND metric = 'answer' AND period_start <= now() AND now() < period_end`,
      [workspaceId],
    );
    if (current) return { state: 'exhausted', allowance: current.allowance, periodEnd: new Date(current.periodEnd) };

    const [latest] = await this.dataSource.query(
      `SELECT period_end AS "periodEnd" FROM workspace_quotas
       WHERE workspace_id = $1 AND metric = 'answer' ORDER BY period_end DESC LIMIT 1`,
      [workspaceId],
    );
    return latest ? { state: 'expired', periodEnd: new Date(latest.periodEnd) } : { state: 'unlimited' };
  }

  // Gives back a unit that was reserved but must not be counted: the outcome wasn't billable
  // (our own failure), the request errored, or it turned out to be a replay of an answer
  // already charged. `used > 0` so a refund can never push the counter negative.
  async refund(reservation: Reservation): Promise<void> {
    if (reservation.state !== 'reserved') return;
    await this.dataSource.query(`UPDATE workspace_quotas SET used = used - 1 WHERE id = $1 AND used > 0`, [
      reservation.quotaId,
    ]);
  }

  // Recomputes the current period's `used` from the meter. A crash between reserve() and the
  // usage event leaks a unit; this repairs it — the counter is a cache of the meter, and the
  // meter wins. Half-open range, the same one every period query uses.
  async reconcile(workspaceId: number): Promise<{ before: number; after: number } | null> {
    const [rows] = await this.dataSource.query(
      `UPDATE workspace_quotas q
       SET used = LEAST(q.allowance, (
         SELECT count(*) FROM usage_events e
         WHERE e.workspace_id = q.workspace_id AND e.metric = 'answer' AND e.billable
           AND e.occurred_at >= q.period_start AND e.occurred_at < q.period_end
       ))
       FROM (SELECT id, used AS before FROM workspace_quotas
             WHERE workspace_id = $1 AND metric = 'answer' AND period_start <= now() AND now() < period_end) old
       WHERE q.id = old.id
       RETURNING old.before, q.used AS after`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }
}
