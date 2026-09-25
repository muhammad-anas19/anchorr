import { MembersPage } from '../../features/members/MembersPage';
import { DashboardShell } from '../../shared/workspace/DashboardShell';

export default function Team() {
  return (
    <DashboardShell>
      <MembersPage />
    </DashboardShell>
  );
}
