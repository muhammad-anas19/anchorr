'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Stepper } from '../../shared/ui/Stepper';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { Badge, Card } from '../../shared/ui/primitives';
import { Icon } from '../../shared/ui/Icon';
import { ApiError } from '../../shared/api/client';
import { toMessage, notifySuccess } from '../../shared/ui/toast';
import { clearSession, getToken, setSession } from '../../shared/auth/token';
import { endSession } from '../../shared/auth/session';
import { setPreferredWorkspace } from '../../shared/workspace/preferredWorkspace';
import { login, me } from '../auth/api';
import { RoleBadge } from '../members/RoleBadge';
import {
  acceptInvitation,
  acceptInvitationWithSignup,
  AcceptedMembership,
  InvitationPreview,
  previewInvitation,
} from './api';
import { formatDateTime } from './lifecycle';

const STEPS = [{ label: 'Invitation' }, { label: 'Your account' }, { label: 'Joined' }];

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; preview: InvitationPreview };

// Who is looking at the page, relative to the invitation — decides what step 2 asks for.
type Viewer =
  | { kind: 'checking' }
  | { kind: 'signed-in-match'; email: string }
  | { kind: 'signed-in-other'; email: string }
  | { kind: 'signed-out' };

// The token lives in the URL fragment (#token=…), which browsers never send to any server —
// not to our Next.js server, not in the Referer header. It is read here and sent in POST bodies.
function readToken(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('token');
}

export function AcceptInvitation() {
  const router = useRouter();
  const [token, setTokenState] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [viewer, setViewer] = useState<Viewer>({ kind: 'checking' });
  const [step, setStep] = useState(0);
  const [joined, setJoined] = useState<AcceptedMembership | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  // Re-runs on 'hashchange' as well as on mount. Going from /invite#token=A to /invite#token=B
  // (a second link pasted into the same tab) changes only the fragment, which the browser
  // treats as the SAME document — no reload, no remount. Reading the token once on mount
  // showed invitation A's details and forms for invitation B's link. Found by screenshot.
  useEffect(() => {
    let cancelled = false;
    function start() {
      // (The replaceState to "/invite" after joining does not come through here:
      // history.replaceState never fires 'hashchange'.)
      const found = readToken();
      setTokenState(found);
      setStep(0);
      setJoined(null);
      setError(null);
      setPassword('');
      setConfirm('');
      setViewer({ kind: 'checking' });
      if (!found) {
        setLoad({ kind: 'missing' });
        return;
      }
      setLoad({ kind: 'loading' });
      previewInvitation(found)
        .then((preview) => !cancelled && setLoad({ kind: 'ready', preview }))
        .catch((err) => !cancelled && setLoad({ kind: 'invalid', message: toMessage(err, 'This invitation could not be loaded.') }));
    }
    start();
    window.addEventListener('hashchange', start);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', start);
    };
  }, []);

  const identifyViewer = useCallback(async (invitedEmail: string) => {
    if (!getToken()) {
      setViewer({ kind: 'signed-out' });
      return;
    }
    try {
      const current = await me();
      setViewer(
        current.email === invitedEmail
          ? { kind: 'signed-in-match', email: current.email }
          : { kind: 'signed-in-other', email: current.email },
      );
    } catch {
      // An expired or garbage stored token is the same as being signed out.
      clearSession();
      setViewer({ kind: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    if (load.kind === 'ready') identifyViewer(load.preview.email);
  }, [load, identifyViewer]);

  function finish(result: AcceptedMembership) {
    setJoined(result);
    setStep(2);
    // The token is spent; take it out of the address bar and this history entry.
    window.history.replaceState(null, '', '/invite');
  }

  // Server-side outcomes that end the flow (someone accepted it a moment ago, it was revoked or
  // expired while the page sat open) re-read the invitation so the page shows the new state.
  async function handleFailure(err: unknown) {
    setError(toMessage(err, 'Could not accept the invitation.'));
    if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 410) && token) {
      try {
        setLoad({ kind: 'ready', preview: await previewInvitation(token) });
      } catch (reloadError) {
        setLoad({ kind: 'invalid', message: toMessage(reloadError, 'This invitation is no longer valid.') });
      }
    }
  }

  async function acceptSignedIn() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      finish(await acceptInvitation(token));
    } catch (err) {
      await handleFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function signInAndAccept(event: FormEvent) {
    event.preventDefault();
    if (!token || load.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      setSession(await login(load.preview.email, password));
      finish(await acceptInvitation(token));
    } catch (err) {
      await handleFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function createAccountAndAccept(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvitationWithSignup(token, password);
      setSession(result);
      finish(result);
    } catch (err) {
      await handleFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function signOutForThisInvite() {
    // Revokes the refresh token server-side too, not just locally — otherwise signing out to
    // accept an invite as someone else would leave the previous session's token alive.
    void endSession();
    setViewer({ kind: 'signed-out' });
    setError(null);
  }

  function goToWorkspace() {
    if (!joined) return;
    setPreferredWorkspace(joined.workspaceId);
    notifySuccess('Welcome aboard.');
    router.push('/documents');
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '32px 16px', background: 'var(--bg)' }}>
      <div style={{ width: 'min(520px, 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, font: '600 15px/1 var(--font-sans)' }}>
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--btn-bg)',
              color: 'var(--btn-fg)',
            }}
          >
            <Icon name="mail" size={14} />
          </span>
          Anchor
        </div>

        <Card padding="24px 26px">
          {load.kind === 'loading' && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>Checking your invitation…</p>}

          {load.kind === 'missing' && (
            <Terminal
              title="This invitation link is incomplete"
              body="Open the link straight from the invitation email. If you copied it by hand, part of it may be missing."
            />
          )}

          {load.kind === 'invalid' && <Terminal title="This invitation can't be used" body={load.message} />}

          {load.kind === 'ready' && step < 2 && load.preview.status !== 'pending' && (
            <Terminal
              title={
                load.preview.status === 'accepted'
                  ? 'This invitation has already been accepted'
                  : load.preview.status === 'expired'
                    ? 'This invitation has expired'
                    : 'This invitation was revoked'
              }
              body={
                load.preview.status === 'accepted'
                  ? `If that was you, sign in as ${load.preview.email} to open ${load.preview.workspaceName}.`
                  : `Ask ${load.preview.invitedByEmail ?? 'the person who invited you'} to send a new invitation.`
              }
              action={
                load.preview.status === 'accepted' ? <Button onClick={() => router.push('/login')}>Go to sign in</Button> : undefined
              }
            />
          )}

          {load.kind === 'ready' && (load.preview.status === 'pending' || step === 2) && (
            <>
              <div style={{ marginBottom: 22 }}>
                <Stepper steps={STEPS} current={step} />
              </div>

              {step === 0 && (
                <div style={{ display: 'grid', gap: 16 }}>
                  <div>
                    <h1 style={{ margin: 0, font: '600 18px/1.35 var(--font-sans)' }}>
                      Join <span style={{ color: 'var(--accent-fg)' }}>{load.preview.workspaceName}</span>
                    </h1>
                    <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                      {load.preview.invitedByEmail ?? 'A teammate'} invited you to join as{' '}
                      <strong style={{ color: 'var(--fg)' }}>{load.preview.role}</strong>.
                    </p>
                  </div>
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: 9, fontSize: 13 }}>
                    <dt style={{ color: 'var(--muted)' }}>Invited email</dt>
                    <dd style={{ margin: 0, fontWeight: 500, wordBreak: 'break-all' }}>{load.preview.email}</dd>
                    <dt style={{ color: 'var(--muted)' }}>Role</dt>
                    <dd style={{ margin: 0 }}>
                      <RoleBadge role={load.preview.role} />
                    </dd>
                    <dt style={{ color: 'var(--muted)' }}>Expires</dt>
                    <dd style={{ margin: 0 }}>{formatDateTime(load.preview.expiresAt)}</dd>
                  </dl>
                  <Button onClick={() => setStep(1)}>Continue</Button>
                </div>
              )}

              {step === 1 && (
                <div style={{ display: 'grid', gap: 14 }}>
                  <ErrorBanner message={error} />

                  {viewer.kind === 'checking' && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Checking who you are…</p>}

                  {viewer.kind === 'signed-in-match' && (
                    <>
                      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
                        You're signed in as <strong>{viewer.email}</strong> — the address this invitation was sent to.
                      </p>
                      <Button onClick={acceptSignedIn} disabled={busy}>
                        {busy ? 'Joining…' : `Accept and join ${load.preview.workspaceName}`}
                      </Button>
                    </>
                  )}

                  {viewer.kind === 'signed-in-other' && (
                    <>
                      <div
                        role="alert"
                        style={{
                          padding: '11px 13px',
                          borderRadius: 8,
                          background: 'var(--warn-soft)',
                          color: 'var(--warn)',
                          fontSize: 13,
                          lineHeight: 1.55,
                        }}
                      >
                        You're signed in as <strong>{viewer.email}</strong>, but this invitation is for{' '}
                        <strong>{load.preview.email}</strong>. Only that account can accept it.
                      </div>
                      <Button onClick={signOutForThisInvite}>Sign out and continue as {load.preview.email}</Button>
                    </>
                  )}

                  {viewer.kind === 'signed-out' && load.preview.accountExists && (
                    <form onSubmit={signInAndAccept} style={{ display: 'grid', gap: 10 }}>
                      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
                        You already have an Anchor account. Sign in to accept.
                      </p>
                      <TextField value={load.preview.email} readOnly aria-label="Email" style={{ color: 'var(--muted)' }} />
                      <TextField
                        type="password"
                        placeholder="Password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                      <Button type="submit" disabled={busy || !password}>
                        {busy ? 'Signing in…' : 'Sign in and join'}
                      </Button>
                    </form>
                  )}

                  {viewer.kind === 'signed-out' && !load.preview.accountExists && (
                    <form onSubmit={createAccountAndAccept} style={{ display: 'grid', gap: 10 }}>
                      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
                        Choose a password to create your account. Your email is already confirmed — you opened this link
                        from it.
                      </p>
                      <TextField value={load.preview.email} readOnly aria-label="Email" style={{ color: 'var(--muted)' }} />
                      <TextField
                        type="password"
                        placeholder="Password (at least 8 characters)"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                      <TextField
                        type="password"
                        placeholder="Confirm password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        required
                      />
                      <Button type="submit" disabled={busy || !password || !confirm}>
                        {busy ? 'Creating your account…' : 'Create account and join'}
                      </Button>
                    </form>
                  )}

                  <button
                    onClick={() => {
                      setStep(0);
                      setError(null);
                    }}
                    disabled={busy}
                    style={{ all: 'unset', cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)', justifySelf: 'start' }}
                  >
                    ← Back
                  </button>
                </div>
              )}

              {step === 2 && joined && (
                <div style={{ display: 'grid', gap: 14, justifyItems: 'start' }}>
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--ok-soft)',
                      color: 'var(--ok)',
                    }}
                  >
                    <Icon name="check" size={20} strokeWidth={2} />
                  </span>
                  <div>
                    <h1 style={{ margin: 0, font: '600 18px/1.35 var(--font-sans)' }}>
                      {joined.alreadyMember ? "You're already a member" : "You're in"}
                    </h1>
                    <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                      {joined.alreadyMember
                        ? `You were already part of ${load.preview.workspaceName}, so your existing role was kept.`
                        : `You joined ${load.preview.workspaceName}.`}{' '}
                      Your role is <Badge tone="accent">{joined.role}</Badge>
                    </p>
                  </div>
                  <Button onClick={goToWorkspace}>Open {load.preview.workspaceName}</Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </main>
  );
}

function Terminal({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--warn-soft)',
          color: 'var(--warn)',
        }}
      >
        <Icon name="alert" size={18} />
      </span>
      <h1 style={{ margin: 0, font: '600 17px/1.35 var(--font-sans)' }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55 }}>{body}</p>
      {action}
    </div>
  );
}
