'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { Dot, StatTile, StatTileRow } from '../../shared/ui/primitives';
import { useFetch } from '../../shared/hooks/useFetch';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { QueueTable, formatWait } from './QueueTable';
import { TeamPresence } from './TeamPresence';
import { EscalationReasons } from './EscalationReasons';
import { ConversationDrawer } from './ConversationDrawer';
import { useAgentSocket } from './useAgentSocket';
import { claimConversation, getEscalationReasons, getPresence, getQueueStats, listQueue, resolveConversation, type QueueRow } from './api';

export function ConsoleApp() {
  const { workspaceId } = useWorkspace();
  const [openRow, setOpenRow] = useState<QueueRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incremented on every socket event that changes the queue; every panel keys its fetch on
  // it, so one live escalation refreshes the table, the tiles and the presence list together.
  const [refreshToken, setRefreshToken] = useState(0);

  const bumpRefresh = useCallback(() => setRefreshToken((n) => n + 1), []);
  const { liveMessages, joinConversation, sendAgentMessage } = useAgentSocket(workspaceId, bumpRefresh);

  const statsKey = useMemo(() => JSON.stringify({ workspaceId, refreshToken }), [workspaceId, refreshToken]);
  const { data: stats } = useFetch((signal) => getQueueStats(workspaceId, signal), statsKey);
  const { data: presence } = useFetch((signal) => getPresence(workspaceId, signal), statsKey);
  const { data: reasons } = useFetch((signal) => getEscalationReasons(workspaceId, signal), statsKey);

  // The open conversation's row has to stay current: its status changes the moment it is
  // claimed or resolved, and the drawer's own controls depend on that status.
  useEffect(() => {
    if (!openRow) return;
    let cancelled = false;
    listQueue(workspaceId, { tab: 'all', search: openRow.sessionId, pageSize: 1 })
      .then((page) => {
        const fresh = page.items.find((r) => r.sessionId === openRow.sessionId);
        if (!cancelled && fresh) setOpenRow(fresh);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // openRow.sessionId, not openRow — depending on the whole object would re-run on every
    // refresh this effect itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, openRow?.sessionId, refreshToken]);

  const openConversation = useCallback(
    (row: QueueRow) => {
      setError(null);
      setOpenRow(row);
      joinConversation(row.sessionId);
    },
    [joinConversation],
  );

  const openBySessionId = useCallback(
    async (sessionId: string) => {
      try {
        const page = await listQueue(workspaceId, { tab: 'all', search: sessionId, pageSize: 1 });
        const row = page.items.find((r) => r.sessionId === sessionId);
        if (row) openConversation(row);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not open this conversation.');
      }
    },
    [workspaceId, openConversation],
  );

  async function handleClaim(sessionId: string) {
    setError(null);
    try {
      await claimConversation(workspaceId, sessionId);
      notifySuccess(`You claimed Visitor ${sessionId.slice(0, 8)} — the AI has stopped replying to them.`);
      bumpRefresh();
      await openBySessionId(sessionId);
    } catch (err) {
      // A 409 here means another agent won the race — the message is the real current state,
      // and this agent's own row was already stale when they clicked. Shown as a toast AND
      // refreshed, because the row they clicked is about to disappear from their queue.
      notifyError(err, 'Could not claim this conversation.');
      bumpRefresh();
    }
  }

  async function handleResolve() {
    if (!openRow) return;
    const sessionId = openRow.sessionId;
    try {
      await resolveConversation(workspaceId, sessionId);
      notifySuccess(`Resolved — the AI will answer Visitor ${sessionId.slice(0, 8)}'s next message.`);
      setOpenRow(null);
      bumpRefresh();
    } catch (err) {
      notifyError(err, 'Could not resolve this conversation.');
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div style={{ padding: '28px 32px 48px', maxWidth: 1240 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <h1 style={{ margin: 0, font: '600 24px/1.2 var(--font-sans)', letterSpacing: '-.02em' }}>Agent console</h1>
              <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)' }}>
                The live queue of conversations the AI handed to a human.
              </p>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 32,
                padding: '0 11px',
                border: '1px solid var(--border)',
                borderRadius: 7,
                background: 'var(--surface)',
                fontSize: 12.5,
                color: 'var(--muted)',
              }}
            >
              <Dot tone={stats && stats.agentsOnline > 0 ? 'ok' : 'neutral'} />
              {stats?.agentsOnline ?? 0} agent{stats?.agentsOnline === 1 ? '' : 's'} online
            </div>
          </div>

          <ErrorBanner message={error} />

          <div style={{ marginBottom: 16 }}>
            <StatTileRow>
              <StatTile label="Waiting" value={stats?.waiting ?? '—'} tone={stats?.waiting ? 'err' : 'neutral'} />
              <StatTile label="Active" value={stats?.active ?? '—'} />
              <StatTile label="Resolved today" value={stats?.resolvedToday ?? '—'} />
              <StatTile
                label="Longest wait"
                value={stats ? (stats.waiting > 0 ? formatWait(stats.longestWaitSeconds) : '—') : '—'}
                tone={stats && stats.longestWaitSeconds >= 180 ? 'warn' : 'neutral'}
              />
            </StatTileRow>
          </div>

          {/* The side panels sit beside the table normally, but stack below it once the
              conversation drawer takes 420px off the right — otherwise the queue's own
              columns get squeezed until the Claim button scrolls out of reach. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: openRow ? 'minmax(0,1fr)' : 'minmax(0,2.1fr) minmax(0,1fr)',
              gap: 16,
            }}
          >
            <QueueTable
              workspaceId={workspaceId}
              stats={stats}
              onClaim={handleClaim}
              onOpen={openBySessionId}
              refreshToken={refreshToken}
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: openRow ? 'repeat(auto-fit,minmax(280px,1fr))' : 'minmax(0,1fr)',
                gap: 16,
                alignContent: 'start',
              }}
            >
              <TeamPresence members={presence} />
              <EscalationReasons reasons={reasons} />
            </div>
          </div>
        </div>
      </div>

      {openRow && (
        <ConversationDrawer
          workspaceId={workspaceId}
          row={openRow}
          liveMessages={liveMessages}
          onSend={(message) => sendAgentMessage(openRow.sessionId, message)}
          onResolve={handleResolve}
          onClose={() => setOpenRow(null)}
        />
      )}
    </div>
  );
}
