// Single source of truth for this project's Socket.IO room names, shared by anything that
// needs to broadcast into or join one — the widget gateway, and (from Phase 12 on) the
// handoff feature, without either depending on the other's module.
export function conversationRoom(sessionId: string): string {
  return `conversation:${sessionId}`;
}

export function agentsRoom(workspaceId: number): string {
  return `agents:${workspaceId}`;
}

// One agent's sockets in one workspace. Joined on connect, so "cut this person off from this
// workspace right now" is a single room operation — including their other open tabs, and (once a
// Redis adapter exists) sockets held by other API instances too.
export function agentUserRoom(workspaceId: number, userId: number): string {
  return `agent:${workspaceId}:${userId}`;
}
