import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

// The one piece of Phase 11's gateway that a REST-only service (HandoffService) actually
// needs to reach — extracted here, as top-level shared infra, specifically so HandoffModule
// never has to import WidgetChatModule directly. WidgetChatModule -> AnswerModule ->
// HandoffModule already exists; HandoffModule importing WidgetChatModule back would close
// that into a real circular dependency. Both modules depend on this leaf module instead.
@Injectable()
export class RealtimeBroadcaster {
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  // A no-op before the gateway has finished initializing — there's nobody connected to
  // broadcast to yet at that point anyway, not a real error condition.
  broadcast(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
  }

  // Ends every socket in a room, telling the client why first.
  //
  // Needed because a WebSocket's authorization happens once, at connect. REST is re-checked on
  // every request (WorkspaceGuard reads memberships each time), so removing a member ends their
  // REST access instantly — but an already-open socket would keep receiving the workspace's
  // events and could keep sending, for as long as the tab stays open.
  //
  // disconnectSockets(false) disconnects from this namespace only and sends a proper disconnect
  // packet, AFTER the event above on the same connection, so the client sees the reason before
  // the disconnect — and a server-initiated disconnect is one socket.io-client does NOT
  // auto-reconnect from, which a dropped connection would be.
  revokeRoom(room: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(room).emit(event, payload);
    this.server.in(room).disconnectSockets(false);
  }
}
