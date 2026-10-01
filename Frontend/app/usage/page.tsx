import { UsagePage } from '../../features/usage/UsagePage';
import { DashboardShell } from '../../shared/workspace/DashboardShell';

export default function Usage() {
  return (
    <DashboardShell>
      <UsagePage />
    </DashboardShell>
  );
}
