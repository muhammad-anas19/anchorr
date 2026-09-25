import { WidgetSettingsPage } from '../../features/widgetSettings/WidgetSettingsPage';
import { DashboardShell } from '../../shared/workspace/DashboardShell';

export default function Widget() {
  return (
    <DashboardShell>
      <WidgetSettingsPage />
    </DashboardShell>
  );
}
