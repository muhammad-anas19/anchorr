'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { Badge, TONE_COLORS } from '../../shared/ui/primitives';
import { Icon } from '../../shared/ui/Icon';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { listTurns, type ConversationTurn, type QueueRow } from './api';
import type { LiveMessage } from './useAgentSocket';

const PAGE_LIMIT = 10;

export function ConversationDrawer({
  workspaceId,
  row,
  liveMessages,
  onSend,
  onResolve,
  onClose,
}: {
  workspaceId: number;
  row: QueueRow;
  liveMessages: LiveMessage[];
  onSend: (message: string) => void;
  onResolve: () => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Cursor pagination, not offset: the customer can send another message while the agent is
  // scrolling back, and a keyset cursor is anchored to a row rather than to a position that
  // new arrivals would shift.
  useEffect(() => {
    let cancelled = false;
    setTurns([]);
    setCursor(null);
    listTurns(workspaceId, row.sessionId, { limit: PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setTurns(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, row.sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, liveMessages.length]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listTurns(workspaceId, row.sessionId, { cursor, limit: PAGE_LIMIT });
      setTurns((prev) => [...page.items, ...prev]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, loadingOlder, workspaceId, row.sessionId]);

  function send() {
    const message = draft.trim();
    if (!message) return;
    onSend(message);
    setDraft('');
  }

  const claimed = row.status === 'claimed';

  return (
    <aside
      style={{
        width: 420,
        flex: 'none',
        borderLeft: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 13.5px/1 var(--font-sans)' }}>Visitor {row.sessionId.slice(0, 8)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 5 }}>
            {row.turnCount} turn{row.turnCount === 1 ? '' : 's'} · {row.reason}
          </div>
        </div>
        <Badge tone={claimed ? 'accent' : 'warn'}>{row.status}</Badge>
        <button
          onClick={onClose}
          aria-label="Close conversation"
          className="anc-icon-btn"
          style={{
            width: 26,
            height: 26,
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface)',
            color: 'var(--muted)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Icon name="chevronRight" size={12} strokeWidth={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {hasMore && (
          <button
            onClick={loadOlder}
            disabled={loadingOlder}
            className="anc-border-hover"
            style={{
              alignSelf: 'center',
              height: 28,
              padding: '0 12px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--muted)',
              fontSize: 12,
            }}
          >
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        )}

        {turns.map((turn) => (
          <div key={turn.id}>
            <Bubble from="customer">{turn.question}</Bubble>
            <Bubble from="ai" status={turn.status}>
              {turn.answer}
            </Bubble>
          </div>
        ))}

        {liveMessages.map((message, index) => (
          <Bubble key={`live-${index}`} from={message.from}>
            {message.text}
          </Bubble>
        ))}

        <div ref={bottomRef} />
      </div>

      <div style={{ flex: 'none', padding: '12px 18px 16px', borderTop: '1px solid var(--border)' }}>
        <ErrorBanner message={error} />
        {!claimed && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Claim this conversation to reply — until then the AI is still answering it.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            disabled={!claimed}
            placeholder={claimed ? 'Reply to the customer…' : 'Not claimed'}
            style={{
              flex: 1,
              minWidth: 0,
              height: 34,
              padding: '0 11px',
              border: '1px solid var(--border-2)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--fg)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            onClick={send}
            disabled={!claimed}
            className="anc-btn"
            style={{
              height: 34,
              padding: '0 13px',
              borderRadius: 8,
              border: 0,
              background: 'var(--btn-bg)',
              color: 'var(--btn-fg)',
              font: '500 12.5px/1 var(--font-sans)',
              opacity: claimed ? 1 : 0.45,
            }}
          >
            Send
          </button>
        </div>
        {claimed && (
          <button
            onClick={onResolve}
            className="anc-border-hover"
            style={{
              marginTop: 9,
              width: '100%',
              height: 32,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              font: '500 12.5px/1 var(--font-sans)',
            }}
          >
            Resolve &amp; hand back to AI
          </button>
        )}
      </div>
    </aside>
  );
}

function Bubble({
  from,
  children,
  status,
}: {
  from: LiveMessage['from'];
  children: React.ReactNode;
  status?: ConversationTurn['status'];
}) {
  if (from === 'customer') {
    return (
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: '88%',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: '12px 12px 12px 4px',
          padding: '9px 12px',
          fontSize: 13,
          lineHeight: 1.55,
          marginBottom: 8,
        }}
      >
        {children}
      </div>
    );
  }

  const isAgent = from === 'agent';
  const tone = status === 'refused' ? 'warn' : status === 'escalated' ? 'err' : 'accent';

  return (
    <div
      style={{
        alignSelf: 'flex-end',
        marginLeft: 'auto',
        maxWidth: '88%',
        background: isAgent ? 'var(--btn-bg)' : 'var(--surface)',
        color: isAgent ? 'var(--btn-fg)' : 'var(--fg)',
        border: isAgent ? 0 : `1px solid ${status && status !== 'answered' ? TONE_COLORS[tone].fg : 'var(--border)'}`,
        borderRadius: '12px 12px 4px 12px',
        padding: '9px 12px',
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      {!isAgent && (
        <div style={{ font: '600 9.5px/1 var(--font-sans)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 6 }}>
          AI {status && status !== 'answered' ? `· ${status}` : ''}
        </div>
      )}
      {children}
    </div>
  );
}
