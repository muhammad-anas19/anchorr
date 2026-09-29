import { AcceptInvitation } from '../../features/invitations/AcceptInvitation';

// Outside DashboardShell on purpose: the person opening this is usually not a member of any
// workspace yet — and may not have an account at all.
export default function InvitePage() {
  return <AcceptInvitation />;
}
