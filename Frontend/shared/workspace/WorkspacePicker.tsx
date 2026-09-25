import type { Membership } from '../../features/auth/api';
import { Button } from '../ui/Button';

export function WorkspacePicker({
  memberships,
  onSelect,
}: {
  memberships: Membership[];
  onSelect: (workspaceId: number) => void;
}) {
  return (
    <main style={{ maxWidth: 400, margin: '80px auto' }}>
      <h1 style={{ fontSize: 18 }}>Choose a workspace</h1>
      {memberships.map((m) => (
        <Button
          key={m.workspaceId}
          variant="secondary"
          onClick={() => onSelect(m.workspaceId)}
          style={{ display: 'block', width: '100%', marginTop: 8, textAlign: 'left' }}
        >
          {m.workspaceName}
        </Button>
      ))}
    </main>
  );
}
