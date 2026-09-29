'use client';

import { SectionLabel } from '../../shared/ui/primitives';
import type { AnswerConfig, AnswerResult } from './api';

// Cosine distance is "how far apart", so a relevance percentage is its complement. The same
// transform the answer bubble uses, kept in one place.
export function relevancePercent(distance: number): number {
  return Math.round(Math.max(0, Math.min(1, 1 - distance)) * 100);
}

export function chunkCountLabel(count: number): string {
  return `${count.toLocaleString()} chunk${count === 1 ? '' : 's'}`;
}

function Tile({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{label}</div>
      <div style={{ font: '500 12px/1.3 var(--font-mono)', marginTop: 6, wordBreak: 'break-word', color }}>{value}</div>
    </div>
  );
}

// Capitalised the way the prototype shows it ("Miss"). Bypass is visually quieter than Miss on
// purpose: a miss is a cache that might warm up, a bypass is a turn that was never eligible.
const CACHE_DISPLAY: Record<AnswerResult['cache'], { label: string; color: string }> = {
  hit: { label: 'Hit', color: 'var(--ok)' },
  miss: { label: 'Miss', color: 'var(--muted)' },
  bypass: { label: 'Bypass', color: 'var(--faint)' },
};

// One sentence describing what the model was actually given. Keyed on what really happened,
// not on promptTokens alone: null tokens meant BOTH "refused, model never called" and
// "escalated, model called and failed" — and the old single message described only the first.
function footerText(result: AnswerResult): string {
  const chunks = `${result.retrievedChunks.length} chunk${result.retrievedChunks.length === 1 ? '' : 's'}`;
  if (result.cache === 'hit') {
    return `Served from cache — no prompt was sent this time. The chunks shown are the retrieval that produced the original answer.`;
  }
  if (result.status === 'refused') {
    return 'No prompt was sent — the closest match was outside the confidence threshold, so the model was never called.';
  }
  if (result.status === 'escalated') {
    return `Prompt assembled from ${chunks}, but the model call failed, so the conversation was escalated to a person.`;
  }
  return result.promptTokens === null
    ? `Prompt assembled from ${chunks}.`
    : `Prompt assembled from ${chunks} · ${result.promptTokens.toLocaleString()} context tokens.`;
}

export function RetrievalInspector({ result, config }: { result: AnswerResult | null; config: AnswerConfig | null }) {
  return (
    <aside
      style={{
        width: 300,
        flex: 'none',
        overflowY: 'auto',
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        padding: '20px 20px 28px',
      }}
    >
      <div style={{ font: '600 14px/1 var(--font-sans)' }}>Retrieval inspector</div>
      <p style={{ margin: '6px 0 16px', fontSize: 12.5, color: 'var(--muted)' }}>
        What the model was given for the last answer.
      </p>

      {/* The prototype's exact four tiles. Until Phase 14 the Cache slot showed the confidence
          threshold instead, because there was no cache and a "Miss" would have described a
          system that did not exist. It is real now; the threshold is still shown where it
          matters, in the explanation under a refused answer. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 18 }}>
        <Tile label="Search mode" value={config?.searchMode ?? '—'} />
        <Tile label="Top k" value={config?.topK ?? '—'} />
        <Tile
          label="Cache"
          value={result ? CACHE_DISPLAY[result.cache].label : '—'}
          color={result ? CACHE_DISPLAY[result.cache].color : undefined}
        />
        <Tile label="Model" value={config?.model ?? '—'} />
      </div>

      {!result && (
        <p style={{ fontSize: 12.5, color: 'var(--faint)' }}>Ask a question to see what gets retrieved.</p>
      )}

      {result && (
        <>
          <SectionLabel>Retrieved chunks</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.retrievedChunks.length === 0 && (
              <p style={{ fontSize: 12.5, color: 'var(--faint)' }}>Nothing was retrieved for this question.</p>
            )}
            {result.retrievedChunks.map((chunk, index) => {
              const isTop = index === 0;
              // A chunk further away than the threshold is a weak match. It is still sent to
              // the model as context whenever the CLOSEST chunk cleared the bar — saying
              // otherwise would misdescribe what the prompt actually contained.
              const weak = config ? chunk.distance >= config.confidenceThreshold : false;
              return (
                <div
                  key={chunk.chunkId}
                  style={{
                    border: `1px solid ${isTop ? 'var(--accent)' : 'var(--border)'}`,
                    background: isTop ? 'var(--accent-soft)' : 'var(--surface)',
                    borderRadius: 9,
                    padding: '11px 12px',
                    opacity: weak && !isTop ? 0.62 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ font: '500 11px/1 var(--font-mono)', color: isTop ? 'var(--accent-fg)' : 'var(--faint)' }}>
                      #{chunk.chunkId}
                    </span>
                    <span style={{ flex: 1, font: '500 12.5px/1.3 var(--font-sans)', minWidth: 0, wordBreak: 'break-word' }}>
                      {chunk.originalFilename}
                    </span>
                    <span
                      style={{
                        font: '500 11px/1 var(--font-mono)',
                        color: weak ? 'var(--muted)' : 'var(--ok)',
                      }}
                    >
                      {relevancePercent(chunk.distance)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7, lineHeight: 1.45 }}>
                    &quot;{chunk.snippet}&quot;
                  </div>
                  {/* Which search actually found this chunk. A chunk with only one rank is
                      the interesting case: keyword-only means an exact token the vector side
                      missed, vector-only means a paraphrase sharing no words. */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span style={{ font: '400 10.5px/1 var(--font-mono)', color: 'var(--faint)' }}>
                      {chunk.vectorRank !== null ? `vector #${chunk.vectorRank}` : 'vector —'}
                    </span>
                    <span style={{ font: '400 10.5px/1 var(--font-mono)', color: 'var(--faint)' }}>
                      {chunk.keywordRank !== null ? `keyword #${chunk.keywordRank}` : 'keyword —'}
                    </span>
                    <span style={{ font: '400 10.5px/1 var(--font-mono)', color: 'var(--faint)' }}>
                      d {chunk.distance.toFixed(3)}
                    </span>
                    {weak && (
                      <span style={{ font: '400 10.5px/1 var(--font-mono)', color: 'var(--faint)' }}>· weak</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 18,
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 9,
              background: 'var(--surface-2)',
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.55,
            }}
          >
            {footerText(result)}
          </div>
        </>
      )}
    </aside>
  );
}
