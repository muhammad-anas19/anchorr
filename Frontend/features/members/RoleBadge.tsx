import { Badge, type Tone } from '../../shared/ui/primitives';
import type { Role } from './api';

const LABELS: Record<Role, string> = { owner: 'Owner', agent: 'Agent', viewer: 'Viewer' };
const TONES: Record<Role, Tone> = { owner: 'accent', agent: 'ok', viewer: 'neutral' };

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={TONES[role]}>{LABELS[role]}</Badge>;
}
