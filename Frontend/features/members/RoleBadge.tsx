import type { Role } from './api';

const LABELS: Record<Role, string> = { owner: 'Owner', agent: 'Agent', viewer: 'Viewer' };

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        background: '#fafafa',
        border: '1px solid #e7e7e4',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '22px',
        color: '#6b6b73',
      }}
    >
      {LABELS[role]}
    </span>
  );
}
