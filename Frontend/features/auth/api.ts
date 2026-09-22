import { request } from '../../shared/api/client';

export interface Membership {
  workspaceId: number;
  workspaceName: string;
  role: 'owner' | 'agent' | 'viewer';
}

export function login(email: string, password: string): Promise<{ accessToken: string }> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function register(
  email: string,
  password: string,
  workspaceName: string,
): Promise<{ accessToken: string }> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, workspaceName }),
  });
}

export function me(): Promise<{ userId: number; memberships: Membership[] }> {
  return request('/auth/me');
}
