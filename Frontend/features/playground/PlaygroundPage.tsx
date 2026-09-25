'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { notifyError, toMessage } from '../../shared/ui/toast';
import { Icon } from '../../shared/ui/Icon';
import { useFetch } from '../../shared/hooks/useFetch';
import { ask, getAnswerConfig } from './api';
import { ChatTurn, type Turn } from './ChatTurn';
import { chunkCountLabel, RetrievalInspector } from './RetrievalInspector';

const SUGGESTED_QUESTIONS = [
  'How do I reset my password?',
  'Where can I download my invoice?',
  'What is your refund policy?',
];

export function PlaygroundPage() {
  const { workspaceId } = useWorkspace();
  // A fresh session per page load — this is a staff testing tool, not a real customer
  // session, so it deliberately does not persist the way Widget/'s own session.ts does.
  const [sessionId] = useState(() => crypto.randomUUID());
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const configKey = useMemo(() => JSON.stringify({ workspaceId }), [workspaceId]);
  const { data: config } = useFetch((signal) => getAnswerConfig(workspaceId, signal), configKey);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    // `turns`, not `turns.length`: an answer landing replaces a turn's contents without
    // changing the count, and that is exactly when the view needs to follow it down.
  }, [turns]);

  // The turn is appended before the request starts, so the question bubble appears on the
  // same frame as the click rather than a Gemini round trip later. The row is then patched in
  // place by id — not replaced by index, which would attach the answer to the wrong bubble if
  // the list ever changed shape underneath it.
  async function runTurn(turnId: string, questionText: string) {
    const startedAt = performance.now();
    try {
      const result = await ask(workspaceId, questionText, sessionId);
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === turnId
            ? { ...turn, result, responseTimeMs: performance.now() - startedAt, error: null }
            : turn,
        ),
      );
    } catch (err) {
      const message = toMessage(err, 'Something went wrong.');
      // The failure is attached to its own turn rather than announced globally: the question
      // is already on screen, so the answer slot is exactly where the reason belongs, and it
      // carries its own Retry instead of making the user retype.
      setTurns((prev) => prev.map((turn) => (turn.id === turnId ? { ...turn, error: message } : turn)));
      notifyError(err, 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setQuestion('');
    const turnId = crypto.randomUUID();
    setTurns((prev) => [...prev, { id: turnId, question: trimmed, result: null, responseTimeMs: null, error: null }]);
    void runTurn(turnId, trimmed);
  }

  function retry(turn: Turn) {
    if (pending) return;
    setPending(true);
    setTurns((prev) => prev.map((t) => (t.id === turn.id ? { ...t, error: null, result: null } : t)));
    void runTurn(turn.id, turn.question);
  }

  // The last turn that actually produced an answer — not simply the last turn, which may be
  // in flight or failed. The inspector should keep showing the previous retrieval while the
  // next question is still running, rather than blanking out.
  const lastResult = [...turns].reverse().find((turn) => turn.result !== null)?.result ?? null;

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
        <div style={{ flex: 'none', padding: '20px 26px 14px' }}>
          <h1 style={{ margin: 0, font: '600 20px/1.2 var(--font-sans)', letterSpacing: '-.02em' }}>AI Playground</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Test how your AI responds before deploying it to customers.
          </p>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 320,
            overflowY: 'auto',
            padding: '8px 26px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {turns.length === 0 && !pending && (
            <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380, color: 'var(--muted)' }}>
              <p style={{ fontSize: 13 }}>Ask something a customer would ask.</p>
              <p style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                {config
                  ? `${chunkCountLabel(config.searchableChunks)} searchable in this workspace.`
                  : 'Loading retrieval settings…'}
              </p>
            </div>
          )}

          {/* Keyed by the turn's own id, not its index: a React key that is just a position
              would let a re-render reuse the wrong bubble's DOM as turns change state. */}
          {turns.map((turn) => (
            <ChatTurn
              key={turn.id}
              turn={turn}
              config={config}
              onKeepChatting={() => inputRef.current?.focus()}
              onRetry={retry}
            />
          ))}

          <div ref={bottomRef} />
        </div>

        <div
          style={{
            flex: 'none',
            padding: '14px 26px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              border: '1px solid var(--border-2)',
              borderRadius: 9,
              padding: '9px 12px',
              background: 'var(--surface)',
            }}
          >
            <input
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(question)}
              placeholder="Ask a question your customers would ask…"
              disabled={pending}
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: 'none',
                background: 'transparent',
                color: 'var(--fg)',
                fontSize: 13.5,
              }}
            />
            <button
              onClick={() => submit(question)}
              disabled={pending || !question.trim()}
              className="anc-btn"
              style={{
                height: 28,
                padding: '0 11px',
                borderRadius: 6,
                background: 'var(--btn-bg)',
                color: 'var(--btn-fg)',
                border: 0,
                font: '500 12.5px/1 var(--font-sans)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                opacity: pending || !question.trim() ? 0.5 : 1,
              }}
            >
              <Icon name="send" size={12} strokeWidth={1.6} />
              Send
            </button>
          </div>

          <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
            {SUGGESTED_QUESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => submit(suggestion)}
                disabled={pending}
                className="anc-chip"
                style={{
                  padding: '5px 9px',
                  border: '1px solid var(--border)',
                  borderRadius: 20,
                  background: 'transparent',
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>

      <RetrievalInspector result={lastResult} config={config} />
    </div>
  );
}
