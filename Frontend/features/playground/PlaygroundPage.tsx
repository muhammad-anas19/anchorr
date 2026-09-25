'use client';

import { useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { ApiError } from '../../shared/api/client';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { TextField } from '../../shared/ui/TextField';
import { Button } from '../../shared/ui/Button';
import { ask } from './api';
import { ChatTurn, type Turn } from './ChatTurn';
import { RetrievalInspector } from './RetrievalInspector';

const SUGGESTED_QUESTIONS = [
  'What is your refund policy?',
  'How do I reset my password?',
  'Do you offer a free trial?',
];

export function PlaygroundPage() {
  const { workspaceId } = useWorkspace();
  // A fresh session per page load — this is a manual test tool, not a real customer
  // session, so it doesn't need Widget/'s localStorage persistence (Phase 11's session.ts).
  const [sessionId] = useState(() => crypto.randomUUID());
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask_(q: string) {
    if (!q || pending) return;
    setError(null);
    setPending(true);
    setQuestion('');
    const startedAt = performance.now();
    try {
      const result = await ask(workspaceId, q, sessionId);
      const responseTimeMs = performance.now() - startedAt;
      setTurns((prev) => [...prev, { question: q, result, responseTimeMs }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  const lastResult = turns.length > 0 ? turns[turns.length - 1].result : null;

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '20px 26px 14px' }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>AI Playground</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6b6b73' }}>
            Test how your AI responds before deploying it to customers.
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 26px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {turns.length === 0 && !pending && (
            <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380 }}>
              <p style={{ fontSize: 13, color: '#6b6b73', marginBottom: 12 }}>
                Try asking something a customer might ask.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {SUGGESTED_QUESTIONS.map((sq) => (
                  <button
                    key={sq}
                    onClick={() => ask_(sq)}
                    style={{
                      padding: '7px 12px',
                      borderRadius: 20,
                      border: '1px solid #e7e7e4',
                      background: 'white',
                      fontSize: 12.5,
                      color: '#17171a',
                      cursor: 'pointer',
                    }}
                  >
                    {sq}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <ChatTurn key={i} turn={turn} onKeepChatting={() => {}} />
          ))}
          {pending && <p style={{ fontSize: 12.5, color: '#9a9aa2' }}>Thinking…</p>}
        </div>

        <div style={{ flex: 'none', padding: '14px 26px 20px', borderTop: '1px solid #e7e7e4' }}>
          <ErrorBanner message={error} />
          <div style={{ display: 'flex', gap: 10 }}>
            <TextField
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask_(question.trim())}
              placeholder="Ask a question your customers would ask…"
              style={{ flex: 1 }}
              disabled={pending}
            />
            <Button onClick={() => ask_(question.trim())} disabled={pending}>
              Send
            </Button>
          </div>
        </div>
      </div>

      <RetrievalInspector result={lastResult} />
    </div>
  );
}
