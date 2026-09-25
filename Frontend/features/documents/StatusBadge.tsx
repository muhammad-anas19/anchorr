import type { Document } from './api';

const STYLES: Record<Document['status'], { bg: string; fg: string; label: string }> = {
  uploaded: { bg: '#eef1fe', fg: '#2542b8', label: 'Queued' },
  processing: { bg: '#eef1fe', fg: '#2542b8', label: 'Processing' },
  ready: { bg: '#e7f5ee', fg: '#136c46', label: 'Ready' },
  failed: { bg: '#fdeceb', fg: '#a72118', label: 'Failed' },
};

export function StatusBadge({ status }: { status: Document['status'] }) {
  const s = STYLES[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        background: s.bg,
        color: s.fg,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
      {s.label}
    </span>
  );
}
