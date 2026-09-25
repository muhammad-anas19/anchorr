'use client';

import { Toaster } from 'react-hot-toast';

// Mounted once, in the root layout. Styled from the design tokens rather than the library's
// own defaults, so toasts follow the theme like everything else — a white default toast on
// the dark theme would be the one thing on screen that ignored it.
export function ToastHost() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 3500,
        style: {
          background: 'var(--surface)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow)',
          borderRadius: 9,
          fontSize: 13,
          maxWidth: 380,
        },
        success: { iconTheme: { primary: 'var(--ok)', secondary: 'var(--surface)' } },
        error: {
          // Errors stay longer: a failure usually needs reading, a success only glancing at.
          duration: 5000,
          iconTheme: { primary: 'var(--err)', secondary: 'var(--surface)' },
        },
      }}
    />
  );
}
