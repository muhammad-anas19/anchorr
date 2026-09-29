// Remembers which workspace to open for someone who belongs to several, so they aren't asked
// every time — and so a flow that just added them to one (accepting an invitation) can land
// them in THAT workspace rather than on the picker.
//
// A preference, not state: stored per browser, wrapped in try/catch because storage can be
// blocked, and ignored if it names a workspace the user is no longer in.
const KEY = 'anchor.workspaceId';

export function getPreferredWorkspace(): number | null {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setPreferredWorkspace(workspaceId: number): void {
  try {
    window.localStorage.setItem(KEY, String(workspaceId));
  } catch {
    // Blocked storage: the user just sees the picker next time.
  }
}

export function clearPreferredWorkspace(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
