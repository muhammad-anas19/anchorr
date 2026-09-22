import type { ReactNode } from 'react';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>{title}</h1>
      {children}
    </main>
  );
}
