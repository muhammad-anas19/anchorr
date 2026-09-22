import { request } from '../../shared/api/client';

export interface ConversationSession {
  id: number;
  workspaceId: number;
  sessionId: string;
  status: 'open' | 'escalated' | 'claimed' | 'resolved';
  claimedByUserId: number | null;
  claimedAt: string | null;
  createdAt: string;
}

export interface ConversationTurn {
  id: number;
  question: string;
  answer: string;
  status: 'answered' | 'refused' | 'escalated';
  createdAt: string;
}

export function listActiveConversations(workspaceId: number): Promise<ConversationSession[]> {
  return request(`/workspaces/${workspaceId}/handoff`);
}

export function getConversationDetail(
  workspaceId: number,
  sessionId: string,
): Promise<{ session: ConversationSession; turns: ConversationTurn[] }> {
  return request(`/workspaces/${workspaceId}/handoff/${sessionId}`);
}

export function claimConversation(workspaceId: number, sessionId: string): Promise<ConversationSession> {
  return request(`/workspaces/${workspaceId}/handoff/${sessionId}/claim`, { method: 'PATCH' });
}

export function resolveConversation(workspaceId: number, sessionId: string): Promise<ConversationSession> {
  return request(`/workspaces/${workspaceId}/handoff/${sessionId}/resolve`, { method: 'PATCH' });
}
