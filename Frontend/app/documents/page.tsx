import { DocumentsPage } from '../../features/documents/DocumentsPage';
import { DashboardShell } from '../../shared/workspace/DashboardShell';

export default function Documents() {
  return (
    <DashboardShell>
      <DocumentsPage />
    </DashboardShell>
  );
}
