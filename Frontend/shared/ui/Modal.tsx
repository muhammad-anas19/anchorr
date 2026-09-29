'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

// The dialog shell every multi-part overlay uses: backdrop, panel, header with a close
// button, scrollable body, optional footer. Knows nothing about what it contains —
// ConfirmDialog is the small fixed-shape case; this is the general one (a stepper form, a
// details view).
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
  // While something is in flight (a request the user is waiting on), Escape and the backdrop
  // must not close the dialog out from under it — the result would land nowhere.
  dismissible = true,
  labelledBy = 'modal-title',
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissible?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Focus moves into the dialog on open, so keyboard and screen-reader users land in it
    // rather than behind it. The first input if there is one, else the panel itself.
    const first = panelRef.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-modal-close])');
    (first ?? panelRef.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        // Only a click that STARTED on the backdrop — not a text selection dragged out of an input.
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,12,.45)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{
          width: `min(${width}px, 100%)`,
          maxHeight: 'calc(100vh - 32px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(10,10,12,.24)',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 20px 14px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={labelledBy} style={{ margin: 0, font: '600 15px/1.3 var(--font-sans)' }}>
              {title}
            </h2>
            {subtitle && <div style={{ marginTop: 5, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{subtitle}</div>}
          </div>
          <button
            data-modal-close
            aria-label="Close"
            onClick={onClose}
            disabled={!dismissible}
            className="anc-icon-btn"
            style={{
              width: 28,
              height: 28,
              display: 'grid',
              placeItems: 'center',
              border: 0,
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--muted)',
              opacity: dismissible ? 1 : 0.4,
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div style={{ padding: '0 20px 18px', overflowY: 'auto' }}>{children}</div>
        {footer && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 20px',
              borderTop: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: '0 0 12px 12px',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
