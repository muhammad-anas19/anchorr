import { ConversationSessionStatus } from '../../database/entities/conversation-session-status.enum';
import { ConversationStatus } from '../../database/entities/conversation-status.enum';

// Waiting longer than this marks a queued session High priority. There is no stored priority
// column and no product rule that defines one — this is a transparent derivation from real
// wait time, named here rather than buried in a query, so it can be tuned in one place and is
// never mistaken for a field a human set.
export const HIGH_PRIORITY_WAIT_SECONDS = 180;

export interface QueueRow {
  sessionId: string;
  status: ConversationSessionStatus;
  claimedByUserId: number | null;
  claimedByEmail: string | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  // The session's most recent question — what the conversation is actually about. Null only
  // if a session row somehow exists with no turns logged against it.
  topic: string | null;
  turnCount: number;
  waitingSeconds: number;
  priority: 'high' | 'normal';
  // Derived from the last turn's real outcome, not a stored field: a refused turn means
  // retrieval was too weak, an escalated turn means generation itself failed.
  reason: 'Low confidence' | 'Generation failure' | 'Unknown';
  lastTurnStatus: ConversationStatus | null;
  lastTurnMinDistance: number | null;
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
