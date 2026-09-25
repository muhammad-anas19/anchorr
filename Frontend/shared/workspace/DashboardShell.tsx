'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { me, Membership } from '../../features/auth/api';
import { getWidgetSettings } from '../../features/widgetSettings/api';
import { clearToken, getToken } from '../auth/token';
import { WorkspaceProvider } from './WorkspaceContext';
import { WorkspacePicker } from './WorkspacePicker';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const RAIL_KEY = 'anchor.sidebarExpanded';

// The one place "which workspace am I in" gets resolved for every dashboard page — loads
// me(), lets the user pick a workspace if they belong to more than one, and renders the
// chrome (sidebar + top bar) every dashboard route shares.
export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [widgetLive, setWidgetLive] = useState<boolean | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    me()
      .then((result) => {
        setMemberships(result.memberships);
        setUserEmail(result.email);
        if (result.memberships.length === 1) {
          setWorkspaceId(result.memberships[0].workspaceId);
        }
      })
      .catch(() => {
        clearToken();
        router.replace('/login');
      });
  }, [router]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(RAIL_KEY);
      if (stored !== null) setExpanded(stored === 'true');
    } catch {
      // Blocked site data — the rail just starts expanded.
    }
  }, []);

  const current = memberships?.find((m) => m.workspaceId === workspaceId) ?? null;

  useEffect(() => {
    // Owner-only endpoint: an agent cannot read the allowlist, so for them the badge stays
    // null (unknown) rather than guessing at a state.
    if (!workspaceId || current?.role !== 'owner') return;
    let cancelled = false;
    getWidgetSettings(workspaceId)
      .then((settings) => {
        if (!cancelled) setWidgetLive(settings.allowedOrigins.length > 0);
      })
      .catch(() => {
        if (!cancelled) setWidgetLive(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, current?.role]);

  const toggleRail = useCallback(() => {
    setExpanded((value) => {
      try {
        window.localStorage.setItem(RAIL_KEY, String(!value));
      } catch {
        // Same as above — the toggle still works without persistence.
      }
      return !value;
    });
  }, []);

  function handleLogout() {
    clearToken();
    router.replace('/login');
  }

  if (!memberships || !userEmail) return null;

  if (!workspaceId || !current) {
    return <WorkspacePicker memberships={memberships} onSelect={setWorkspaceId} />;
  }

  return (
    <WorkspaceProvider value={{ workspaceId, role: current.role, workspaceName: current.workspaceName }}>
      <div style={{ display: 'flex', height: '100vh', minHeight: 640, overflow: 'hidden' }}>
        <Sidebar
          workspaceName={current.workspaceName}
          userEmail={userEmail}
          role={current.role}
          expanded={expanded}
          onToggle={toggleRail}
          onLogout={handleLogout}
        />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <TopBar workspaceName={current.workspaceName} widgetLive={widgetLive} />
          <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
        </main>
      </div>
    </WorkspaceProvider>
  );
}
