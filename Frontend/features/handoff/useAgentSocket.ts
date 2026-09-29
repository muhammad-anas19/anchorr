'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectAgentSocket } from '../../shared/socket/connectAgentSocket';
import { notifyError } from '../../shared/ui/toast';

export interface LiveMessage {
  from: 'customer' | 'agent' | 'ai';
  text: string;
}

export function useAgentSocket(workspaceId: number | null, onQueueChanged: () => void) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);

  const onQueueChangedRef = useRef(onQueueChanged);
  onQueueChangedRef.current = onQueueChanged;

  useEffect(() => {
    if (!workspaceId) return;

    const agentSocket = connectAgentSocket(workspaceId);
    setSocket(agentSocket);

    const changed = () => onQueueChangedRef.current();

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

    agentSocket.on('access-revoked', (payload: { reason: string }) => {
      notifyError(
        new Error(
          payload.reason === 'role-changed'
            ? 'Your role changed and no longer includes the agent console.'
            : 'You no longer have access to this workspace.',
        ),
        'Access revoked.',
      );
      window.setTimeout(() => window.location.assign('/'), 1500);
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
