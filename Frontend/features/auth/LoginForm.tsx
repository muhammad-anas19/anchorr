'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { login } from './api';
import { notifySuccess, toMessage } from '../../shared/ui/toast';
import { setToken } from '../../shared/auth/token';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { accessToken } = await login(email, password);
      setToken(accessToken);
      notifySuccess('Signed in.');
      router.push('/documents');
    } catch (err) {
      // Inline, not a toast: a rejected sign-in belongs next to the fields that produced it,
      // and a corner toast is easy to miss while looking at the form.
      setError(toMessage(err, 'Something went wrong.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TextField
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <TextField
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <ErrorBanner message={error} />
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <p style={{ fontSize: 13, color: '#6b7280' }}>
        No account yet? <Link href="/register">Register</Link>
      </p>
    </form>
  );
}
