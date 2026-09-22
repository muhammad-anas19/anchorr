'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { me, Membership } from '../auth/api';
import { ApiError } from '../../shared/api/client';
import { clearToken, getToken } from '../../shared/auth/token';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { WorkspacePicker } from './WorkspacePicker';
import { ConversationQueue } from './ConversationQueue';
import { ConversationChat } from './ConversationChat';
import { useAgentSocket } from './useAgentSocket';
import { claimConversation, ConversationTurn, getConversationDetail, resolveConversation } from './api';

export function ConsoleApp() {
  const router = useRouter();
  const [userId, setUserId] = useState<number | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { sessions, setSessions, liveMessages, joinConversation, sendAgentMessage } = useAgentSocket(workspaceId);

  // Who am I, and which workspace(s) do I belong to.
  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    me()
      .then((result) => {
        setUserId(result.userId);
        setMemberships(result.memberships);
        if (result.memberships.length === 1) {
          setWorkspaceId(result.memberships[0].workspaceId);
        }
      })
      .catch(() => {
        clearToken();
        router.replace('/login');
      });
  }, [router]);

  const openConversation = useCallback(
    async (sessionId: string) => {
      if (!workspaceId) return;
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
    if (!workspaceId) return;
    setError(null);
    try {
      await claimConversation(workspaceId, sessionId);
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, status: 'claimed', claimedByUserId: userId } : s)),
      );
      await openConversation(sessionId);
    } catch (err) {
      // A 409 here means another agent won the race (Q2/Q3/Q4) — refresh so this agent sees
      // the real, current state instead of a stale "still available" row.
      setError(err instanceof ApiError ? err.message : 'Could not claim this conversation.');
    }
  }

  async function handleResolve() {
    if (!workspaceId || !openSessionId) return;
    try {
      await resolveConversation(workspaceId, openSessionId);
      setSessions((prev) => prev.filter((s) => s.sessionId !== openSessionId));
      setOpenSessionId(null);
      setTurns([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resolve this conversation.');
    }
  }

  if (memberships.length > 1 && !workspaceId) {
    return <WorkspacePicker memberships={memberships} onSelect={setWorkspaceId} />;
  }

  return (
    <main style={{ display: 'flex', height: '100vh' }}>
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
    </main>
  );
}
