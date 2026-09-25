'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href?: string;
  label: string;
  badge?: string;
}

// Every section from the actual prototype design is listed here, even the ones with no
// backend behind them yet — shown, not hidden, but disabled and unlinked rather than faked
// with mock data. Only entries with a real `href` (a real backend + page) are clickable.
const MAIN_ITEMS: NavItem[] = [
  { label: 'Overview' },
  { label: 'Conversations' },
  { href: '/documents', label: 'Knowledge' },
  { href: '/playground', label: 'AI Playground' },
  { href: '/console', label: 'Agent console' },
];

const MEASURE_ITEMS: NavItem[] = [{ label: 'Analytics' }, { label: 'Evaluations' }, { label: 'Usage & cost' }];

const DEPLOY_ITEMS: NavItem[] = [
  { href: '/widget', label: 'Widget' },
  { label: 'Billing' },
  { href: '/team', label: 'Team' },
  { label: 'Onboarding' },
];

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active = item.href ? pathname?.startsWith(item.href) : false;

  if (!item.href) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 8px',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          color: '#c4c4c9',
          cursor: 'default',
        }}
        title="Not built yet"
      >
        <span>{item.label}</span>
        <span style={{ fontSize: 10, fontWeight: 600 }}>Soon</span>
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 8px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        textDecoration: 'none',
        color: active ? '#111827' : '#6b6b73',
        background: active ? '#eef1fe' : 'transparent',
        marginBottom: 2,
      }}
    >
      <span>{item.label}</span>
      {item.badge && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#2542b8',
            background: '#eef1fe',
            borderRadius: 10,
            padding: '1px 6px',
          }}
        >
          {item.badge}
        </span>
      )}
    </Link>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: '#c4c4c9', padding: '14px 8px 6px' }}>
      {children}
    </div>
  );
}

export function Sidebar({
  workspaceName,
  userEmail,
  role,
  onLogout,
}: {
  workspaceName: string;
  userEmail: string;
  role: string;
  onLogout: () => void;
}) {
  return (
    <nav
      style={{
        width: 208,
        flex: 'none',
        borderRight: '1px solid #e7e7e4',
        background: '#fafafa',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 10px',
      }}
    >
      <div style={{ padding: '0 8px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Anchor</div>
        <div style={{ fontSize: 11.5, color: '#9a9aa2', marginTop: 2 }}>{workspaceName}</div>
      </div>

      {MAIN_ITEMS.map((item) => (
        <NavLink key={item.label} item={item} />
      ))}

      <SectionLabel>Measure</SectionLabel>
      {MEASURE_ITEMS.map((item) => (
        <NavLink key={item.label} item={item} />
      ))}

      <SectionLabel>Deploy</SectionLabel>
      {DEPLOY_ITEMS.map((item) => (
        <NavLink key={item.label} item={item} />
      ))}

      <div style={{ flex: 1 }} />

      <div style={{ borderTop: '1px solid #e7e7e4', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: '#eef1fe',
            color: '#2542b8',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 600,
            flex: 'none',
          }}
        >
          {userEmail.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {userEmail}
          </div>
          <div style={{ fontSize: 11, color: '#9a9aa2', textTransform: 'capitalize' }}>{role}</div>
        </div>
        <button
          onClick={onLogout}
          title="Sign out"
          style={{ border: 'none', background: 'transparent', color: '#9a9aa2', cursor: 'pointer', fontSize: 12 }}
        >
          ↩
        </button>
      </div>
    </nav>
  );
}
