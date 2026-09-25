'use client';

import { DataTable, type Column } from '../../shared/ui/DataTable';
import { Icon } from '../../shared/ui/Icon';
import { TONE_COLORS, type Tone } from '../../shared/ui/primitives';
import { StatusBadge } from './StatusBadge';
import type { Document } from './api';
import type { StatusFilter, TypeFilter } from './DocumentsFilterBar';

function typeTag(mimeType: Document['mimeType']): { label: string; tone: Tone } {
  return mimeType === 'application/pdf' ? { label: 'PDF', tone: 'err' } : { label: 'DOC', tone: 'accent' };
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function DocumentsTable({
  documents,
  loading,
  onDelete,
  search,
  onSearchChange,
  status,
  onStatusChange,
  type,
  onTypeChange,
  uploadButton,
}: {
  documents: Document[];
  loading: boolean;
  onDelete: (doc: Document) => void;
  search: string;
  onSearchChange: (value: string) => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  type: TypeFilter;
  onTypeChange: (value: TypeFilter) => void;
  uploadButton?: React.ReactNode;
}) {
  const columns: Column<Document>[] = [
    {
      key: 'document',
      header: 'Document',
      width: 'minmax(240px,2.2fr)',
      render: (doc) => {
        const tag = typeTag(doc.mimeType);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              style={{
                flex: 'none',
                font: '600 9.5px/1 var(--font-mono)',
                color: TONE_COLORS[tag.tone].fg,
                background: TONE_COLORS[tag.tone].bg,
                padding: '4px 5px',
                borderRadius: 4,
              }}
            >
              {tag.label}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  font: '500 13px/1.3 var(--font-sans)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {doc.originalFilename}
              </div>
              {doc.failureReason && (
                <div style={{ fontSize: 11.5, color: 'var(--err)', marginTop: 4 }}>{doc.failureReason}</div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: '130px',
      render: (doc) => <StatusBadge status={doc.status} />,
    },
    {
      key: 'chunks',
      header: 'Chunks',
      width: '90px',
      render: (doc) => (
        <span
          style={{
            font: '400 12.5px/1 var(--font-mono)',
            color: doc.chunkCount > 0 ? 'var(--muted)' : 'var(--faint)',
          }}
        >
          {doc.chunkCount || '—'}
        </span>
      ),
    },
    {
      key: 'uploadedBy',
      header: 'Uploaded by',
      width: '150px',
      render: (doc) => (
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {doc.uploadedByEmail ?? '—'}
        </span>
      ),
    },
    {
      key: 'lastIndexed',
      header: 'Last indexed',
      width: '150px',
      render: (doc) => (
        <span style={{ font: '400 12px/1 var(--font-mono)', color: 'var(--faint)' }}>{formatDate(doc.readyAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '56px',
      align: 'right',
      render: (doc) => (
        <button
          onClick={() => onDelete(doc)}
          aria-label={`Delete ${doc.originalFilename}`}
          title="Delete document"
          className="anc-icon-btn"
          style={{
            width: 28,
            height: 28,
            display: 'inline-grid',
            placeItems: 'center',
            border: '1px solid var(--border)',
            borderRadius: 7,
            background: 'var(--surface)',
            color: 'var(--faint)',
          }}
        >
          <Icon name="trash" size={14} strokeWidth={1.5} />
        </button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={documents}
      rowKey={(doc) => doc.id}
      loading={loading}
      minWidth={840}
      emptyMessage={
        search || status !== 'all' || type !== 'all'
          ? 'No documents match these filters.'
          : 'No documents yet — your AI needs knowledge before it can answer customer questions.'
      }
      search={{ value: search, onChange: onSearchChange, placeholder: 'Search documents' }}
      filters={[
        {
          ariaLabel: 'Filter by status',
          value: status,
          onChange: (value) => onStatusChange(value as StatusFilter),
          options: [
            { value: 'all', label: 'Status: All' },
            { value: 'ready', label: 'Status: Ready' },
            { value: 'processing', label: 'Status: Processing' },
            { value: 'failed', label: 'Status: Failed' },
          ],
        },
        {
          ariaLabel: 'Filter by type',
          value: type,
          onChange: (value) => onTypeChange(value as TypeFilter),
          options: [
            { value: 'all', label: 'Type: All' },
            { value: 'pdf', label: 'Type: PDF' },
            { value: 'docx', label: 'Type: DOCX' },
          ],
        },
      ]}
      toolbarExtra={uploadButton}
    />
  );
}
