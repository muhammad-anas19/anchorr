'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { register } from './api';
import { ApiError } from '../../shared/api/client';
import { setToken } from '../../shared/auth/token';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';

export function RegisterForm() {
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Registering creates the workspace itself and makes this user its owner
      // (AuthService.register, Phase 2) — there's no separate "create a workspace" step.
      const { accessToken } = await register(email, password, workspaceName);
      setToken(accessToken);
      router.push('/console');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TextField
        type="text"
        placeholder="Workspace name"
        value={workspaceName}
        onChange={(e) => setWorkspaceName(e.target.value)}
        required
      />
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
        minLength={8}
      />
      <ErrorBanner message={error} />
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Creating workspace…' : 'Create workspace'}
      </Button>
      <p style={{ fontSize: 13, color: '#6b7280' }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
