'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectAgentSocket } from '../../shared/socket/connectAgentSocket';
import { getToken } from '../../shared/auth/token';

export interface LiveMessage {
  from: 'customer' | 'agent' | 'ai';
  text: string;
}

// Owns the one agent socket connection for a workspace. It no longer holds the queue itself:
// the queue is server-paginated and filtered now, so patching a local copy on every event
// would fight the current page/filter. Instead an event just signals "the queue changed" and
// the panels refetch what they are actually showing.
export function useAgentSocket(workspaceId: number | null, onQueueChanged: () => void) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);

  // Held in a ref so the effect below depends only on workspaceId — a parent passing an
  // inline callback must not tear down and rebuild the socket on every render.
  const onQueueChangedRef = useRef(onQueueChanged);
  onQueueChangedRef.current = onQueueChanged;

  useEffect(() => {
    if (!workspaceId) return;
    const token = getToken();
    if (!token) return;

    const agentSocket = connectAgentSocket(token, workspaceId);
    setSocket(agentSocket);

    const changed = () => onQueueChangedRef.current();
    // 'ready' fires only after the gateway's async handleConnection has finished registering
    // this socket in AgentPresenceService. Refetching here is what stops the page from
    // showing "1 agent online" in the header while the presence list still says Offline —
    // the panels were fetched before this connection existed.
    agentSocket.on('ready', changed);
    agentSocket.on('session-escalated', changed);
    agentSocket.on('session-claimed', changed);
    agentSocket.on('session-resolved', changed);
    agentSocket.on('customer-message', (payload: { question: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'customer', text: payload.question }]);
    });
    agentSocket.on('agent-message', (payload: { message: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'agent', text: payload.message }]);
    });
    agentSocket.on('answer', (payload: { answer: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'ai', text: payload.answer }]);
    });

    return () => {
      agentSocket.disconnect();
    };
  }, [workspaceId]);

  const joinConversation = useCallback(
    (sessionId: string) => {
      setLiveMessages([]);
      socket?.emit('join-conversation', { sessionId });
    },
    [socket],
  );

  const sendAgentMessage = useCallback(
    (sessionId: string, message: string) => {
      socket?.emit('agent-message', { sessionId, message });
    },
    [socket],
  );

  return { liveMessages, joinConversation, sendAgentMessage };
}
