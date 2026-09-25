import { PlaygroundPage } from '../../features/playground/PlaygroundPage';
import { DashboardShell } from '../../shared/workspace/DashboardShell';

export default function Playground() {
  return (
    <DashboardShell>
      <PlaygroundPage />
    </DashboardShell>
  );
}
