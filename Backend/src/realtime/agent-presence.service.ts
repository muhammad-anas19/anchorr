import { Injectable } from '@nestjs/common';

// Who is actually connected right now, keyed by workspace. Lives in `realtime/` for the same
// reason RealtimeBroadcaster does: WidgetChatGateway WRITES to it and HandoffService READS
// from it, and a direct dependency either way would rebuild the exact
// WidgetChatModule -> AnswerModule -> HandoffModule -> WidgetChatModule cycle Phase 12 had to
// break. Both depend on this; neither depends on the other.
//
// Deliberately in-process memory, not Redis: this reflects sockets connected to THIS Node
// process, and the gateway that owns those sockets runs in the same process. The moment this
// API scales to more than one instance, presence has to move to Redis (each instance would
// otherwise only ever report its own connections) — a real, known limitation, not an
// oversight.
@Injectable()
export class AgentPresenceService {
  // workspaceId -> userId -> number of live sockets for that user. Counted, not a boolean:
  // one agent with the console open in three tabs is three sockets, and closing one tab
  // must not mark them offline while the other two are still connected.
  private readonly byWorkspace = new Map<number, Map<number, number>>();

  add(workspaceId: number, userId: number): void {
    let users = this.byWorkspace.get(workspaceId);
    if (!users) {
      users = new Map<number, number>();
      this.byWorkspace.set(workspaceId, users);
    }
    users.set(userId, (users.get(userId) ?? 0) + 1);
  }

  remove(workspaceId: number, userId: number): void {
    const users = this.byWorkspace.get(workspaceId);
    if (!users) return;

    const remaining = (users.get(userId) ?? 0) - 1;
    if (remaining > 0) {
      users.set(userId, remaining);
      return;
    }

    users.delete(userId);
    if (users.size === 0) {
      this.byWorkspace.delete(workspaceId);
    }
  }

  onlineUserIds(workspaceId: number): number[] {
    return [...(this.byWorkspace.get(workspaceId)?.keys() ?? [])];
  }

  isOnline(workspaceId: number, userId: number): boolean {
    return (this.byWorkspace.get(workspaceId)?.get(userId) ?? 0) > 0;
  }
}
