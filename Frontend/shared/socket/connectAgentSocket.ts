import { io, Socket } from 'socket.io-client';
import { BACKEND_URL } from '../config';
import { getValidAccessToken } from '../auth/session';

// Connects to the same WidgetChatGateway a customer's widget connects to (Phase 11/12) — the
// agent branch of that gateway's handleConnection, authenticated by a real JWT + workspaceId
// instead of a public key, so it can join the same rooms a customer's socket already sits in.
//
// `auth` is given as a function rather than a fixed object on purpose: socket.io-client calls
// it again before every reconnect attempt, so a console left open past the 15-minute access
// token lifetime reconnects with a freshly refreshed token instead of replaying a dead one.
// An established connection is never re-checked by the gateway, so only reconnects need this.
export function connectAgentSocket(workspaceId: number): Socket {
  return io(`${BACKEND_URL}/widget`, {
    auth: (cb) => {
      void getValidAccessToken().then((token) => cb({ token, workspaceId }));
    },
    transports: ['websocket'],
  });
}
