'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '../../shared/ui/DataTable';
import { Badge, Tabs } from '../../shared/ui/primitives';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { useFetch } from '../../shared/hooks/useFetch';
import { listQueue, type QueuePriority, type QueueRow, type QueueStats, type QueueTab } from './api';

export function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

// A session id is the only real identifier a widget visitor has — the widget is anonymous by
// design and collects no name. Shortened for readability rather than replaced with an
// invented person's name.
function visitorLabel(sessionId: string): string {
  return `Visitor ${sessionId.slice(0, 8)}`;
}

export function QueueTable({
  workspaceId,
  stats,
  onClaim,
  onOpen,
  refreshToken,
}: {
  workspaceId: number;
  stats: QueueStats | null;
  onClaim: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  // Bumped by the parent whenever a socket event says the queue changed, so a live escalation
  // shows up without the agent touching anything.
  refreshToken: number;
}) {
  const [tab, setTab] = useState<QueueTab>('waiting');
  const [searchInput, setSearchInput] = useState('');
  const [priority, setPriority] = useState<QueuePriority | ''>('');
  const [page, setPage] = useState(1);

  // The input stays instant; only this debounced copy reaches the request.
  const search = useDebouncedValue(searchInput.trim(), 300);

  const params = useMemo(
    () => ({ tab, search, priority, page, pageSize: 10 }),
    [tab, search, priority, page],
  );

  const { data, loading } = useFetch(
    (signal) => listQueue(workspaceId, params, signal),
    // Any change to the params — or to refreshToken — is a new request. Serializing is what
    // lets an object be a dependency without re-firing on every render.
    JSON.stringify({ workspaceId, params, refreshToken }),
  );

  // Changing a filter while on page 4 would otherwise request page 4 of a much shorter
  // result set and show an empty table.
  function resetTo(update: () => void) {
    update();
    setPage(1);
  }

  const columns: Column<QueueRow>[] = [
    {
      key: 'customer',
      header: 'Customer & topic',
      width: '1fr',
      render: (row) => (
        <button
          onClick={() => onOpen(row.sessionId)}
          style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent', padding: 0 }}
        >
          <div style={{ font: '500 13px/1 var(--font-sans)', color: 'var(--fg)' }}>{visitorLabel(row.sessionId)}</div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              marginTop: 5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.topic ?? 'No messages yet'}
          </div>
        </button>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      width: '130px',
      render: (row) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{row.reason}</span>,
    },
    {
      key: 'waiting',
      header: 'Waiting',
      width: '100px',
      render: (row) => (
        <span
          style={{
            font: '500 12.5px/1 var(--font-mono)',
            color: row.priority === 'high' ? 'var(--warn)' : 'var(--fg)',
          }}
        >
          {formatWait(row.waitingSeconds)}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '110px',
      render: (row) => (
        <Badge tone={row.priority === 'high' ? 'err' : 'warn'}>{row.priority === 'high' ? 'High' : 'Normal'}</Badge>
      ),
    },
    {
      key: 'action',
      header: '',
      width: '86px',
      align: 'right',
      render: (row) =>
        row.status === 'escalated' ? (
          <button
            onClick={() => onClaim(row.sessionId)}
            className="anc-btn"
            style={{
              height: 27,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--btn-bg)',
              border: 0,
              color: 'var(--btn-fg)',
              font: '500 12px/1 var(--font-sans)',
            }}
          >
            Claim
          </button>
        ) : (
          <button
            onClick={() => onOpen(row.sessionId)}
            className="anc-border-hover"
            style={{
              height: 27,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              font: '500 12px/1 var(--font-sans)',
            }}
          >
            Open
          </button>
        ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={data?.items ?? []}
      rowKey={(row) => row.sessionId}
      loading={loading}
      emptyMessage={search ? `No conversations match “${search}”.` : 'Nothing in this queue right now.'}
      tabs={
        <Tabs
          value={tab}
          onChange={(next) => resetTo(() => setTab(next))}
          options={[
            { value: 'waiting', label: 'Waiting', count: stats?.waiting },
            { value: 'active', label: 'Active', count: stats?.active },
            { value: 'resolved', label: 'Resolved', count: stats?.resolved },
            { value: 'all', label: 'All' },
          ]}
        />
      }
      search={{
        value: searchInput,
        onChange: (value) => resetTo(() => setSearchInput(value)),
        placeholder: 'Search customer or topic',
      }}
      filters={[
        {
          ariaLabel: 'Filter by priority',
          value: priority,
          onChange: (value) => resetTo(() => setPriority(value as QueuePriority | '')),
          options: [
            { value: '', label: 'All priorities' },
            { value: 'high', label: 'High' },
            { value: 'normal', label: 'Normal' },
          ],
        },
      ]}
      pagination={
        data
          ? {
              page: data.page,
              totalPages: data.totalPages,
              total: data.total,
              pageSize: data.pageSize,
              onPageChange: setPage,
            }
          : undefined
      }
    />
  );
}
