'use client';

import { Card, CardTitle, EmptyState, Meter } from '../../shared/ui/primitives';
import type { EscalationReason } from './api';

export function EscalationReasons({ reasons }: { reasons: EscalationReason[] | null }) {
  const total = reasons?.reduce((sum, r) => sum + r.count, 0) ?? 0;

  return (
    <Card>
      <CardTitle hint="Last 30 days">Escalation reasons</CardTitle>
      {!reasons && <EmptyState>Loading…</EmptyState>}
      {reasons && total === 0 && <EmptyState>No escalations in the last 30 days.</EmptyState>}
      {reasons && total > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {reasons.map((reason) => (
            <div key={reason.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span>{reason.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{reason.percent}%</span>
              </div>
              <Meter percent={reason.percent} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
