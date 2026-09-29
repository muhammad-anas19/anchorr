'use client';

import { createContext, useContext } from 'react';
import type { Membership } from '../../features/auth/api';

export interface WorkspaceContextValue {
  workspaceId: number;
  role: Membership['role'];
  workspaceName: string;
  userId: number;
  permissions: string[];
  // What the UI shows or hides. Never what stops anyone: every one of these is checked again on
  // the server for every request. Hiding a button only spares the user a click that would 403.
  can: (permission: string) => boolean;
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
