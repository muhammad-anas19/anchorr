import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectAgentSocket } from '../../shared/socket/connectAgentSocket';
import { getToken } from '../../shared/auth/token';
import { ConversationSession, listActiveConversations } from './api';

export interface LiveMessage {
  from: 'customer' | 'agent' | 'ai';
  text: string;
}

// Owns the one agent socket connection for a workspace: keeps the escalated/claimed queue
// live via the agents:{workspaceId} room (Phase 12), and collects whatever's been broadcast
// into whichever conversation room this agent has joined via join-conversation.
export function useAgentSocket(workspaceId: number | null) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);

  useEffect(() => {
    if (!workspaceId) return;
    const token = getToken();
    if (!token) return;

    const agentSocket = connectAgentSocket(token, workspaceId);
    setSocket(agentSocket);

    const refreshQueue = () => {
      listActiveConversations(workspaceId).then(setSessions).catch(() => {});
    };

    agentSocket.on('session-escalated', refreshQueue);
    agentSocket.on('session-claimed', (payload: { sessionId: string; claimedByUserId: number }) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === payload.sessionId
            ? { ...s, status: 'claimed', claimedByUserId: payload.claimedByUserId }
            : s,
        ),
      );
    });
    agentSocket.on('session-resolved', (payload: { sessionId: string }) => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== payload.sessionId));
    });
    agentSocket.on('customer-message', (payload: { question: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'customer', text: payload.question }]);
    });
    agentSocket.on('agent-message', (payload: { message: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'agent', text: payload.message }]);
    });
    agentSocket.on('answer', (payload: { answer: string }) => {
      setLiveMessages((prev) => [...prev, { from: 'ai', text: payload.answer }]);
    });

    refreshQueue();

    return () => {
      agentSocket.disconnect();
    };
  }, [workspaceId]);

  function joinConversation(sessionId: string) {
    setLiveMessages([]);
    socket?.emit('join-conversation', { sessionId });
  }

  function sendAgentMessage(sessionId: string, message: string) {
    socket?.emit('agent-message', { sessionId, message });
  }

  return { sessions, setSessions, liveMessages, joinConversation, sendAgentMessage };
}
