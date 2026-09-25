'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { ApiError } from '../../shared/api/client';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { listMembers, Role, TeamMember, updateMemberRole } from './api';
import { RoleBadge } from './RoleBadge';

const ROLES: Role[] = ['owner', 'agent', 'viewer'];

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function MembersPage() {
  const { workspaceId, role: myRole } = useWorkspace();
  const canManage = myRole === 'owner';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listMembers(workspaceId)
      .then(setMembers)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the team.'))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  async function handleRoleChange(userId: number, role: Role) {
    setError(null);
    try {
      await updateMemberRole(workspaceId, userId, role);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role } : m)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change this member\'s role.');
    }
  }

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Team</h1>
      <p style={{ margin: '6px 0 22px', fontSize: 14, color: '#6b6b73' }}>
        Who has access to this workspace, and what they can do.
      </p>

      <ErrorBanner message={error} />

      {loading ? (
        <p style={{ color: '#9a9aa2', fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, overflow: 'hidden' }}>
          {members.map((member, i) => (
            <div
              key={member.userId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                borderBottom: i === members.length - 1 ? 'none' : '1px solid #e7e7e4',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: '#eef1fe',
                  color: '#2542b8',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  flex: 'none',
                }}
              >
                {initials(member.email)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{member.email}</div>
              </div>
              {canManage && member.role !== 'owner' ? (
                <select
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.userId, e.target.value as Role)}
                  style={{ height: 26, borderRadius: 6, border: '1px solid #e7e7e4', fontSize: 12.5 }}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <RoleBadge role={member.role} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
