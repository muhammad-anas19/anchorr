import { query, request } from '../../shared/api/client';
import type { Page, Role } from '../members/api';

// 'expired' is never stored — the server derives it from expiresAt on every read.
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

// 'sent' means the recipient's mail server accepted the message. It is the most SMTP ever
// reports: not "in the inbox", not "read".
export type EmailStatus = 'queued' | 'sent' | 'failed';

export interface Invitation {
  id: number;
  email: string;
  role: Role;
  status: InvitationStatus;
  invitedByEmail: string | null;
  expiresAt: string;
  lastSentAt: string;
  sendCount: number;
  createdAt: string;
  acceptedAt: string | null;
  acceptedByEmail: string | null;
  revokedAt: string | null;
  emailStatus: EmailStatus;
  emailSentAt: string | null;
  emailLastError: string | null;
}

// --- The inviter's side (workspace-scoped, needs members.invite) ---------------------------

export function createInvitation(workspaceId: number, email: string, role: Role): Promise<Invitation> {
  return request(`/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

export function listInvitations(
  workspaceId: number,
  params: { page: number; pageSize: number; status?: InvitationStatus; search?: string },
  signal?: AbortSignal,
): Promise<Page<Invitation>> {
  return request(`/workspaces/${workspaceId}/invitations${query(params)}`, { signal });
}

export function getInvitation(workspaceId: number, invitationId: number, signal?: AbortSignal): Promise<Invitation> {
  return request(`/workspaces/${workspaceId}/invitations/${invitationId}`, { signal });
}

export function resendInvitation(workspaceId: number, invitationId: number): Promise<Invitation> {
  return request(`/workspaces/${workspaceId}/invitations/${invitationId}/resend`, { method: 'POST' });
}

export function revokeInvitation(workspaceId: number, invitationId: number): Promise<Invitation> {
  return request(`/workspaces/${workspaceId}/invitations/${invitationId}`, { method: 'DELETE' });
}

// --- The invitee's side (token-authorized; no workspace yet) --------------------------------

export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  expiresAt: string;
  status: InvitationStatus;
  accountExists: boolean;
}

export interface AcceptedMembership {
  workspaceId: number;
  role: Role;
  alreadyMember: boolean;
}

// The token always travels in a POST body, never a URL — see the backend's InvitationTokenDto.
export function previewInvitation(token: string): Promise<InvitationPreview> {
  return request('/invitations/preview', { method: 'POST', body: JSON.stringify({ token }) });
}

export function acceptInvitation(token: string): Promise<AcceptedMembership> {
  return request('/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) });
}

export function acceptInvitationWithSignup(
  token: string,
  password: string,
): Promise<AcceptedMembership & { accessToken: string; refreshToken: string }> {
  return request('/invitations/accept-signup', { method: 'POST', body: JSON.stringify({ token, password }) });
}
