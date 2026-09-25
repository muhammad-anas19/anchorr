'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { me, Membership } from '../../features/auth/api';
import { clearToken, getToken } from '../auth/token';
import { WorkspaceProvider } from './WorkspaceContext';
import { WorkspacePicker } from './WorkspacePicker';
import { Sidebar } from './Sidebar';

// The one place "which workspace am I in" gets resolved for every dashboard page — loads
// me(), lets the user pick a workspace if they belong to more than one, and renders the
// sidebar every dashboard route shares.
export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);

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

  function handleLogout() {
    clearToken();
    router.replace('/login');
  }

  if (!memberships || !userEmail) return null;

  if (!workspaceId) {
    return <WorkspacePicker memberships={memberships} onSelect={setWorkspaceId} />;
  }

  const current = memberships.find((m) => m.workspaceId === workspaceId)!;

  return (
    <WorkspaceProvider value={{ workspaceId, role: current.role, workspaceName: current.workspaceName }}>
      <div style={{ display: 'flex', height: '100vh' }}>
        <Sidebar workspaceName={current.workspaceName} userEmail={userEmail} role={current.role} onLogout={handleLogout} />
        <main style={{ flex: 1, overflowY: 'auto' }}>{children}</main>
      </div>
    </WorkspaceProvider>
  );
}
