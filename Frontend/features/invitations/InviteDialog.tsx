'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Modal } from '../../shared/ui/Modal';
import { Stepper } from '../../shared/ui/Stepper';
import { Timeline } from '../../shared/ui/Timeline';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { Badge } from '../../shared/ui/primitives';
import { ApiError } from '../../shared/api/client';
import { toMessage } from '../../shared/ui/toast';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { listRoles, Role, ROLE_RANK, RolePermissions } from '../members/api';
import { createInvitation, getInvitation, Invitation } from './api';
import { invitationStages } from './lifecycle';

const STEPS = [
  { label: 'Who', hint: 'Their email' },
  { label: 'Role', hint: 'What they can do' },
  { label: 'Review', hint: 'Check and send' },
  { label: 'Sent', hint: 'Delivery status' },
];

const ROLE_SUMMARY: Record<Role, string> = {
  owner: 'Full control, including billing-level settings, members and ownership.',
  agent: 'Handles escalated conversations and manages the knowledge base.',
  viewer: 'Read-only: sees documents and the team, and can test the assistant.',
};

// A basic shape check so obvious typos are caught before a round trip. The server's @IsEmail is
// the real validator; this only decides whether "Next" is worth pressing.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const POLL_MS = 1000;
const POLL_LIMIT = 45;

export function InviteDialog({
  open,
  onClose,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  // Lets the page refresh its invitations list and counts the moment one is created.
  onInvited: (invitation: Invitation) => void;
}) {
  const { workspaceId, workspaceName, role: myRole } = useWorkspace();
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [roles, setRoles] = useState<RolePermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [trackingGaveUp, setTrackingGaveUp] = useState(false);

  const reset = useCallback(() => {
    setStep(0);
    setEmail('');
    setRole('agent');
    setError(null);
    setSending(false);
    setInvitation(null);
    setTrackingGaveUp(false);
  }, []);

  // Fresh form each time it opens, so "Invite another" and reopening behave the same way.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open || roles) return;
    listRoles(workspaceId)
      .then(setRoles)
      .catch(() => setRoles([]));
  }, [open, roles, workspaceId]);

  // Step 4: follow the email from "queued" to "sent" (or "failed"). Polling, because the worker
  // reports into the database and there is no push channel to the inviter's browser for it.
  // Bounded: an email that stays queued for 45 s is shown as "still queued", not polled forever.
  useEffect(() => {
    if (step !== 3 || !invitation || invitation.emailStatus !== 'queued') return;
    const controller = new AbortController();
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        const latest = await getInvitation(workspaceId, invitation.id, controller.signal);
        setInvitation(latest);
        if (latest.emailStatus !== 'queued') clearInterval(timer);
      } catch {
        // A failed poll is not the email failing; the next tick tries again.
      }
      if (attempts >= POLL_LIMIT) {
        clearInterval(timer);
        setTrackingGaveUp(true);
      }
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [step, invitation, workspaceId]);

  const emailValid = EMAIL_SHAPE.test(email.trim());

  function next(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    if (step === 0 && !emailValid) {
      setError('Enter a valid email address.');
      return;
    }
    setStep((s) => s + 1);
  }

  async function send() {
    setError(null);
    setSending(true);
    try {
      const created = await createInvitation(workspaceId, email.trim(), role);
      setInvitation(created);
      onInvited(created);
      setStep(3);
    } catch (err) {
      // Send the user back to the step that can fix the problem, with the server's own words.
      const message = toMessage(err, 'Could not send the invitation.');
      if (err instanceof ApiError && err.status === 409) setStep(0); // already a member / already invited
      else if (err instanceof ApiError && err.status === 403) setStep(1); // role above your own
      setError(message);
    } finally {
      setSending(false);
    }
  }

  const footer = (
    <>
      {step > 0 && step < 3 && (
        <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={sending}>
          Back
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {step < 2 && (
        <Button onClick={() => next()} disabled={step === 0 && !email.trim()}>
          Next
        </Button>
      )}
      {step === 2 && (
        <Button onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send invitation'}
        </Button>
      )}
      {step === 3 && (
        <>
          <Button variant="secondary" onClick={reset}>
            Invite another
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!sending}
      title="Invite people"
      subtitle={`Add someone to ${workspaceName}. They join only after accepting the emailed link.`}
      footer={footer}
      width={600}
      labelledBy="invite-title"
    >
      <div style={{ padding: '6px 0 20px' }}>
        <Stepper steps={STEPS} current={step} failedAt={invitation?.emailStatus === 'failed' ? 3 : undefined} />
      </div>

      <ErrorBanner message={error} />

      {step === 0 && (
        <form onSubmit={next} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: error ? 12 : 0 }}>
          <label htmlFor="invite-email" style={{ font: '500 12.5px/1 var(--font-sans)' }}>
            Email address
          </label>
          <TextField
            id="invite-email"
            type="email"
            autoComplete="off"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%' }}
          />
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            The invitation is tied to this address: only an account with this email can accept it, even if the link
            is forwarded.
          </p>
        </form>
      )}

      {step === 1 && (
        <div role="radiogroup" aria-label="Role" style={{ display: 'grid', gap: 10, marginTop: error ? 12 : 0 }}>
          {(['viewer', 'agent', 'owner'] as Role[]).map((option) => {
            const aboveMine = ROLE_RANK[option] > ROLE_RANK[myRole];
            const selected = role === option;
            const permissions = roles?.find((r) => r.role === option)?.permissions ?? [];
            return (
              <button
                key={option}
                role="radio"
                aria-checked={selected}
                disabled={aboveMine}
                onClick={() => setRole(option)}
                className={aboveMine ? undefined : 'anc-border-hover'}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 9,
                  border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected ? 'var(--accent-soft)' : 'var(--surface)',
                  color: 'var(--fg)',
                  opacity: aboveMine ? 0.5 : 1,
                  cursor: aboveMine ? 'not-allowed' : 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-2)'}`,
                      boxShadow: selected ? 'inset 0 0 0 3px var(--surface)' : undefined,
                      background: selected ? 'var(--accent)' : 'transparent',
                    }}
                  />
                  <span style={{ font: '600 13px/1 var(--font-sans)', textTransform: 'capitalize' }}>{option}</span>
                  {aboveMine && <Badge>Above your role</Badge>}
                </div>
                <div style={{ margin: '6px 0 0 22px', fontSize: 12.5, color: 'var(--muted)' }}>{ROLE_SUMMARY[option]}</div>
                {permissions.length > 0 && (
                  <ul style={{ margin: '8px 0 0 22px', padding: 0, listStyle: 'none', display: 'grid', gap: 3 }}>
                    {permissions.map((p) => (
                      <li key={p.key} style={{ display: 'flex', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                        <span style={{ color: 'var(--ok)' }}>✓</span>
                        {p.description}
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            );
          })}
          {roles === null && <p style={{ fontSize: 12, color: 'var(--faint)' }}>Loading what each role can do…</p>}
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: 12, marginTop: error ? 12 : 0 }}>
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              rowGap: 10,
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 9,
              background: 'var(--surface-2)',
              fontSize: 13,
            }}
          >
            <dt style={{ color: 'var(--muted)' }}>Invitee</dt>
            <dd style={{ margin: 0, fontWeight: 500, wordBreak: 'break-all' }}>{email.trim().toLowerCase()}</dd>
            <dt style={{ color: 'var(--muted)' }}>Role</dt>
            <dd style={{ margin: 0, textTransform: 'capitalize' }}>{role}</dd>
            <dt style={{ color: 'var(--muted)' }}>Workspace</dt>
            <dd style={{ margin: 0 }}>{workspaceName}</dd>
            <dt style={{ color: 'var(--muted)' }}>Link valid for</dt>
            <dd style={{ margin: 0 }}>7 days, single use</dd>
          </dl>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
            They'll get an email with a one-time link. If they already have an Anchor account they sign in to accept;
            otherwise they choose a password. They appear under Members once they accept.
          </p>
        </div>
      )}

      {step === 3 && invitation && (
        <div style={{ display: 'grid', gap: 14 }}>
          <Timeline items={invitationStages(invitation)} />
          {trackingGaveUp && invitation.emailStatus === 'queued' && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
              Still queued after {POLL_LIMIT} seconds. The queue keeps retrying in the background — check the
              Invitations tab later.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
