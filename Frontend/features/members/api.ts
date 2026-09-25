import { request } from '../../shared/api/client';

export type Role = 'owner' | 'agent' | 'viewer';

export interface TeamMember {
  userId: number;
  email: string;
  role: Role;
}

export function listMembers(workspaceId: number): Promise<TeamMember[]> {
  return request(`/workspaces/${workspaceId}/members`);
}

export function updateMemberRole(workspaceId: number, userId: number, role: Role): Promise<{ userId: number; role: Role }> {
  return request(`/workspaces/${workspaceId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}
