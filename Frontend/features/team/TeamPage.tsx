'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Icon } from '../../shared/ui/Icon';
import { StatTile, StatTileRow, Tabs } from '../../shared/ui/primitives';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { clearPreferredWorkspace } from '../../shared/workspace/preferredWorkspace';
import { leaveWorkspace, listMembers } from '../members/api';
import { MembersTab } from '../members/MembersTab';
import { listInvitations } from '../invitations/api';
import { InvitationsTab } from '../invitations/InvitationsTab';
import { InviteDialog } from '../invitations/InviteDialog';

type Section = 'members' | 'invitations';

interface Counts {
  members: number;
  owners: number;
  pending: number;
  expired: number;
}

// Composes the members and invitations features — which don't know about each other — into
// one screen. Lives in its own feature folder so neither of them has to import the other.
export function TeamPage() {
  const { workspaceId, workspaceName, can } = useWorkspace();
  const canInvite = can('members.invite');
  const [section, setSection] = useState<Section>('members');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [invitationsVersion, setInvitationsVersion] = useState(0);

  const refreshCounts = useCallback(async () => {
    try {
      const [members, owners, pending, expired] = await Promise.all([
        listMembers(workspaceId, { page: 1, pageSize: 1 }),
        listMembers(workspaceId, { page: 1, pageSize: 1, role: 'owner' }),
        canInvite ? listInvitations(workspaceId, { page: 1, pageSize: 1, status: 'pending' }) : null,
        canInvite ? listInvitations(workspaceId, { page: 1, pageSize: 1, status: 'expired' }) : null,
      ]);
      setCounts({ members: members.total, owners: owners.total, pending: pending?.total ?? 0, expired: expired?.total ?? 0 });
    } catch (err) {
      notifyError(err, 'Could not load team totals.');
    }
  }, [workspaceId, canInvite]);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

  const changed = useCallback(() => {
    refreshCounts();
    setInvitationsVersion((v) => v + 1);
  }, [refreshCounts]);

  async function confirmLeave() {
    setLeaveBusy(true);
    try {
      await leaveWorkspace(workspaceId);
      notifySuccess(`You left ${workspaceName}.`);
      clearPreferredWorkspace();
      window.location.assign('/');
    } catch (err) {
      notifyError(err, 'Could not leave this workspace.');
      setLeaveBusy(false);
    }
  }

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Team</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            Who has access to {workspaceName}, what they can do, and who has been invited.
          </p>
        </div>
        {can('workspace.leave') && (
          <Button variant="secondary" onClick={() => setLeaving(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="leave" size={13} /> Leave workspace
          </Button>
        )}
        {canInvite && (
          <Button onClick={() => setInviteOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="userPlus" size={14} /> Invite people
          </Button>
        )}
      </div>

      <div style={{ margin: '22px 0' }}>
        <StatTileRow>
          <StatTile label="Members" value={counts?.members ?? '—'} />
          <StatTile label="Owners" value={counts?.owners ?? '—'} tone="accent" />
          {canInvite && <StatTile label="Pending invitations" value={counts?.pending ?? '—'} />}
          {canInvite && <StatTile label="Expired invitations" value={counts?.expired ?? '—'} tone={counts?.expired ? 'warn' : 'neutral'} />}
        </StatTileRow>
      </div>

      {canInvite && (
        <div style={{ marginBottom: 12, marginLeft: -14 }}>
          <Tabs
            options={[
              { value: 'members', label: 'Members', count: counts?.members },
              { value: 'invitations', label: 'Invitations', count: counts?.pending },
            ]}
            value={section}
            onChange={setSection}
          />
        </div>
      )}

      {section === 'members' || !canInvite ? (
        <MembersTab onChanged={changed} />
      ) : (
        <InvitationsTab refreshKey={invitationsVersion} onChanged={changed} />
      )}

      {canInvite && (
        <InviteDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            changed();
            setSection('invitations');
          }}
        />
      )}

      <ConfirmDialog
        open={leaving}
        title={`Leave ${workspaceName}?`}
        body="You lose access immediately. Conversations you have claimed go back to the queue. To come back, someone will have to invite you again."
        confirmLabel="Leave workspace"
        busy={leaveBusy}
        onConfirm={confirmLeave}
        onCancel={() => setLeaving(false)}
      />
    </div>
  );
}
