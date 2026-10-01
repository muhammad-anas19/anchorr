'use client';

import { useEffect, useRef, useState } from 'react';
import type { DailyUsage } from './api';
import { compact, utcDate } from './format';

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

// One series — billable answers per UTC day — so the card title names it and there is no
// legend box (dataviz rule: a legend for >= 2 series only). Colour is --chart-1, validated
// for a filled mark against both theme surfaces; text never wears it.
export function DailyUsageChart({ days }: { days: DailyUsage[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  // Re-subscribes when the table view closes: the chart's wrapper is a new element then.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [asTable]);

  const max = Math.max(1, ...days.map((d) => d.billableAnswers));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  // Label roughly every ~70px so dates never collide, always including the first day.
  const labelEvery = Math.max(1, Math.ceil(70 / slot));
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          onClick={() => setAsTable((v) => !v)}
          className="anc-border-hover"
          style={{
            height: 24,
            padding: '0 9px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--muted)',
            font: '500 11.5px/1 var(--font-sans)',
          }}
        >
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {asTable ? (
        <DailyTable days={days} />
      ) : (
        <div ref={wrapRef} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
          {/* Fills its container; the viewBox is the measured width, so geometry and text stay
              1:1 — and if a measurement is ever stale, the chart still spans the card. */}
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            height={HEIGHT}
            role="img"
            aria-label="Billable answers per day (UTC)"
            style={{ display: 'block', width: '100%' }}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10.5} fill="var(--faint)" fontFamily="var(--font-mono)">
                  {compact(t)}
                </text>
              </g>
            ))}

            {days.map((d, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2;
              const barTop = y(d.billableAnswers);
              const h = PAD.top + plotH - barTop;
              return (
                <g key={d.day}>
                  {/* Hit target: the whole column, far bigger than the mark, so thin bars and
                      zero days are still easy to hover. */}
                  <rect
                    x={PAD.left + i * slot}
                    y={PAD.top}
                    width={slot}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                  />
                  {h > 0 && (
                    <path
                      d={roundedTopBar(x, barTop, barW, h)}
                      fill="var(--chart-1)"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                      pointerEvents="none"
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text x={PAD.left + i * slot + slot / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={10.5} fill="var(--faint)">
                      {utcDate(`${d.day}T00:00:00Z`)}
                    </text>
                  )}
                </g>
              );
            })}
            {/* Baseline last, over the bar feet. */}
            <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--border-2)" />
          </svg>

          {hovered && hover !== null && (
            <div
              role="tooltip"
              style={{
                position: 'absolute',
                top: 0,
                left: Math.min(width - 190, Math.max(0, PAD.left + hover * slot + slot / 2 - 90)),
                width: 180,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                boxShadow: '0 6px 18px rgba(10,10,12,.14)',
                fontSize: 12,
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 5 }}>{utcDate(`${hovered.day}T00:00:00Z`, true)} · UTC</div>
              <Row label="Billable answers" value={hovered.billableAnswers} />
              <Row label="All answers" value={hovered.answers} />
              <Row label="Tokens" value={hovered.totalTokens} />
              <Row label="Chunks embedded" value={hovered.chunksEmbedded} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--muted)' }}>
      <span>{label}</span>
      <span style={{ color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>{value.toLocaleString()}</span>
    </div>
  );
}

function DailyTable({ days }: { days: DailyUsage[] }) {
  const cell = { padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5 } as const;
  return (
    <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--surface-2)', color: 'var(--faint)', textAlign: 'left' }}>
            {['Day (UTC)', 'Billable answers', 'All answers', 'Tokens', 'Chunks embedded'].map((h) => (
              <th key={h} style={{ ...cell, fontWeight: 600, fontSize: 11 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td style={cell}>{d.day}</td>
              <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{d.billableAnswers}</td>
              <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{d.answers}</td>
              <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{d.totalTokens.toLocaleString()}</td>
              <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{d.chunksEmbedded}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A bar with 4px rounded corners at the data end and square corners at the baseline.
function roundedTopBar(x: number, top: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  const bottom = top + h;
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`;
}

// 3-4 round gridline values covering max, e.g. 7 → [0, 2, 4, 6, 8].
function niceTicks(max: number): number[] {
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  // Never below 1: these are whole counts, and a 0.5 step would round into duplicate labels.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10);
  const ticks = [];
  for (let v = 0; v <= max + step - 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}
