import { request } from '../../shared/api/client';
import type { SessionTokens } from '../../shared/auth/token';

export interface Membership {
  workspaceId: number;
  workspaceName: string;
  role: 'owner' | 'agent' | 'viewer';
  // The keys this role holds in this workspace (e.g. 'members.invite'), straight from the
  // server's role_permissions — the UI decides what to show from these, not from the role name.
  permissions: string[];
}

export function login(email: string, password: string): Promise<SessionTokens> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function register(
  email: string,
  password: string,
  workspaceName: string,
): Promise<SessionTokens> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, workspaceName }),
  });
}

export function me(): Promise<{ userId: number; email: string; memberships: Membership[] }> {
  return request('/auth/me');
}
