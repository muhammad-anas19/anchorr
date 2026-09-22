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
}
