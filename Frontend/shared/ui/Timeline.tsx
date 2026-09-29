'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type TimelineState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';

export interface TimelineItem {
  key: string;
  title: ReactNode;
  detail?: ReactNode;
  time?: ReactNode;
  state: TimelineState;
}

const MARKER: Record<TimelineState, { bg: string; fg: string; border: string; icon?: IconName }> = {
  done: { bg: 'var(--ok-soft)', fg: 'var(--ok)', border: 'var(--ok)', icon: 'check' },
  active: { bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', border: 'var(--accent)' },
  pending: { bg: 'var(--surface)', fg: 'var(--faint)', border: 'var(--border-2)' },
  failed: { bg: 'var(--err-soft)', fg: 'var(--err)', border: 'var(--err)', icon: 'close' },
  skipped: { bg: 'var(--surface-2)', fg: 'var(--faint)', border: 'var(--border)' },
};

// A vertical list of stages, each with a state. Generic: the invitation lifecycle is one use,
// but any "this happened, then this, now waiting on that" record fits the same shape.
// 'active' spins, because it means "in progress right now", not merely "next".
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item, index) => {
        const marker = MARKER[item.state];
        const last = index === items.length - 1;
        return (
          <li key={item.key} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', columnGap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  flex: 'none',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: marker.bg,
                  color: marker.fg,
                  border: `1.5px solid ${marker.border}`,
                }}
              >
                {marker.icon ? (
                  <Icon name={marker.icon} size={11} strokeWidth={2} />
                ) : item.state === 'active' ? (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      border: '1.5px solid currentColor',
                      borderTopColor: 'transparent',
                      animation: 'anc-spin .8s linear infinite',
                    }}
                  />
                ) : (
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                )}
              </span>
              {!last && (
                <span
                  style={{
                    flex: 1,
                    width: 2,
                    minHeight: 14,
                    margin: '3px 0',
                    borderRadius: 1,
                    background: item.state === 'done' ? 'var(--ok)' : 'var(--track)',
                    opacity: item.state === 'done' ? 0.45 : 1,
                  }}
                />
              )}
            </div>
            <div style={{ paddingBottom: last ? 0 : 14, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minHeight: 22 }}>
                <span
                  style={{
                    font: '500 13px/22px var(--font-sans)',
                    color: item.state === 'pending' || item.state === 'skipped' ? 'var(--faint)' : item.state === 'failed' ? 'var(--err)' : 'var(--fg)',
                    textDecoration: item.state === 'skipped' ? 'line-through' : undefined,
                  }}
                >
                  {item.title}
                </span>
                {item.time && <span style={{ font: '400 11px/1 var(--font-mono)', color: 'var(--faint)' }}>{item.time}</span>}
              </div>
              {item.detail && <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{item.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
