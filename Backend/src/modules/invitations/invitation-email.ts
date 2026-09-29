import { EmailMessage } from '../../email/email-sender.interface';
import { MembershipRole } from '../../database/entities/membership-role.enum';

interface InvitationEmailInput {
  to: string;
  workspaceName: string;
  inviterEmail: string | null;
  role: MembershipRole;
  link: string;
  expiresAt: Date;
}

// The workspace name and inviter email are USER-CONTROLLED text going into HTML. Unescaped, a
// workspace named `<a href="https://evil.example">Click to verify your account</a>` turns our
// own, legitimately-sent invitation into a phishing email from our domain. Same injection
// shape as SQL injection (Phase 3's diagnostic): untrusted text concatenated into a language
// with its own syntax. The plain-text part needs no escaping — it is never interpreted.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const who = input.inviterEmail ?? 'A teammate';
  const expires = input.expiresAt.toUTCString();
  const subject = `You've been invited to join ${input.workspaceName} on Anchor`;

  const text = [
    `${who} invited you to join the "${input.workspaceName}" workspace on Anchor as ${articleFor(input.role)} ${input.role}.`,
    '',
    `Accept the invitation: ${input.link}`,
    '',
    `This link works once and expires ${expires}. If you weren't expecting it, you can ignore this email.`,
  ].join('\n');

  const html = `
    <p>${escapeHtml(who)} invited you to join the <strong>${escapeHtml(input.workspaceName)}</strong>
       workspace on Anchor as ${articleFor(input.role)} <strong>${input.role}</strong>.</p>
    <p><a href="${escapeHtml(input.link)}">Accept the invitation</a></p>
    <p style="color:#666;font-size:13px">This link works once and expires ${escapeHtml(expires)}.
       If you weren't expecting it, you can ignore this email.</p>`;

  return { to: input.to, subject, text, html };
}

function articleFor(role: MembershipRole): string {
  return role === MembershipRole.OWNER || role === MembershipRole.AGENT ? 'an' : 'a';
}
