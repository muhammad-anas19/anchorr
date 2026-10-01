import { io, Socket } from 'socket.io-client';

export interface AnswerPayload {
  answer: string;
  status: 'answered' | 'refused' | 'escalated';
  citations: unknown[];
}

// Connects to the Backend's WidgetChatGateway (Phase 11) — auth is the public key + this
// browser's session id, never a JWT (there's no logged-in user on this side, per Q1).
export function connectWidgetSocket(
  serverUrl: string,
  publicKey: string,
  sessionId: string,
  onAnswer: (payload: AnswerPayload) => void,
  onError: (message: string) => void,
): Socket {
  const socket = io(`${serverUrl}/widget`, {
    auth: { publicKey, sessionId },
    transports: ['websocket'],
  });

  socket.on('answer', onAnswer);
  socket.on('rate-limited', (payload: { retryAfterSeconds: number }) => {
    onError(`You're sending messages a little fast — please wait ${payload.retryAfterSeconds}s and try again.`);
  });
  socket.on('exception', (err: { message?: string } | string) => {
    onError(typeof err === 'string' ? err : (err.message ?? 'Something went wrong.'));
  });
  socket.on('connect_error', () => onError('Could not connect to chat. Please try again later.'));

  return socket;
}

// A fresh id per message. socket.io buffers emits made while disconnected and sends them on
// reconnect with the same payload — so a message that was sent, lost, and re-sent carries the
// same id, and the server answers (and meters) it once.
export function sendQuestion(socket: Socket, question: string): void {
  socket.emit('message', { question, clientMessageId: messageId() });
}

// Not crypto.randomUUID(): that only exists in SECURE contexts (HTTPS or localhost), and this
// script runs on customers' sites — some still served over plain HTTP, where it would throw
// and no message would send at all. getRandomValues() is available everywhere. 16 random
// bytes as hex is as unguessable as a UUID; it only has to be unique per visitor session.
function messageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
