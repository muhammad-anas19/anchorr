import type { Document } from './api';
import { StatusBadge } from './StatusBadge';

function typeTag(mimeType: Document['mimeType']): { label: string; bg: string; fg: string } {
  return mimeType === 'application/pdf'
    ? { label: 'PDF', bg: '#fdeceb', fg: '#a72118' }
    : { label: 'DOC', bg: '#eef1fe', fg: '#2542b8' };
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const COLUMNS = 'minmax(240px,2.2fr) 150px 90px 150px 140px 44px';

export function DocumentsTable({
  documents,
  onDelete,
}: {
  documents: Document[];
  onDelete: (documentId: number) => void;
}) {
  if (documents.length === 0) {
    return (
      <div
        style={{
          border: '1px dashed #d8d8d3',
          borderRadius: 10,
          padding: '48px 20px',
          textAlign: 'center',
          color: '#6b6b73',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6, color: '#17171a' }}>No documents yet</div>
        <p style={{ fontSize: 12.5, margin: 0 }}>Your AI needs knowledge before it can answer customer questions.</p>
      </div>
    );
  }

  return (
    <div style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          gap: 12,
          padding: '9px 16px',
          borderBottom: '1px solid #e7e7e4',
          background: '#fafafa',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: '#9a9aa2',
        }}
      >
        <div>Document</div>
        <div>Status</div>
        <div>Chunks</div>
        <div>Uploaded by</div>
        <div>Last indexed</div>
        <div />
      </div>
      {documents.map((doc) => {
        const tag = typeTag(doc.mimeType);
        return (
          <div
            key={doc.id}
            style={{
              display: 'grid',
              gridTemplateColumns: COLUMNS,
              gap: 12,
              alignItems: 'center',
              padding: '13px 16px',
              borderBottom: '1px solid #e7e7e4',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span
                style={{
                  flex: 'none',
                  fontSize: 9.5,
                  fontWeight: 600,
                  color: tag.fg,
                  background: tag.bg,
                  padding: '4px 5px',
                  borderRadius: 4,
                }}
              >
                {tag.label}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.originalFilename}
                </div>
                {doc.failureReason && (
                  <div style={{ fontSize: 11.5, color: '#a72118', marginTop: 4 }}>{doc.failureReason}</div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusBadge status={doc.status} />
              {doc.status === 'failed' && (
                <button
                  onClick={() => onDelete(doc.id)}
                  style={{
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid #e7e7e4',
                    background: 'white',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: doc.chunkCount > 0 ? '#6b6b73' : '#9a9aa2', fontFamily: 'monospace' }}>
              {doc.chunkCount || '—'}
            </div>
            <div style={{ fontSize: 12.5, color: '#6b6b73', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.uploadedByEmail ?? '—'}
            </div>
            <div style={{ fontSize: 12, color: '#9a9aa2', fontFamily: 'monospace' }}>{formatDate(doc.readyAt)}</div>
            <div style={{ textAlign: 'right' }}>
              <button
                onClick={() => onDelete(doc.id)}
                aria-label="Delete document"
                title="Delete"
                style={{ border: 'none', background: 'transparent', color: '#9a9aa2', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
              >
                ⋮
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
