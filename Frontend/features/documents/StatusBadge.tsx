import { TONE_COLORS, type Tone } from '../../shared/ui/primitives';
import type { Document } from './api';

const STATUS: Record<Document['status'], { tone: Tone; label: string }> = {
  uploaded: { tone: 'accent', label: 'Queued' },
  processing: { tone: 'accent', label: 'Processing' },
  ready: { tone: 'ok', label: 'Ready' },
  failed: { tone: 'err', label: 'Failed' },
};

export function StatusBadge({ status }: { status: Document['status'] }) {
  const { tone, label } = STATUS[status];
  const { bg, fg } = TONE_COLORS[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        background: bg,
        color: fg,
        font: '500 12px/1 var(--font-sans)',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'currentColor',
          // A document mid-pipeline is genuinely still changing; the pulse says so without
          // needing another column.
          animation: status === 'processing' ? 'anc-pulse 1.8s infinite' : undefined,
        }}
      />
      {label}
    </span>
  );
}
