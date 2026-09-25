import type { AnswerResult } from './api';

export interface Turn {
  question: string;
  result: AnswerResult;
  responseTimeMs: number;
}

const STATUS_STYLE: Record<AnswerResult['status'], { badgeBg: string; badgeFg: string; border: string }> = {
  answered: { badgeBg: '#eef1fe', badgeFg: '#2542b8', border: '#e7e7e4' },
  refused: { badgeBg: '#fdf2e0', badgeFg: '#8a5300', border: '#e0a860' },
  escalated: { badgeBg: '#fdeceb', badgeFg: '#a72118', border: '#a72118' },
};

function confidencePercent(minDistance: number | null): number | null {
  if (minDistance === null) return null;
  return Math.max(0, Math.min(1, 1 - minDistance));
}

export function ChatTurn({ turn, onKeepChatting }: { turn: Turn; onKeepChatting: () => void }) {
  const { question, result, responseTimeMs } = turn;
  const style = STATUS_STYLE[result.status];
  const confidence = confidencePercent(result.minDistance);

  return (
    <div>
      <div
        style={{
          alignSelf: 'flex-end',
          maxWidth: '78%',
          marginLeft: 'auto',
          background: '#17171a',
          color: 'white',
          padding: '10px 14px',
          borderRadius: '12px 12px 4px 12px',
          fontSize: 13.5,
          marginBottom: 10,
        }}
      >
        {question}
      </div>
      <div style={{ maxWidth: '88%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              background: style.badgeBg,
              color: style.badgeFg,
              display: 'grid',
              placeItems: 'center',
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            AI
          </span>
          <span style={{ fontSize: 12, color: '#6b6b73' }}>Anchor Assistant</span>
          <span style={{ fontSize: 11, color: style.badgeFg, fontFamily: 'monospace' }}>
            {result.status === 'answered' &&
              confidence !== null &&
              `confidence ${confidence.toFixed(2)} · ${(responseTimeMs / 1000).toFixed(1)}s${result.totalTokens ? ` · ${result.totalTokens.toLocaleString()} tokens` : ''}`}
            {result.status === 'refused' && confidence !== null && `confidence ${confidence.toFixed(2)} · refused`}
            {result.status === 'escalated' && 'escalated'}
          </span>
        </div>
        <div
          style={{
            background: 'white',
            border: `1px solid ${style.border}`,
            borderRadius: '4px 12px 12px 12px',
            padding: '14px 16px',
            fontSize: 13.5,
            lineHeight: 1.65,
          }}
        >
          <p style={{ margin: 0 }}>{result.answer}</p>

          {result.status === 'answered' && result.citations.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #e7e7e4' }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#9a9aa2', marginBottom: 9 }}>
                Sources
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.citations.map((c) => (
                  <span
                    key={c.index}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      border: '1px solid #e7e7e4',
                      background: '#fafafa',
                      borderRadius: 8,
                      fontSize: 12.5,
                    }}
                  >
                    [{c.index}] {c.originalFilename}
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#136c46' }}>
                      {Math.round(Math.max(0, Math.min(1, 1 - c.distance)) * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {result.status === 'refused' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 13, flexWrap: 'wrap' }}>
              <button
                title="This is a preview of what your customers see — staff replies happen from the Agent console."
                style={{
                  height: 31,
                  padding: '0 12px',
                  borderRadius: 7,
                  background: '#17171a',
                  color: 'white',
                  border: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  opacity: 0.5,
                  cursor: 'default',
                }}
              >
                Talk to an agent
              </button>
              <button
                onClick={onKeepChatting}
                style={{
                  height: 31,
                  padding: '0 12px',
                  borderRadius: 7,
                  background: 'white',
                  color: '#17171a',
                  border: '1px solid #e7e7e4',
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Keep chatting
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
