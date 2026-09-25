'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';

// The prototype's recurring visual atoms, each one generic over its content rather than tied
// to a page. Colour always comes from a token, never a literal, so all of these follow the
// theme without knowing a theme exists.

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err';

// Every tone resolves to a (background, foreground) pair from the token set. Centralised here
// so a badge, a stat tile and an avatar tinted "warn" are guaranteed to be the same warn.
export const TONE_COLORS: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--surface-2)', fg: 'var(--muted)' },
  accent: { bg: 'var(--accent-soft)', fg: 'var(--accent-fg)' },
  ok: { bg: 'var(--ok-soft)', fg: 'var(--ok)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
  err: { bg: 'var(--err-soft)', fg: 'var(--err)' },
};

export function Card({
  children,
  padding = '16px 18px',
  style,
}: {
  children: ReactNode;
  padding?: string | number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: 'var(--shadow)',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <>
      <div style={{ font: '600 14px/1 var(--font-sans)' }}>{children}</div>
      {hint && <p style={{ margin: '6px 0 14px', fontSize: 12.5, color: 'var(--muted)' }}>{hint}</p>}
    </>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        font: '600 10.5px/1 var(--font-sans)',
        letterSpacing: '.07em',
        textTransform: 'uppercase',
        color: 'var(--faint)',
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

export function StatTile({ label, value, tone = 'neutral' }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{label}</div>
      <div
        style={{
          font: '500 20px/1 var(--font-mono)',
          marginTop: 7,
          color: tone === 'neutral' ? 'var(--fg)' : TONE_COLORS[tone].fg,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function StatTileRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>{children}</div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const { bg, fg } = TONE_COLORS[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 21,
        padding: '0 7px',
        borderRadius: 5,
        background: bg,
        color: fg,
        font: '600 11px/21px var(--font-sans)',
      }}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'ok', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: TONE_COLORS[tone].fg,
        flex: 'none',
        animation: pulse ? 'anc-pulse 2.4s infinite' : undefined,
      }}
    />
  );
}

export function Avatar({ label, tone = 'accent', size = 26 }: { label: string; tone?: Tone; size?: number }) {
  const { bg, fg } = TONE_COLORS[tone];
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        background: bg,
        color: fg,
        display: 'grid',
        placeItems: 'center',
        font: `600 ${Math.round(size * 0.4)}px/1 var(--font-sans)`,
        textTransform: 'uppercase',
      }}
    >
      {label.slice(0, 2)}
    </div>
  );
}

export function Meter({ percent }: { percent: number }) {
  return (
    <div style={{ height: 4, borderRadius: 3, background: 'var(--track)', marginTop: 6, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: '100%', background: 'var(--accent)' }} />
    </div>
  );
}

export interface TabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={active ? undefined : 'anc-nav-item'}
            style={{
              height: 26,
              padding: '0 10px',
              border: 0,
              borderRadius: 6,
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent-fg)' : 'var(--muted)',
              font: '500 12px/26px var(--font-sans)',
            }}
          >
            {option.label}
            {option.count !== undefined && ` ${option.count}`}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  width,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number | string;
}) {
  return (
    <label
      className="anc-border-hover"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 30,
        padding: '0 10px',
        border: '1px solid var(--border)',
        borderRadius: 7,
        color: 'var(--faint)',
        background: 'var(--surface)',
        width,
      }}
    >
      <Icon name="search" size={13} strokeWidth={1.6} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 'none',
          background: 'transparent',
          color: 'var(--fg)',
          fontSize: 12.5,
        }}
      />
    </label>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="anc-border-hover"
      style={{
        height: 30,
        padding: '0 8px',
        border: '1px solid var(--border)',
        borderRadius: 7,
        background: 'var(--surface)',
        color: 'var(--fg)',
        fontSize: 12.5,
        outline: 'none',
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--faint)' }}>{children}</div>;
}

export function TypingDots() {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 3,
        alignItems: 'center',
        padding: '7px 10px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      {[0, 0.18, 0.36].map((delay) => (
        <span
          key={delay}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--faint)',
            animation: `anc-pulse 1.1s ${delay}s infinite`,
          }}
        />
      ))}
    </span>
  );
}
