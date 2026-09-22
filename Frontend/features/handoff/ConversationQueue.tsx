import type { ConversationSession } from './api';
import { Button } from '../../shared/ui/Button';

export function ConversationQueue({
  sessions,
  openSessionId,
  onOpen,
  onClaim,
}: {
  sessions: ConversationSession[];
  openSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onClaim: (sessionId: string) => void;
}) {
  return (
    <aside style={{ width: 320, borderRight: '1px solid #e5e7eb', overflowY: 'auto', padding: 12 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Escalated conversations</h2>
      {sessions.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 14 }}>Nothing needs attention right now.</p>
      )}
      {sessions.map((s) => (
        <div
          key={s.sessionId}
          onClick={() => (s.status === 'claimed' ? onOpen(s.sessionId) : undefined)}
          style={{
            padding: 10,
            marginBottom: 8,
            borderRadius: 8,
            background: s.sessionId === openSessionId ? '#eef2ff' : '#f3f4f6',
            cursor: s.status === 'claimed' ? 'pointer' : 'default',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{s.sessionId}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{s.status}</div>
          {s.status === 'escalated' && (
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onClaim(s.sessionId);
              }}
              style={{ marginTop: 6, fontSize: 12, padding: '4px 8px' }}
            >
              Claim
            </Button>
          )}
        </div>
      ))}
    </aside>
  );
}
