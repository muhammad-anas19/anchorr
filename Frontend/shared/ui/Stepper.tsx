'use client';

import { Icon } from './Icon';

export interface StepDef {
  label: string;
  hint?: string;
}

// A horizontal progress indicator for a multi-step form. It only DISPLAYS progress: the parent
// owns which step is current and when moving on is allowed, so the same component serves a
// form the user drives (the invite dialog) and a flow the server drives (accepting an invite).
export function Stepper({
  steps,
  current,
  failedAt,
}: {
  steps: StepDef[];
  current: number;
  failedAt?: number;
}) {
  return (
    <ol
      aria-label="Progress"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', alignItems: 'flex-start', gap: 0 }}
    >
      {steps.map((step, index) => {
        const state = index === failedAt ? 'failed' : index < current ? 'done' : index === current ? 'active' : 'upcoming';
        const last = index === steps.length - 1;
        return (
          <li
            key={step.label}
            aria-current={state === 'active' ? 'step' : undefined}
            style={{ flex: last ? 'none' : 1, display: 'flex', alignItems: 'flex-start', minWidth: 0 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 76 }}>
              <StepMarker state={state} number={index + 1} />
              <div
                style={{
                  font: `${state === 'active' ? 600 : 500} 11.5px/1.25 var(--font-sans)`,
                  color: state === 'upcoming' ? 'var(--faint)' : state === 'failed' ? 'var(--err)' : 'var(--fg)',
                  textAlign: 'center',
                }}
              >
                {step.label}
              </div>
              {step.hint && (
                <div style={{ fontSize: 10.5, color: 'var(--faint)', textAlign: 'center', lineHeight: 1.3 }}>{step.hint}</div>
              )}
            </div>
            {!last && (
              <div
                aria-hidden="true"
                style={{
                  flex: 1,
                  height: 2,
                  marginTop: 11,
                  borderRadius: 1,
                  background: index < current ? 'var(--accent)' : 'var(--track)',
                  transition: 'background .2s ease',
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepMarker({ state, number }: { state: 'done' | 'active' | 'upcoming' | 'failed'; number: number }) {
  const styles = {
    done: { background: 'var(--accent)', color: 'var(--btn-fg)', border: '1px solid var(--accent)' },
    active: { background: 'var(--accent-soft)', color: 'var(--accent-fg)', border: '1.5px solid var(--accent)' },
    upcoming: { background: 'var(--surface)', color: 'var(--faint)', border: '1px solid var(--border-2)' },
    failed: { background: 'var(--err-soft)', color: 'var(--err)', border: '1.5px solid var(--err)' },
  }[state];

  return (
    <span
      style={{
        position: 'relative',
        width: 24,
        height: 24,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        font: '600 11px/1 var(--font-mono)',
        transition: 'background .2s ease, border-color .2s ease',
        ...styles,
      }}
    >
      {state === 'done' ? (
        <Icon name="check" size={12} strokeWidth={2} />
      ) : state === 'failed' ? (
        <Icon name="close" size={11} strokeWidth={2} />
      ) : (
        number
      )}
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {state === 'done' ? 'completed' : state === 'failed' ? 'failed' : state === 'active' ? 'current' : 'not started'}
      </span>
    </span>
  );
}
