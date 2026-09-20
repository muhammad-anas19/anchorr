const STORAGE_KEY = 'anchor-widget-session';

// Resumable across a reload, but not forever (Phase 11's Q11) — a temporary, expiring
// identity for a customer who never signed up for anything, not a permanent account.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredSession {
  sessionId: string;
  expiresAt: number;
}

export function getOrCreateSessionId(): string {
  const stored = readStoredSession();
  if (stored && stored.expiresAt > Date.now()) {
    return stored.sessionId;
  }

  const sessionId = crypto.randomUUID();
  writeStoredSession({ sessionId, expiresAt: Date.now() + SESSION_TTL_MS });
  return sessionId;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    // Private browsing / storage disabled — fall through and treat as no session.
    return null;
  }
}

function writeStoredSession(session: StoredSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable — the widget still works for this page view, it just won't
    // resume across a reload for this visitor.
  }
}
