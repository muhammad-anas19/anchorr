'use client';

import { useCallback, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { ConversationQueue } from './ConversationQueue';
import { ConversationChat } from './ConversationChat';
import { useAgentSocket } from './useAgentSocket';
import { claimConversation, ConversationTurn, getConversationDetail, resolveConversation } from './api';

export function ConsoleApp() {
  const { workspaceId } = useWorkspace();
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { sessions, setSessions, liveMessages, joinConversation, sendAgentMessage } = useAgentSocket(workspaceId);

  const openConversation = useCallback(
    async (sessionId: string) => {
      setError(null);
      try {
        const detail = await getConversationDetail(workspaceId, sessionId);
        setTurns(detail.turns);
        setOpenSessionId(sessionId);
        joinConversation(sessionId);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not open this conversation.');
      }
    },
    [workspaceId, joinConversation],
  );

  async function handleClaim(sessionId: string) {
    setError(null);
    try {
      const claimed = await claimConversation(workspaceId, sessionId);
      setSessions((prev) => prev.map((s) => (s.sessionId === sessionId ? claimed : s)));
      await openConversation(sessionId);
    } catch (err) {
      // A 409 here means another agent won the race (Q2/Q3/Q4) — the error banner is the
      // real, current state; this agent's own stale "still available" row is now wrong.
      setError(err instanceof ApiError ? err.message : 'Could not claim this conversation.');
    }
  }

  async function handleResolve() {
    if (!openSessionId) return;
    try {
      await resolveConversation(workspaceId, openSessionId);
      setSessions((prev) => prev.filter((s) => s.sessionId !== openSessionId));
      setOpenSessionId(null);
      setTurns([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resolve this conversation.');
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ConversationQueue
        sessions={sessions}
        openSessionId={openSessionId}
        onOpen={openConversation}
        onClaim={handleClaim}
      />
      <section style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <ErrorBanner message={error} />
        {!openSessionId && (
          <div style={{ margin: 'auto', color: '#9ca3af' }}>Claim or open a conversation to see it here.</div>
        )}
        {openSessionId && (
          <ConversationChat
            sessionId={openSessionId}
            turns={turns}
            liveMessages={liveMessages}
            onSend={(message) => sendAgentMessage(openSessionId, message)}
            onResolve={handleResolve}
          />
        )}
      </section>
    </div>
  );
}
