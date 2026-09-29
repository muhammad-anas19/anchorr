'use client';

import { Icon, type IconName } from './Icon';

// A square, icon-only action button for table rows. The label is required: an icon alone
// means nothing to a screen reader, and the same text doubles as the hover tooltip.
export function IconButton({
  label,
  icon,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={disabled ? undefined : 'anc-icon-btn'}
      style={{
        width: 28,
        height: 28,
        display: 'grid',
        placeItems: 'center',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--surface)',
        color: danger ? 'var(--err)' : 'var(--muted)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
