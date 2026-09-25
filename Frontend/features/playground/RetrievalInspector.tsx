import type { AnswerResult } from './api';

// Real, current facts about this deployment — not user-configurable yet, so shown as static
// values rather than fetched from anywhere. "Vector", not "Hybrid": this project's retrieval
// (Phase 8) is pure vector search — hybrid (keyword + vector) is Phase 13, not built yet.
const SEARCH_MODE = 'Vector';
const TOP_K = 5;
const MODEL_NAME = 'gemini-3.6-flash';

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ border: '1px solid #e7e7e4', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 11.5, color: '#6b6b73' }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginTop: 6, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function scorePercent(distance: number): number {
  return Math.round(Math.max(0, Math.min(1, 1 - distance)) * 100);
}

export function RetrievalInspector({ result }: { result: AnswerResult | null }) {
  return (
    <aside style={{ width: 300, flex: 'none', overflowY: 'auto', background: 'white', borderLeft: '1px solid #e7e7e4', padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Retrieval inspector</div>
      <p style={{ margin: '6px 0 16px', fontSize: 12.5, color: '#6b6b73' }}>What the model was given for the last answer.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 18 }}>
        <Tile label="Search mode" value={SEARCH_MODE} />
        <Tile label="Top k" value={TOP_K} />
        <Tile label="Retrieved" value={result ? result.retrievedChunks.length : '—'} />
        <Tile label="Model" value={MODEL_NAME} />
      </div>

      {!result && <p style={{ fontSize: 12.5, color: '#9a9aa2' }}>Ask a question to see what gets retrieved.</p>}

      {result && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#9a9aa2', marginBottom: 10 }}>
            Retrieved chunks
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.retrievedChunks.length === 0 && (
              <p style={{ fontSize: 12.5, color: '#9a9aa2' }}>Nothing was retrieved for this question.</p>
            )}
            {result.retrievedChunks.map((chunk, i) => {
              const isTop = i === 0;
              return (
                <div
                  key={chunk.chunkId}
                  style={{
                    border: `1px solid ${isTop ? '#3459e6' : '#e7e7e4'}`,
                    background: isTop ? '#eef1fe' : 'white',
                    borderRadius: 9,
                    padding: '11px 12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: isTop ? '#2542b8' : '#9a9aa2' }}>#{chunk.chunkId}</span>
                    <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>{chunk.originalFilename}</span>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#136c46' }}>{scorePercent(chunk.distance)}%</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#6b6b73', marginTop: 7, lineHeight: 1.45 }}>&quot;{chunk.snippet}&quot;</div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 18, padding: 12, border: '1px solid #e7e7e4', borderRadius: 9, background: '#fafafa', fontSize: 12, color: '#6b6b73', lineHeight: 1.55 }}>
            Prompt assembled from {result.retrievedChunks.length} chunk{result.retrievedChunks.length === 1 ? '' : 's'}
            {result.promptTokens !== null && ` · ${result.promptTokens.toLocaleString()} context tokens`}
          </div>
        </>
      )}
    </aside>
  );
}
