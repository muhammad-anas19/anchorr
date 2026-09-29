'use client';

import { TONE_COLORS, type Tone } from '../../shared/ui/primitives';
import type { TimelineState } from '../../shared/ui/Timeline';
import type { Invitation, InvitationStatus } from './api';
import { invitationStages } from './lifecycle';

const STATE_TONE: Record<TimelineState, Tone> = {
  done: 'ok',
  active: 'accent',
  pending: 'neutral',
  failed: 'err',
  skipped: 'neutral',
};

const SHORT_LABELS = ['Created', 'Email', 'Accepted'];

// The same stages as the full Timeline, squeezed into a table cell: three segments that fill
// in as the invitation moves along. Built from invitationStages(), so the row and the details
// view can never disagree about where an invitation is.
export function InvitationProgress({ invitation }: { invitation: Invitation }) {
  const stages = invitationStages(invitation);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} aria-label={describe(stages.map((s) => s.state))}>
      {stages.map((stage, index) => {
        const tone = STATE_TONE[stage.state];
        return (
          <div key={stage.key} title={typeof stage.title === 'string' ? stage.title : undefined} style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                height: 5,
                borderRadius: 3,
                background: stage.state === 'pending' || stage.state === 'skipped' ? 'var(--track)' : TONE_COLORS[tone].fg,
                opacity: stage.state === 'active' ? 0.55 : 1,
                animation: stage.state === 'active' ? 'anc-pulse 1.6s infinite' : undefined,
              }}
            />
            <div style={{ marginTop: 4, font: '500 10px/1 var(--font-sans)', color: 'var(--faint)' }}>{SHORT_LABELS[index]}</div>
          </div>
        );
      })}
    </div>
  );
}

function describe(states: TimelineState[]): string {
  return SHORT_LABELS.map((label, i) => `${label}: ${states[i]}`).join(', ');
}

const STATUS_TONE: Record<InvitationStatus, Tone> = {
  pending: 'accent',
  expired: 'warn',
  accepted: 'ok',
  revoked: 'neutral',
};

export function invitationStatusTone(status: InvitationStatus): Tone {
  return STATUS_TONE[status];
}
