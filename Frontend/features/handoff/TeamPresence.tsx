'use client';

import { Avatar, Card, CardTitle, Dot, EmptyState } from '../../shared/ui/primitives';
import type { AgentPresenceRow } from './api';

export function TeamPresence({ members }: { members: AgentPresenceRow[] | null }) {
  return (
    <Card>
      <CardTitle>Team presence</CardTitle>
      <div style={{ marginTop: 14 }}>
        {!members && <EmptyState>Loading…</EmptyState>}
        {members?.length === 0 && <EmptyState>No members in this workspace.</EmptyState>}
        {members?.map((member, index) => (
          <div
            key={member.userId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 0',
              borderBottom: index === members.length - 1 ? 'none' : '1px solid var(--border)',
            }}
          >
            <Avatar label={member.email} tone={member.online ? 'ok' : 'neutral'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  font: '500 12.5px/1 var(--font-sans)',
                  color: member.online ? 'var(--fg)' : 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {member.email}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>
                {member.activeCount > 0 ? `${member.activeCount} active` : member.role}
              </div>
            </div>
            {/* Only two states, because only two are real: a live socket, or no socket. This
                system records nothing that could back an "Away" state or a last-seen time. */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: member.online ? 'var(--ok)' : 'var(--faint)',
              }}
            >
              <Dot tone={member.online ? 'ok' : 'neutral'} />
              {member.online ? 'Online' : 'Offline'}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
