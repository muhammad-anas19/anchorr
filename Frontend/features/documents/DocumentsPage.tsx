'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { ApiError } from '../../shared/api/client';
import { deleteDocument, Document, listDocuments } from './api';
import { DocumentsTable } from './DocumentsTable';
import { UploadButton } from './UploadButton';
import { DocumentsFilterBar, StatusFilter, TypeFilter } from './DocumentsFilterBar';
import { ProcessingPanel } from './ProcessingPanel';

const POLL_INTERVAL_MS = 4000;

// Fixed-size chunking with boundary snapping and overlap — the real strategy this project
// implemented (Phase 6), not a configurable setting yet, so this is a static, accurate
// description rather than a live value from anywhere.
const CHUNKING_STRATEGY_LABEL = 'Fixed-size · ~150 char overlap';

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 130, background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 12.5, color: '#6b6b73' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, marginTop: 7, color: color ?? '#17171a' }}>{value}</div>
    </div>
  );
}

export function DocumentsPage() {
  const { workspaceId } = useWorkspace();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  async function refresh() {
    try {
      setDocuments(await listDocuments(workspaceId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load documents.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // No push channel exists for document processing status (only the widget/agent gateway
  // does) — polling is the honest, simple option while any document is still in flight.
  useEffect(() => {
    const stillProcessing = documents.some((d) => d.status === 'uploaded' || d.status === 'processing');
    if (!stillProcessing) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, workspaceId]);

  async function handleDelete(documentId: number) {
    setError(null);
    try {
      await deleteDocument(workspaceId, documentId);
      setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete this document.');
    }
  }

  const ready = documents.filter((d) => d.status === 'ready').length;
  const processing = documents.filter((d) => d.status === 'uploaded' || d.status === 'processing').length;
  const failed = documents.filter((d) => d.status === 'failed').length;
  const indexedChunks = documents.reduce((sum, d) => sum + d.chunkCount, 0);

  const filtered = useMemo(() => {
    return documents.filter((d) => {
      if (search && !d.originalFilename.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter === 'ready' && d.status !== 'ready') return false;
      if (statusFilter === 'processing' && d.status !== 'uploaded' && d.status !== 'processing') return false;
      if (statusFilter === 'failed' && d.status !== 'failed') return false;
      if (typeFilter === 'pdf' && d.mimeType !== 'application/pdf') return false;
      if (typeFilter === 'docx' && d.mimeType === 'application/pdf') return false;
      return true;
    });
  }, [documents, search, statusFilter, typeFilter]);

  // Show a live checklist for whichever document is actively in flight right now — the
  // most recently created one if more than one happens to be processing at once.
  const activeDocument = documents.find((d) => d.status === 'uploaded' || d.status === 'processing');

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Knowledge</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6b6b73' }}>
            Manage the documents your AI uses to answer customer questions.
          </p>
        </div>
        <UploadButton workspaceId={workspaceId} onUploaded={(doc) => setDocuments((prev) => [doc, ...prev])} />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatCard label="Ready" value={ready} />
        <StatCard label="Processing" value={processing} color="#2542b8" />
        <StatCard label="Failed" value={failed} color="#a72118" />
        <StatCard label="Indexed chunks" value={indexedChunks.toLocaleString()} />
        <StatCard label="Chunking" value={CHUNKING_STRATEGY_LABEL} />
      </div>

      <ErrorBanner message={error} />

      {loading ? (
        <p style={{ color: '#9a9aa2', fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: '10px 10px 0 0', borderBottom: 'none' }}>
            <DocumentsFilterBar
              search={search}
              onSearchChange={setSearch}
              status={statusFilter}
              onStatusChange={setStatusFilter}
              type={typeFilter}
              onTypeChange={setTypeFilter}
              totalCount={documents.length}
            />
          </div>
          <div style={{ marginTop: -1 }}>
            <DocumentsTable documents={filtered} onDelete={handleDelete} />
          </div>
        </>
      )}

      {activeDocument && (
        <div style={{ marginTop: 16 }}>
          <ProcessingPanel document={activeDocument} />
        </div>
      )}
    </div>
  );
}
