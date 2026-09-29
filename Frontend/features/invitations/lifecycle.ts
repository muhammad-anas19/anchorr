import type { TimelineItem } from '../../shared/ui/Timeline';
import type { Invitation } from './api';

// Turns one invitation row into the stages it has been through. Every stage is derived from a
// real column — nothing here is inferred or decorative:
//   created      ← createdAt, invitedByEmail
//   email        ← emailStatus / emailSentAt / emailLastError / sendCount
//   outcome      ← status + acceptedAt / revokedAt / expiresAt
export function invitationStages(invitation: Invitation, now = Date.now()): TimelineItem[] {
  const stages: TimelineItem[] = [
    {
      key: 'created',
      title: 'Invitation created',
      detail: invitation.invitedByEmail ? `by ${invitation.invitedByEmail}` : 'by a former member',
      time: formatDateTime(invitation.createdAt),
      state: 'done',
    },
    emailStage(invitation),
  ];

  switch (invitation.status) {
    case 'accepted':
      stages.push({
        key: 'outcome',
        title: 'Accepted — joined the workspace',
        detail: invitation.acceptedByEmail ? `as ${invitation.acceptedByEmail}` : undefined,
        time: invitation.acceptedAt ? formatDateTime(invitation.acceptedAt) : undefined,
        state: 'done',
      });
      break;
    case 'revoked':
      stages.push({
        key: 'outcome',
        title: 'Revoked',
        detail: 'The link no longer works.',
        time: invitation.revokedAt ? formatDateTime(invitation.revokedAt) : undefined,
        state: 'failed',
      });
      break;
    case 'expired':
      stages.push({
        key: 'outcome',
        title: 'Expired without being accepted',
        detail: 'Resend it to issue a fresh 7-day link.',
        time: formatDateTime(invitation.expiresAt),
        state: 'failed',
      });
      break;
    default:
      stages.push({
        key: 'outcome',
        title: 'Waiting for them to accept',
        detail: `Link expires ${formatRelative(invitation.expiresAt, now)}.`,
        state: invitation.emailStatus === 'sent' ? 'active' : 'pending',
      });
  }
  return stages;
}

function emailStage(invitation: Invitation): TimelineItem {
  const attempt = invitation.sendCount > 1 ? ` (send #${invitation.sendCount})` : '';
  if (invitation.emailStatus === 'sent') {
    return {
      key: 'email',
      title: `Email sent to mail server${attempt}`,
      detail: `Accepted for delivery to ${invitation.email}. Whether it reached the inbox or spam isn't visible over SMTP.`,
      time: invitation.emailSentAt ? formatDateTime(invitation.emailSentAt) : undefined,
      state: 'done',
    };
  }
  if (invitation.emailStatus === 'failed') {
    return {
      key: 'email',
      title: `Email could not be sent${attempt}`,
      detail: invitation.emailLastError ?? 'The mail server rejected it after several attempts.',
      state: 'failed',
    };
  }
  // Queued. Terminal states make "still sending" meaningless, so it is shown as skipped there.
  const settled = invitation.status !== 'pending';
  return {
    key: 'email',
    title: `Email queued${attempt}`,
    detail: settled ? undefined : invitation.emailLastError ? `Retrying — ${invitation.emailLastError}` : 'Handing it to the mail server…',
    state: settled ? 'skipped' : 'active',
  };
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diffMs = new Date(iso).getTime() - now;
  const future = diffMs >= 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  const unit =
    minutes < 60 ? `${minutes} min` : minutes < 60 * 48 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return future ? `in ${unit}` : `${unit} ago`;
}
