'use client';

import { Modal } from '../../shared/ui/Modal';
import { Timeline } from '../../shared/ui/Timeline';
import { Button } from '../../shared/ui/Button';
import { Badge } from '../../shared/ui/primitives';
import type { Invitation } from './api';
import { invitationStages, formatDateTime } from './lifecycle';
import { invitationStatusTone } from './InvitationProgress';

export function InvitationDetailsDialog({
  invitation,
  onClose,
  onResend,
  onRevoke,
  busy,
}: {
  invitation: Invitation | null;
  onClose: () => void;
  onResend: (invitation: Invitation) => void;
  onRevoke: (invitation: Invitation) => void;
  busy: boolean;
}) {
  const open = invitation !== null;
  const actionable = invitation?.status === 'pending' || invitation?.status === 'expired';

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      labelledBy="invitation-details-title"
      title={invitation ? invitation.email : ''}
      subtitle={
        invitation && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Badge tone={invitationStatusTone(invitation.status)}>{invitation.status}</Badge>
            <span style={{ textTransform: 'capitalize' }}>{invitation.role}</span>
            <span>· sent {invitation.sendCount}×</span>
          </span>
        )
      }
      footer={
        invitation &&
        actionable && (
          <>
            {invitation.status === 'pending' && (
              <Button variant="secondary" onClick={() => onRevoke(invitation)} disabled={busy} style={{ color: 'var(--err)' }}>
                Revoke
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Button onClick={() => onResend(invitation)} disabled={busy}>
              {busy ? 'Working…' : invitation.status === 'expired' ? 'Resend with a new link' : 'Resend'}
            </Button>
          </>
        )
      }
    >
      {invitation && (
        <div style={{ display: 'grid', gap: 16 }}>
          <Timeline items={invitationStages(invitation)} />
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
            Resending issues a <strong>new</strong> link and a fresh 7-day expiry — the previous link stops working at
            once, which is what you want if the first email went to the wrong place. Last sent{' '}
            {formatDateTime(invitation.lastSentAt)}.
          </p>
        </div>
      )}
    </Modal>
  );
}
