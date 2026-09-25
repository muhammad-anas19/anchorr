import { query, request } from '../../shared/api/client';

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
  minDistance: number | null;
  createdAt: string;
}

// Mirrors the Backend's QueueRow. Duplicated by hand rather than imported — this project has
// no shared package between Backend/ and Frontend/ by an explicit early decision.
export interface QueueRow {
  sessionId: string;
  status: ConversationSession['status'];
  claimedByUserId: number | null;
  claimedByEmail: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  topic: string | null;
  turnCount: number;
  waitingSeconds: number;
  priority: 'high' | 'normal';
  reason: 'Low confidence' | 'Generation failure' | 'Unknown';
  lastTurnStatus: ConversationTurn['status'] | null;
  lastTurnMinDistance: number | null;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface QueueStats {
  waiting: number;
  active: number;
  resolved: number;
  resolvedToday: number;
  longestWaitSeconds: number;
  agentsOnline: number;
}

export interface AgentPresenceRow {
  userId: number;
  email: string;
  role: string;
  online: boolean;
  activeCount: number;
}

export interface EscalationReason {
  label: string;
  count: number;
  percent: number;
}

export type QueueTab = 'waiting' | 'active' | 'resolved' | 'all';
export type QueuePriority = 'high' | 'normal';

export interface QueueParams {
  tab?: QueueTab;
  search?: string;
  priority?: QueuePriority | '';
  page?: number;
  pageSize?: number;
}

// `signal` is threaded through so a superseded request (a newer keystroke) can be aborted
// rather than left in flight to resolve late and overwrite fresher results.
export function listQueue(
  workspaceId: number,
  params: QueueParams,
  signal?: AbortSignal,
): Promise<OffsetPage<QueueRow>> {
  return request(`/workspaces/${workspaceId}/handoff/queue${query({ ...params })}`, { signal });
}

export function getQueueStats(workspaceId: number, signal?: AbortSignal): Promise<QueueStats> {
  return request(`/workspaces/${workspaceId}/handoff/stats`, { signal });
}

export function getPresence(workspaceId: number, signal?: AbortSignal): Promise<AgentPresenceRow[]> {
  return request(`/workspaces/${workspaceId}/handoff/presence`, { signal });
}

export function getEscalationReasons(workspaceId: number, signal?: AbortSignal): Promise<EscalationReason[]> {
  return request(`/workspaces/${workspaceId}/handoff/escalation-reasons`, { signal });
}

export function listTurns(
  workspaceId: number,
  sessionId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<CursorPage<ConversationTurn>> {
  return request(`/workspaces/${workspaceId}/handoff/${sessionId}/turns${query({ ...params })}`);
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
