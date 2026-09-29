'use client';

import { useState } from 'react';
import { DataTable, type Column } from '../../shared/ui/DataTable';
import { Avatar, Badge, Select } from '../../shared/ui/primitives';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { IconButton } from '../../shared/ui/IconButton';
import { useFetch } from '../../shared/hooks/useFetch';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { listMembers, removeMember, Role, TeamMember, transferOwnership, updateMemberRole } from './api';
import { RoleBadge } from './RoleBadge';

const PAGE_SIZE = 10;
const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'agent', label: 'Agent' },
  { value: 'viewer', label: 'Viewer' },
];

type PendingAction = { kind: 'remove' | 'transfer'; member: TeamMember } | null;

export function MembersTab({ onChanged }: { onChanged: () => void }) {
  const { workspaceId, userId: myUserId, can } = useWorkspace();
  const [searchInput, setSearchInput] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const search = useDebouncedValue(searchInput.trim(), 300);

  const params = { page, pageSize: PAGE_SIZE, search: search || undefined, role: roleFilter === 'all' ? undefined : roleFilter };
  const { data, loading, error, refetch } = useFetch(
    (signal) => listMembers(workspaceId, params, signal),
    JSON.stringify({ workspaceId, ...params }),
  );

  const canManage = can('members.manage');
  const canTransfer = can('workspace.transfer_ownership');

  async function changeRole(member: TeamMember, role: Role) {
    if (role === member.role) return;
    try {
      await updateMemberRole(workspaceId, member.userId, role);
      notifySuccess(`${member.email} is now ${role}.`);
    } catch (err) {
      // The server refuses demoting the last owner (409) — its message says exactly why.
      notifyError(err, "Could not change this member's role.");
    }
    // Refetch either way: success moves the row (the list is ordered by role), failure puts
    // the select back to the value the server actually holds.
    refetch();
    onChanged();
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'remove') {
        await removeMember(workspaceId, pending.member.userId);
        notifySuccess(`Removed ${pending.member.email}. Their claimed conversations went back to the queue.`);
      } else {
        await transferOwnership(workspaceId, pending.member.userId);
        notifySuccess(`${pending.member.email} now owns this workspace. You are an agent.`);
        // Your own permissions just changed; the shell reads them once, from /auth/me.
        window.location.reload();
        return;
      }
      setPending(null);
      refetch();
      onChanged();
    } catch (err) {
      notifyError(err, pending.kind === 'remove' ? 'Could not remove this member.' : 'Could not transfer ownership.');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<TeamMember>[] = [
    {
      key: 'member',
      header: 'Member',
      width: 'minmax(220px, 1fr)',
      render: (member) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Avatar label={member.email} tone={member.role === 'owner' ? 'accent' : 'neutral'} />
          <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {member.email}
          </span>
          {member.userId === myUserId && <Badge tone="accent">You</Badge>}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '130px',
      render: (member) =>
        canManage && member.userId !== myUserId ? (
          <Select
            ariaLabel={`Role for ${member.email}`}
            value={member.role}
            onChange={(role) => changeRole(member, role)}
            options={ROLE_OPTIONS}
          />
        ) : (
          <RoleBadge role={member.role} />
        ),
    },
    {
      key: 'joined',
      header: 'Joined',
      width: '120px',
      render: (member) => (
        <span style={{ font: '400 12px/1 var(--font-mono)', color: 'var(--muted)' }}>
          {new Date(member.joinedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '84px',
      align: 'right',
      render: (member) =>
        member.userId === myUserId ? null : (
          <div style={{ display: 'inline-flex', gap: 4 }}>
            {canTransfer && member.role !== 'owner' && (
              <IconButton label={`Make ${member.email} the owner`} icon="crown" onClick={() => setPending({ kind: 'transfer', member })} />
            )}
            {canManage && (
              <IconButton label={`Remove ${member.email}`} icon="trash" danger onClick={() => setPending({ kind: 'remove', member })} />
            )}
          </div>
        ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(member) => member.userId}
        loading={loading}
        emptyMessage={error ?? (search || roleFilter !== 'all' ? 'No members match these filters.' : 'No members yet.')}
        search={{
          value: searchInput,
          onChange: (value) => {
            setSearchInput(value);
            setPage(1);
          },
          placeholder: 'Search by email',
        }}
        filters={[
          {
            ariaLabel: 'Filter by role',
            value: roleFilter,
            onChange: (value) => {
              setRoleFilter(value as Role | 'all');
              setPage(1);
            },
            options: [{ value: 'all', label: 'All roles' }, ...ROLE_OPTIONS],
          },
        ]}
        pagination={
          data
            ? { page: data.page, totalPages: data.totalPages, total: data.total, pageSize: data.pageSize, onPageChange: setPage }
            : undefined
        }
      />

      <ConfirmDialog
        open={pending?.kind === 'remove'}
        title={`Remove ${pending?.member.email}?`}
        body={
          <>
            They lose access immediately, including any console tab they have open. Conversations they had claimed go back
            to the queue for another agent. You can invite them again later.
          </>
        }
        confirmLabel="Remove member"
        busy={busy}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending?.kind === 'transfer'}
        title={`Make ${pending?.member.email} the owner?`}
        body={
          <>
            They become an owner and <strong>you become an agent</strong> in one step. You will lose owner-only access
            (members, invitations, widget settings) unless they give it back.
          </>
        }
        confirmLabel="Transfer ownership"
        busy={busy}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
