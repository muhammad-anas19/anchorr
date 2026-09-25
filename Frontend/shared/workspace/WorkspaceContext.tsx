'use client';

import { createContext, useContext } from 'react';
import type { Membership } from '../../features/auth/api';

export interface WorkspaceContextValue {
  workspaceId: number;
  role: Membership['role'];
  workspaceName: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: React.ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// Every dashboard page (documents, widget settings, team, playground, console) reads its
// workspaceId this way instead of re-implementing "which workspace am I in" — that logic
// lives exactly once, in DashboardShell.
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace() called outside a DashboardShell.');
  }
  return ctx;
}
