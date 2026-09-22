import { io, Socket } from 'socket.io-client';
import { BACKEND_URL } from '../config';

// Connects to the same WidgetChatGateway a customer's widget connects to (Phase 11/12) — the
// agent branch of that gateway's handleConnection, authenticated by a real JWT + workspaceId
// instead of a public key, so it can join the same rooms a customer's socket already sits in.
export function connectAgentSocket(token: string, workspaceId: number): Socket {
  return io(`${BACKEND_URL}/widget`, {
    auth: { token, workspaceId },
    transports: ['websocket'],
  });
}
