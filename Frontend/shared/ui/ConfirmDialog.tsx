'use client';

import { useEffect, useRef, type ReactNode } from 'react';

// A generic confirm step for any action that cannot be undone. It knows nothing about
// documents — the caller supplies the wording and the handler — so the next destructive
// action in this app reuses it rather than growing its own modal.
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes it, and focus lands on the confirm button when it opens — a dialog that
  // can only be dismissed with the mouse is a dialog keyboard users are stuck in.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      // Clicking the backdrop cancels, but only the backdrop itself — without this check, a
      // click that started inside the dialog and drifted out would dismiss it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,12,.45)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: '0 12px 32px rgba(10,10,12,.22)',
          padding: '20px 22px 18px',
        }}
      >
        <h2 id="confirm-title" style={{ margin: 0, font: '600 15px/1.3 var(--font-sans)' }}>
          {title}
        </h2>
        <div style={{ margin: '9px 0 18px', fontSize: 13, lineHeight: 1.6, color: 'var(--muted)' }}>{body}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            className="anc-border-hover"
            style={{
              height: 32,
              padding: '0 13px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              font: '500 12.5px/1 var(--font-sans)',
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
            className="anc-btn"
            style={{
              height: 32,
              padding: '0 13px',
              borderRadius: 7,
              border: 0,
              background: destructive ? 'var(--err)' : 'var(--btn-bg)',
              color: destructive ? '#ffffff' : 'var(--btn-fg)',
              font: '500 12.5px/1 var(--font-sans)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
