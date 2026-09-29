import { query, request } from '../../shared/api/client';

export type Role = 'owner' | 'agent' | 'viewer';

export interface TeamMember {
  userId: number;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RolePermissions {
  role: Role;
  permissions: { key: string; description: string }[];
}

// Mirrors the server's ROLE_RANK, used only to grey out roles above your own in the invite
// form. The server enforces the same ceiling regardless of what this says.
export const ROLE_RANK: Record<Role, number> = { viewer: 1, agent: 2, owner: 3 };

export function listMembers(
  workspaceId: number,
  params: { page: number; pageSize: number; search?: string; role?: Role },
  signal?: AbortSignal,
): Promise<Page<TeamMember>> {
  return request(`/workspaces/${workspaceId}/members${query(params)}`, { signal });
}

export function listRoles(workspaceId: number): Promise<RolePermissions[]> {
  return request(`/workspaces/${workspaceId}/roles`);
}

export function updateMemberRole(workspaceId: number, userId: number, role: Role): Promise<{ userId: number; role: Role }> {
  return request(`/workspaces/${workspaceId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export function removeMember(workspaceId: number, userId: number): Promise<{ userId: number; removed: true }> {
  return request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
}

export function leaveWorkspace(workspaceId: number): Promise<{ workspaceId: number; left: true }> {
  return request(`/workspaces/${workspaceId}/leave`, { method: 'POST' });
}

export function transferOwnership(
  workspaceId: number,
  userId: number,
): Promise<{ newOwnerUserId: number; previousOwnerUserId: number; previousOwnerRole: Role }> {
  return request(`/workspaces/${workspaceId}/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}
