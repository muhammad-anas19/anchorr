'use client';

import { usePathname } from 'next/navigation';
import { Icon } from '../ui/Icon';
import { Dot } from '../ui/primitives';

const CRUMBS: Record<string, string> = {
  '/console': 'Agent console',
  '/documents': 'Knowledge',
  '/playground': 'AI Playground',
  '/team': 'Team',
  '/widget': 'Widget',
};

// widgetLive is null when this user cannot know: the widget-settings endpoint is owner-only,
// so an agent has no way to read the allowlist. Rendering nothing is correct there — better
// than showing a state we did not actually check.
export function TopBar({ workspaceName, widgetLive }: { workspaceName: string; widgetLive: boolean | null }) {
  const pathname = usePathname() ?? '';
  const crumb = Object.entries(CRUMBS).find(([href]) => pathname.startsWith(href))?.[1] ?? '';

  return (
    <header
      style={{
        height: 56,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      <div style={{ font: '500 13px/1 var(--font-sans)', color: 'var(--muted)' }}>{workspaceName}</div>
      <div style={{ color: 'var(--faint)' }}>/</div>
      <div style={{ font: '600 13px/1 var(--font-sans)', color: 'var(--fg)' }}>{crumb}</div>
      <div style={{ flex: 1 }} />

      {/* Reflects whether this workspace has any allowed origin configured — an empty
          allowlist means the gateway rejects every widget connection (it fails closed), so
          the widget genuinely is not live. Not a decorative badge. */}
      {widgetLive !== null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 9px',
            borderRadius: 6,
            background: widgetLive ? 'var(--ok-soft)' : 'var(--surface-2)',
            color: widgetLive ? 'var(--ok)' : 'var(--faint)',
            font: '500 12px/1 var(--font-sans)',
          }}
        >
          {widgetLive ? <Dot tone="ok" pulse /> : <Dot tone="neutral" />}
          {widgetLive ? 'Widget live' : 'Widget not configured'}
        </div>
      )}

      {/* The prototype's command palette. There is no search backend behind it, so it is
          rendered disabled rather than as an input that silently does nothing. */}
      <div
        title="Global search — not built yet"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          padding: '0 10px',
          border: '1px solid var(--border)',
          borderRadius: 7,
          color: 'var(--faint)',
          font: '400 12.5px/1 var(--font-sans)',
          minWidth: 180,
        }}
      >
        <Icon name="search" size={13} strokeWidth={1.6} />
        Search
        <span style={{ flex: 1 }} />
        <span style={{ font: '500 11px/1 var(--font-mono)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}>
          ⌘K
        </span>
      </div>
    </header>
  );
}
