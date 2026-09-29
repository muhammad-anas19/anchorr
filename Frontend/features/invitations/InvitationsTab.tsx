'use client';

import { useEffect, useState } from 'react';
import { DataTable, type Column } from '../../shared/ui/DataTable';
import { Badge, Tabs } from '../../shared/ui/primitives';
import { IconButton } from '../../shared/ui/IconButton';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useFetch } from '../../shared/hooks/useFetch';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { RoleBadge } from '../members/RoleBadge';
import { Invitation, InvitationStatus, listInvitations, resendInvitation, revokeInvitation } from './api';
import { InvitationProgress, invitationStatusTone } from './InvitationProgress';
import { InvitationDetailsDialog } from './InvitationDetailsDialog';
import { formatDateTime, formatRelative } from './lifecycle';

const PAGE_SIZE = 10;
const REFRESH_WHILE_SENDING_MS = 2000;

type Tab = InvitationStatus | 'all';
const TABS: { value: Tab; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'expired', label: 'Expired' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'all', label: 'All' },
];

export function InvitationsTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { workspaceId } = useWorkspace();
  const [tab, setTab] = useState<Tab>('pending');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Invitation | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const search = useDebouncedValue(searchInput.trim(), 300);

  const params = { page, pageSize: PAGE_SIZE, status: tab === 'all' ? undefined : tab, search: search || undefined };
  const { data, loading, error, refetch } = useFetch(
    (signal) => listInvitations(workspaceId, params, signal),
    JSON.stringify({ workspaceId, refreshKey, ...params }),
  );

  // While an email on this page is still queued, refresh quietly so its row moves to "sent"
  // (or "failed") on its own. Stops by itself once nothing is in flight.
  const anySending = data?.items.some((i) => i.status === 'pending' && i.emailStatus === 'queued') ?? false;
  useEffect(() => {
    if (!anySending) return;
    const timer = setInterval(refetch, REFRESH_WHILE_SENDING_MS);
    return () => clearInterval(timer);
  }, [anySending, refetch]);

  // Keep an open details dialog in step with the list, rather than frozen at the moment it opened.
  useEffect(() => {
    if (!selected || !data) return;
    const fresh = data.items.find((i) => i.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [data, selected]);

  async function resend(invitation: Invitation) {
    setBusy(true);
    try {
      const updated = await resendInvitation(workspaceId, invitation.id);
      notifySuccess(`Sent a new link to ${invitation.email}. The previous link no longer works.`);
      if (selected?.id === invitation.id) setSelected(updated);
      refetch();
      onChanged();
    } catch (err) {
      notifyError(err, 'Could not resend this invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await revokeInvitation(workspaceId, revoking.id);
      notifySuccess(`Revoked the invitation for ${revoking.email}.`);
      setRevoking(null);
      setSelected(null);
      refetch();
      onChanged();
    } catch (err) {
      notifyError(err, 'Could not revoke this invitation.');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Invitation>[] = [
    {
      key: 'invitee',
      header: 'Invitee',
      width: 'minmax(220px, 1fr)',
      render: (invitation) => (
        <button
          onClick={() => setSelected(invitation)}
          style={{ all: 'unset', cursor: 'pointer', display: 'block', minWidth: 0, maxWidth: '100%' }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {invitation.email}
          </div>
          <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--faint)' }}>
            {invitation.invitedByEmail ? `by ${invitation.invitedByEmail}` : 'by a former member'} · {formatDateTime(invitation.createdAt)}
          </div>
        </button>
      ),
    },
    { key: 'role', header: 'Role', width: '90px', render: (invitation) => <RoleBadge role={invitation.role} /> },
    { key: 'progress', header: 'Progress', width: '170px', render: (invitation) => <InvitationProgress invitation={invitation} /> },
    {
      key: 'status',
      header: 'Status',
      width: '150px',
      render: (invitation) => (
        <div>
          <Badge tone={invitationStatusTone(invitation.status)}>{invitation.status}</Badge>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--faint)' }}>{statusDetail(invitation)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '104px',
      align: 'right',
      render: (invitation) => (
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <IconButton label={`Details for ${invitation.email}`} icon="eye" onClick={() => setSelected(invitation)} />
          {(invitation.status === 'pending' || invitation.status === 'expired') && (
            <IconButton label={`Resend to ${invitation.email}`} icon="refresh" disabled={busy} onClick={() => resend(invitation)} />
          )}
          {invitation.status === 'pending' && (
            <IconButton label={`Revoke invitation for ${invitation.email}`} icon="close" danger onClick={() => setRevoking(invitation)} />
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
        rowKey={(invitation) => invitation.id}
        loading={loading}
        minWidth={720}
        emptyMessage={error ?? (search ? 'No invitations match this search.' : `No ${tab === 'all' ? '' : tab + ' '}invitations.`)}
        tabs={
          <Tabs
            options={TABS}
            value={tab}
            onChange={(value) => {
              setTab(value);
              setPage(1);
            }}
          />
        }
        search={{
          value: searchInput,
          onChange: (value) => {
            setSearchInput(value);
            setPage(1);
          },
          placeholder: 'Search by email',
        }}
        pagination={
          data
            ? { page: data.page, totalPages: data.totalPages, total: data.total, pageSize: data.pageSize, onPageChange: setPage }
            : undefined
        }
      />

      <InvitationDetailsDialog
        invitation={revoking ? null : selected}
        busy={busy}
        onClose={() => setSelected(null)}
        onResend={resend}
        onRevoke={(invitation) => setRevoking(invitation)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke the invitation for ${revoking?.email}?`}
        body="The link in their email stops working immediately. You can invite them again afterwards."
        confirmLabel="Revoke invitation"
        busy={busy}
        onConfirm={confirmRevoke}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}

function statusDetail(invitation: Invitation): string {
  switch (invitation.status) {
    case 'pending':
      if (invitation.emailStatus === 'failed') return 'Email failed — resend';
      if (invitation.emailStatus === 'queued') return 'Sending email…';
      return `Expires ${formatRelative(invitation.expiresAt)}`;
    case 'expired':
      return `Expired ${formatRelative(invitation.expiresAt)}`;
    case 'accepted':
      return invitation.acceptedAt ? `Joined ${formatRelative(invitation.acceptedAt)}` : 'Joined';
    case 'revoked':
      return invitation.revokedAt ? `Revoked ${formatRelative(invitation.revokedAt)}` : 'Revoked';
  }
}
