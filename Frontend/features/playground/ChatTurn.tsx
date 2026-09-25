'use client';

import { TONE_COLORS, TypingDots, type Tone } from '../../shared/ui/primitives';
import { chunkCountLabel, relevancePercent } from './RetrievalInspector';
import type { AnswerConfig, AnswerResult } from './api';

// A turn exists the moment the question is sent, not when the answer arrives — which is why
// `result` is nullable. Three real states: in flight, answered, failed.
export interface Turn {
  id: string;
  question: string;
  result: AnswerResult | null;
  responseTimeMs: number | null;
  error: string | null;
}

const STATUS_TONE: Record<AnswerResult['status'], Tone> = {
  answered: 'accent',
  refused: 'warn',
  escalated: 'err',
};

// Confidence is the complement of the closest chunk's real cosine distance — the same signal
// the Backend's own refusal threshold is measured against, not a separate score.
function confidence(minDistance: number | null): number | null {
  if (minDistance === null) return null;
  return Math.max(0, Math.min(1, 1 - minDistance));
}

// The prototype tags each source with a file-type chip. Derived from the real filename, so a
// document with no recognisable extension gets a neutral chip rather than a wrong one.
function fileKind(filename: string): { label: string; tone: Tone } {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return { label: 'PDF', tone: 'err' };
  if (ext === 'docx' || ext === 'doc') return { label: 'DOC', tone: 'accent' };
  return { label: 'FILE', tone: 'neutral' };
}

export function ChatTurn({
  turn,
  config,
  onKeepChatting,
  onRetry,
}: {
  turn: Turn;
  config: AnswerConfig | null;
  onKeepChatting: () => void;
  onRetry: (turn: Turn) => void;
}) {
  const { question, result, responseTimeMs } = turn;

  // The question bubble renders identically in all three states — it is already true the
  // moment it is sent, and nothing about the response changes it.
  const questionBubble = (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        background: 'var(--btn-bg)',
        color: 'var(--btn-fg)',
        padding: '10px 14px',
        borderRadius: '12px 12px 4px 12px',
        fontSize: 13.5,
        lineHeight: 1.55,
        // A sent-but-unanswered message is slightly faded: it is real and on screen, but the
        // exchange it belongs to is not finished yet.
        opacity: result === null && turn.error === null ? 0.72 : 1,
        transition: 'opacity .15s ease',
      }}
    >
      {question}
    </div>
  );

  if (turn.error !== null) {
    return (
      <>
        {questionBubble}
        <div style={{ maxWidth: '88%' }}>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--err)',
              borderRadius: '4px 12px 12px 12px',
              padding: '12px 14px',
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--err)',
            }}
          >
            {turn.error}
            {/* The question is still on screen, so resending it must not require retyping. */}
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => onRetry(turn)}
                className="anc-border-hover"
                style={{
                  height: 28,
                  padding: '0 11px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--fg)',
                  font: '500 12px/1 var(--font-sans)',
                }}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (result === null) {
    return (
      <>
        {questionBubble}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12.5 }}>
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              background: 'var(--accent-soft)',
              color: 'var(--accent-fg)',
              display: 'grid',
              placeItems: 'center',
              font: '600 10px/1 var(--font-sans)',
            }}
          >
            AI
          </span>
          <TypingDots />
          <span style={{ font: '400 11.5px/1 var(--font-mono)', color: 'var(--faint)' }}>
            {config ? `searching ${chunkCountLabel(config.searchableChunks)}` : 'searching…'}
          </span>
        </div>
      </>
    );
  }

  const tone = STATUS_TONE[result.status];
  const score = confidence(result.minDistance);

  return (
    <>
      {questionBubble}

      <div style={{ maxWidth: '88%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              background: TONE_COLORS[tone].bg,
              color: TONE_COLORS[tone].fg,
              display: 'grid',
              placeItems: 'center',
              font: '600 10px/1 var(--font-sans)',
            }}
          >
            AI
          </span>
          <span style={{ font: '500 12px/1 var(--font-sans)', color: 'var(--muted)' }}>Anchor Assistant</span>
          <span
            style={{
              font: '400 11px/1 var(--font-mono)',
              color: result.status === 'answered' ? 'var(--faint)' : TONE_COLORS[tone].fg,
            }}
          >
            {score !== null && `confidence ${score.toFixed(2)}`}
            {result.status === 'answered' && responseTimeMs !== null && ` · ${(responseTimeMs / 1000).toFixed(1)}s`}
            {result.status === 'answered' && result.totalTokens !== null && ` · ${result.totalTokens.toLocaleString()} tokens`}
            {result.status === 'refused' && ' · refused'}
            {result.status === 'escalated' && ' · escalated'}
          </span>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            border: `1px solid ${result.status === 'answered' ? 'var(--border)' : TONE_COLORS[tone].fg}`,
            borderRadius: '4px 12px 12px 12px',
            padding: '14px 16px',
            fontSize: 13.5,
            lineHeight: 1.65,
          }}
        >
          <p style={{ margin: 0 }}>{result.answer}</p>

          {result.citations.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div
                style={{
                  font: '600 10.5px/1 var(--font-sans)',
                  letterSpacing: '.07em',
                  textTransform: 'uppercase',
                  color: 'var(--faint)',
                  marginBottom: 9,
                }}
              >
                Sources
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.citations.map((citation) => {
                  const kind = fileKind(citation.originalFilename);
                  return (
                    <span
                      key={citation.index}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 10px',
                        border: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        borderRadius: 8,
                      }}
                    >
                      <span
                        style={{
                          font: '600 9.5px/1 var(--font-mono)',
                          color: TONE_COLORS[kind.tone].fg,
                          background: TONE_COLORS[kind.tone].bg,
                          padding: 4,
                          borderRadius: 4,
                        }}
                      >
                        {kind.label}
                      </span>
                      <span style={{ font: '500 12.5px/1 var(--font-sans)', color: 'var(--fg)' }}>
                        {citation.originalFilename}
                      </span>
                      <span
                        style={{
                          font: '500 11px/1 var(--font-mono)',
                          color: 'var(--ok)',
                          background: 'var(--ok-soft)',
                          padding: '3px 5px',
                          borderRadius: 4,
                        }}
                      >
                        {relevancePercent(citation.distance)}%
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {result.status === 'refused' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 13, flexWrap: 'wrap' }}>
                {/* Inert on purpose: this is a staff preview of what a customer sees. A
                    customer escalates by continuing to fail, not by pressing a button —
                    Phase 10's state machine has no manual-escalation path to call. */}
                <button
                  disabled
                  title="This is a preview of what your customers see. Escalation happens automatically — there is no manual hand-off endpoint."
                  style={{
                    height: 31,
                    padding: '0 12px',
                    borderRadius: 7,
                    background: 'var(--btn-bg)',
                    color: 'var(--btn-fg)',
                    border: 0,
                    font: '500 12.5px/1 var(--font-sans)',
                    opacity: 0.45,
                    cursor: 'default',
                  }}
                >
                  Talk to an agent
                </button>
                <button
                  onClick={onKeepChatting}
                  className="anc-border-hover"
                  style={{
                    height: 31,
                    padding: '0 12px',
                    borderRadius: 7,
                    background: 'var(--surface)',
                    color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    font: '500 12.5px/1 var(--font-sans)',
                  }}
                >
                  Keep chatting
                </button>
              </div>
              {result.minDistance !== null && config && (
                <div
                  style={{
                    marginTop: 13,
                    paddingTop: 11,
                    borderTop: '1px solid var(--border)',
                    fontSize: 12,
                    color: 'var(--muted)',
                  }}
                >
                  Refused because the closest chunk&apos;s distance ({result.minDistance.toFixed(2)}) was at or above
                  the {config.confidenceThreshold.toFixed(2)} threshold, so the model was never called.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
