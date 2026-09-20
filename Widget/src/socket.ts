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
  socket.on('exception', (err: { message?: string } | string) => {
    onError(typeof err === 'string' ? err : (err.message ?? 'Something went wrong.'));
  });
  socket.on('connect_error', () => onError('Could not connect to chat. Please try again later.'));

  return socket;
}

export function sendQuestion(socket: Socket, question: string): void {
  socket.emit('message', { question });
}
