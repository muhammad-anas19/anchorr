'use client';

import { useState, type ReactNode } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { useFetch } from '../../shared/hooks/useFetch';
import { Badge, Card, CardTitle, Meter, StatTile, StatTileRow, Tabs } from '../../shared/ui/primitives';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { getUsage, QuotaStatus, UsageReport } from './api';
import { DailyUsageChart } from './DailyUsageChart';
import { compact, percent, utcDate } from './format';

type Range = 'period' | '7d' | '30d';
const DAY_MS = 86_400_000;

// Matches the prototype's "Usage & cost" screen, with one rule applied to every section: show
// what the system really knows, and say plainly what it doesn't yet. There are no prices
// until Phase 16, so there is no cost anywhere on this page — not an estimate, not a
// placeholder number.
export function UsagePage() {
  const { workspaceId } = useWorkspace();
  const [range, setRange] = useState<Range>('period');

  const params = rangeParams(range);
  const { data, loading, error } = useFetch(
    (signal) => getUsage(workspaceId, params, signal),
    JSON.stringify({ workspaceId, range }),
  );

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1240 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, font: '600 24px/1.2 var(--font-sans)', letterSpacing: '-.02em' }}>Usage &amp; cost</h1>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)' }}>
          Every model call this workspace made, from the usage ledger.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, marginLeft: -14, flexWrap: 'wrap' }}>
        <Tabs
          options={[
            { value: 'period', label: 'Current period' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
          ]}
          value={range}
          onChange={setRange}
        />
        {data && (
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {utcDate(data.range.from)} – {utcDate(new Date(new Date(data.range.to).getTime() - 1).toISOString(), true)} · UTC
          </span>
        )}
      </div>

      <ErrorBanner message={error} />
      {!data && loading && <p style={{ color: 'var(--faint)', fontSize: 13 }}>Loading usage…</p>}

      {data && (
        <div style={{ display: 'grid', gap: 16, opacity: loading ? 0.6 : 1, transition: 'opacity .12s' }}>
          <StatTileRow>
            <StatTile label="AI requests" value={data.answers.total.toLocaleString()} />
            <StatTile label="Input tokens" value={compact(data.answers.promptTokens)} />
            <StatTile label="Output tokens" value={compact(Math.max(0, data.answers.totalTokens - data.answers.promptTokens))} />
            {/* No prices exist until Phase 16. An estimate would be a number with nothing behind it. */}
            <StatTile
              label="Est. cost"
              value={<span style={{ font: '500 13px/1.4 var(--font-sans)', color: 'var(--faint)' }}>Priced with billing (Phase 16)</span>}
            />
          </StatTileRow>

          <AllowanceCard quota={data.quota} report={data} currentPeriod={range === 'period'} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            <Card>
              <CardTitle hint="Per UTC day. Hover a day for detail.">Billable answers</CardTitle>
              <DailyUsageChart days={data.daily} />
            </Card>
            <BreakdownCard report={data} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <CacheCard report={data} />
            <RateLimitCard report={data} />
            <Card>
              <CardTitle hint="Daily comparison of the usage ledger against Stripe.">Billing reconciliation</CardTitle>
              <Badge>Soon</Badge>
              <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                Arrives with Stripe billing (Phase 16). The ledger it will reconcile is already being written — every
                figure on this page is read from it.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function AllowanceCard({ quota, report, currentPeriod }: { quota: QuotaStatus; report: UsageReport; currentPeriod: boolean }) {
  if (quota.state === 'unlimited') {
    return (
      <Card>
        <CardTitle>Allowance</CardTitle>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Pay-as-you-go — no answer allowance applies to this workspace. Every billable answer is metered.
        </p>
      </Card>
    );
  }

  const planName = quota.source === 'trial' ? 'the free trial' : 'your plan';
  const forecast = currentPeriod && quota.state === 'active' ? runOutForecast(quota, report) : null;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '500 20px/1 var(--font-mono)' }}>
          {quota.used.toLocaleString()} / {quota.allowance.toLocaleString()}
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>answers included in {planName}</span>
        <div style={{ flex: 1 }} />
        {quota.state === 'active' && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{quota.remaining.toLocaleString()} remaining</span>}
        {quota.state === 'exhausted' && <Badge tone="err">Allowance used up</Badge>}
        {quota.state === 'ended' && <Badge tone="warn">Period ended</Badge>}
      </div>
      <Meter percent={(quota.used / quota.allowance) * 100} />
      <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        {quota.state === 'ended'
          ? `The allowance period ended ${utcDate(quota.periodEnd, true)}. New questions are refused until a plan is active; widget visitors are handed to your team instead.`
          : quota.state === 'exhausted'
            ? `Widget visitors are being handed to your team until the period ends ${utcDate(quota.periodEnd, true)}.`
            : forecast}{' '}
        Answered and refused questions count, cached answers included; escalations caused by a failure on our side don't.
      </p>
    </Card>
  );
}

// "At the current rate the allowance runs out on …" — the prototype's line, computed from the
// real billable rate so far this period rather than written in.
function runOutForecast(quota: Exclude<QuotaStatus, { state: 'unlimited' }>, report: UsageReport): string {
  const start = new Date(quota.periodStart).getTime();
  const end = new Date(quota.periodEnd).getTime();
  const elapsedDays = Math.max((Date.now() - start) / DAY_MS, 1 / 24);
  const perDay = report.answers.billable / elapsedDays;
  if (perDay === 0) return `Period ends ${utcDate(quota.periodEnd, true)}.`;
  const runsOutAt = Date.now() + (quota.remaining / perDay) * DAY_MS;
  return runsOutAt < end
    ? `At the current rate (${perDay.toFixed(1)} a day) the allowance runs out on ${utcDate(new Date(runsOutAt).toISOString(), true)}, before the period ends.`
    : `At the current rate (${perDay.toFixed(1)} a day) it lasts until the period ends ${utcDate(quota.periodEnd, true)}.`;
}

function BreakdownCard({ report }: { report: UsageReport }) {
  const { answers, chunksEmbedded } = report;
  return (
    <Card>
      <CardTitle hint="What the meter recorded, in units. Prices — and so a cost breakdown — arrive with billing.">
        Usage breakdown
      </CardTitle>
      <Lines
        rows={[
          ['Answered', answers.byStatus.answered.toLocaleString()],
          ['Refused (no matching knowledge)', answers.byStatus.refused.toLocaleString()],
          ['Escalated (not billable)', answers.byStatus.escalated.toLocaleString()],
          ['Billable answers', <strong key="b">{answers.billable.toLocaleString()}</strong>],
          ['Chunks embedded', chunksEmbedded.total.toLocaleString()],
          ['Characters embedded', compact(chunksEmbedded.characters)],
        ]}
      />
    </Card>
  );
}

function CacheCard({ report }: { report: UsageReport }) {
  const { cacheHits, total, byStatus, totalTokens } = report.answers;
  // Tokens saved is an estimate — a cache hit makes no model call, so what it WOULD have cost
  // is inferred from the average answer that did. Labelled as such.
  const generated = Math.max(1, byStatus.answered - cacheHits);
  const avgTokens = totalTokens / generated;
  return (
    <Card>
      <CardTitle hint="Repeat questions are served from Redis instead of the model.">Answer cache</CardTitle>
      <Lines
        rows={[
          ['Mode', 'Exact match'],
          ['Hit rate', percent(cacheHits, total)],
          ['Cache hits', cacheHits.toLocaleString()],
          ['Tokens saved (est.)', cacheHits && byStatus.answered > cacheHits ? `≈ ${compact(Math.round(cacheHits * avgTokens))}` : '—'],
        ]}
      />
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        A semantic tier runs in shadow mode only: near-identical questions can need opposite answers, so it is measured,
        never served.
      </p>
    </Card>
  );
}

function RateLimitCard({ report }: { report: UsageReport }) {
  const { burst, perMinute, available } = report.rateLimit;
  return (
    <Card>
      <CardTitle hint="Per workspace, enforced in Redis.">Rate limits</CardTitle>
      <Lines
        rows={[
          ['Questions per minute (sustained)', String(perMinute)],
          ['Burst', String(burst)],
          ['Available right now', available === null ? 'Unknown' : `${available} / ${burst}`],
          ['Throttled requests', <span key="t" style={{ color: 'var(--faint)' }}>Not recorded yet</span>],
        ]}
      />
    </Card>
  );
}

function Lines({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>{label}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function rangeParams(range: Range): { from?: string; to?: string } {
  if (range === 'period') return {};
  // Whole UTC days: from the start of (today − N + 1) to the start of tomorrow.
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const days = range === '7d' ? 7 : 30;
  return { from: new Date(tomorrow - days * DAY_MS).toISOString(), to: new Date(tomorrow).toISOString() };
}
