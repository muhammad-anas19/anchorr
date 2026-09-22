import { useState } from 'react';
import type { ConversationTurn } from './api';
import type { LiveMessage } from './useAgentSocket';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';

export function ConversationChat({
  sessionId,
  turns,
  liveMessages,
  onSend,
  onResolve,
}: {
  sessionId: string;
  turns: ConversationTurn[];
  liveMessages: LiveMessage[];
  onSend: (message: string) => void;
  onResolve: () => void;
}) {
  const [draft, setDraft] = useState('');

  function send() {
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft('');
  }

  return (
    <>
      <header
        style={{ padding: 12, borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between' }}
      >
        <strong>{sessionId}</strong>
        <Button variant="secondary" onClick={onResolve}>
          Resolve
        </Button>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {turns.map((t) => (
          <div key={t.id} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13 }}>
              <strong>Customer:</strong> {t.question}
            </div>
            <div style={{ fontSize: 13, color: '#4b5563' }}>
              <strong>AI:</strong> {t.answer}
            </div>
          </div>
        ))}
        {liveMessages.map((m, i) => (
          <div key={i} style={{ fontSize: 13, marginBottom: 6 }}>
            <strong>{m.from === 'customer' ? 'Customer' : m.from === 'agent' ? 'You' : 'AI'}:</strong> {m.text}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', padding: 12, borderTop: '1px solid #e5e7eb' }}>
        <TextField
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Reply to the customer…"
          style={{ flex: 1 }}
        />
        <Button onClick={send} style={{ marginLeft: 8 }}>
          Send
        </Button>
      </div>
    </>
  );
}
