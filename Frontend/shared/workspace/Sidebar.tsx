'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar } from '../ui/primitives';
import { useTheme } from '../theme/ThemeProvider';

interface NavItem {
  icon: IconName;
  label: string;
  href?: string;
  badge?: number;
}

// Every section the prototype's nav has, in its order, with its icon. Entries with no `href`
// have no backend behind them yet: shown (so the product's shape is honest) but visibly
// disabled rather than wired to a page that would have to invent its data.
const SECTIONS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { icon: 'overview', label: 'Overview' },
      { icon: 'conversations', label: 'Conversations' },
      { icon: 'knowledge', label: 'Knowledge', href: '/documents' },
      { icon: 'playground', label: 'AI Playground', href: '/playground' },
      { icon: 'agents', label: 'Agent console', href: '/console' },
    ],
  },
  {
    title: 'Measure',
    items: [
      { icon: 'analytics', label: 'Analytics' },
      { icon: 'evaluations', label: 'Evaluations' },
      { icon: 'usage', label: 'Usage & cost' },
    ],
  },
  {
    title: 'Deploy',
    items: [
      { icon: 'widget', label: 'Widget', href: '/widget' },
      { icon: 'billing', label: 'Billing' },
      { icon: 'settings', label: 'Team', href: '/team' },
      { icon: 'onboarding', label: 'Onboarding' },
    ],
  },
];

export function Sidebar({
  workspaceName,
  userEmail,
  role,
  expanded,
  onToggle,
  onLogout,
  waitingCount,
}: {
  workspaceName: string;
  userEmail: string;
  role: string;
  expanded: boolean;
  onToggle: () => void;
  onLogout: () => void;
  waitingCount?: number;
}) {
  const pathname = usePathname();
  const { toggle: toggleTheme } = useTheme();

  return (
    <aside
      style={{
        width: expanded ? 208 : 56,
        flex: 'none',
        borderRight: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .18s ease',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 56,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            flex: 'none',
            borderRadius: 7,
            background: 'var(--btn-bg)',
            color: 'var(--btn-fg)',
            display: 'grid',
            placeItems: 'center',
            font: "700 13px/1 var(--font-sans)",
          }}
        >
          A
        </div>
        {expanded && (
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, letterSpacing: '-.01em' }}>Anchor</div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--faint)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {workspaceName}
            </div>
          </div>
        )}
        <button
          onClick={onToggle}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          className="anc-icon-btn"
          style={{
            width: 26,
            height: 26,
            flex: 'none',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--muted)',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Icon name="sidebarToggle" size={13} strokeWidth={1.6} />
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {SECTIONS.map((section, sectionIndex) => (
          <div key={section.title ?? sectionIndex} style={{ display: 'contents' }}>
            {section.title && expanded && (
              <div
                style={{
                  font: '600 10px/1 var(--font-sans)',
                  letterSpacing: '.09em',
                  textTransform: 'uppercase',
                  color: 'var(--faint)',
                  padding: '16px 8px 6px',
                }}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => (
              <NavRow
                key={item.label}
                item={item}
                expanded={expanded}
                active={!!item.href && pathname?.startsWith(item.href)}
                badge={item.label === 'Agent console' ? waitingCount : undefined}
              />
            ))}
          </div>
        ))}
      </nav>

      <div style={{ flex: 'none', borderTop: '1px solid var(--border)', padding: 8 }}>
        {expanded && (
          <div
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '7px 8px',
              borderRadius: 7,
            }}
          >
            <Avatar label={userEmail} size={24} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  font: '500 12.5px/1.2 var(--font-sans)',
                  color: 'var(--fg)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {userEmail}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', textTransform: 'capitalize' }}>{role}</div>
            </div>
            <button
              onClick={onLogout}
              aria-label="Sign out"
              className="anc-icon-btn"
              style={{ border: 0, background: 'transparent', color: 'var(--faint)', display: 'grid', placeItems: 'center' }}
            >
              <Icon name="logout" size={14} strokeWidth={1.6} />
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, paddingTop: 6, justifyContent: expanded ? 'flex-start' : 'center' }}>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="anc-icon-btn"
            style={{
              width: 28,
              height: 28,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              borderRadius: 7,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted)',
            }}
          >
            <Icon name="moon" size={14} />
          </button>
          {!expanded && (
            <button
              onClick={onLogout}
              aria-label="Sign out"
              className="anc-icon-btn"
              style={{
                width: 28,
                height: 28,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                borderRadius: 7,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--muted)',
              }}
            >
              <Icon name="logout" size={14} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function NavRow({
  item,
  expanded,
  active,
  badge,
}: {
  item: NavItem;
  expanded: boolean;
  active: boolean;
  badge?: number;
}) {
  const content = (
    <>
      <Icon name={item.icon} size={15} />
      {expanded && <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{item.label}</span>}
      {expanded && badge !== undefined && badge > 0 && (
        <span
          style={{
            font: '600 11px/1 var(--font-mono)',
            color: 'var(--err)',
            background: 'var(--err-soft)',
            padding: '3px 5px',
            borderRadius: 5,
          }}
        >
          {badge}
        </span>
      )}
      {expanded && !item.href && <span style={{ font: '500 10px/1 var(--font-sans)', color: 'var(--faint)' }}>Soon</span>}
    </>
  );

  const base = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 32,
    padding: '0 8px',
    border: 0,
    borderRadius: 7,
    font: '500 13px/1 var(--font-sans)',
    textAlign: 'left' as const,
    width: '100%',
  };

  if (!item.href) {
    return (
      <div
        title={`${item.label} — not built yet`}
        style={{ ...base, background: 'transparent', color: 'var(--faint)', cursor: 'default' }}
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      title={expanded ? undefined : item.label}
      className={active ? undefined : 'anc-nav-item'}
      style={{
        ...base,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent-fg)' : 'var(--fg)',
        textDecoration: 'none',
      }}
    >
      {content}
    </Link>
  );
}
