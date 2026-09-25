'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { StatTile, StatTileRow } from '../../shared/ui/primitives';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { deleteDocument, Document, listDocuments } from './api';
import { DocumentsTable } from './DocumentsTable';
import { UploadButton } from './UploadButton';
import { matchesFilters, StatusFilter, TypeFilter } from './DocumentsFilterBar';
import { ProcessingPanel } from './ProcessingPanel';

const POLL_INTERVAL_MS = 4000;

// Fixed-size chunking with boundary snapping and overlap — the real strategy this project
// implemented (Phase 6), not a configurable setting yet, so this is a static, accurate
// description rather than a live value from anywhere.
const CHUNKING_STRATEGY_LABEL = 'Fixed-size · ~150 char overlap';

export function DocumentsPage() {
  const { workspaceId } = useWorkspace();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [pendingDelete, setPendingDelete] = useState<Document | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filtering is local here (see DocumentsFilterBar), but the input is still debounced so a
  // long list is not re-filtered and re-rendered on every single keystroke.
  const search = useDebouncedValue(searchInput.trim(), 200);

  // `silent` separates the two reasons this runs: a real page load, where a failure is worth
  // telling the user about, and the 4-second background poll, where a toast every few
  // seconds during a network blip would be worse than the blip.
  const refresh = useCallback(
    async (silent = false) => {
      try {
        setDocuments(await listDocuments(workspaceId));
      } catch (err) {
        if (!silent) notifyError(err, 'Could not load documents.');
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // No push channel exists for document processing status (only the widget/agent gateway
  // does) — polling is the honest, simple option while any document is still in flight.
  useEffect(() => {
    const stillProcessing = documents.some((d) => d.status === 'uploaded' || d.status === 'processing');
    if (!stillProcessing) return;
    const timer = setInterval(() => refresh(true), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [documents, refresh]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteDocument(workspaceId, pendingDelete.id);
      setDocuments((prev) => prev.filter((d) => d.id !== pendingDelete.id));
      notifySuccess(`Deleted “${pendingDelete.originalFilename}”.`);
      setPendingDelete(null);
    } catch (err) {
      // The dialog deliberately stays open on failure: the document was not deleted, so
      // closing it would imply the action succeeded.
      notifyError(err, 'Could not delete this document.');
    } finally {
      setDeleting(false);
    }
  }

  const ready = documents.filter((d) => d.status === 'ready').length;
  const processing = documents.filter((d) => d.status === 'uploaded' || d.status === 'processing').length;
  const failed = documents.filter((d) => d.status === 'failed').length;
  const indexedChunks = documents.reduce((sum, d) => sum + d.chunkCount, 0);

  const filtered = useMemo(
    () => documents.filter((d) => matchesFilters(d, search, statusFilter, typeFilter)),
    [documents, search, statusFilter, typeFilter],
  );

  // Show a live checklist for whichever document is actively in flight right now — the
  // most recently created one if more than one happens to be processing at once.
  const activeDocument = documents.find((d) => d.status === 'uploaded' || d.status === 'processing');

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1240 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ margin: 0, font: '600 24px/1.2 var(--font-sans)', letterSpacing: '-.02em' }}>Knowledge</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            Manage the documents your AI uses to answer customer questions.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <StatTileRow>
          <StatTile label="Ready" value={ready} tone={ready > 0 ? 'ok' : 'neutral'} />
          <StatTile label="Processing" value={processing} tone={processing > 0 ? 'accent' : 'neutral'} />
          <StatTile label="Failed" value={failed} tone={failed > 0 ? 'err' : 'neutral'} />
          <StatTile label="Indexed chunks" value={indexedChunks.toLocaleString()} />
          <StatTile label="Chunking" value={<span style={{ fontSize: 12.5 }}>{CHUNKING_STRATEGY_LABEL}</span>} />
        </StatTileRow>
      </div>

      <DocumentsTable
        documents={filtered}
        loading={loading}
        onDelete={setPendingDelete}
        search={searchInput}
        onSearchChange={setSearchInput}
        status={statusFilter}
        onStatusChange={setStatusFilter}
        type={typeFilter}
        onTypeChange={setTypeFilter}
        uploadButton={
          <UploadButton workspaceId={workspaceId} onUploaded={(doc) => setDocuments((prev) => [doc, ...prev])} />
        }
      />

      {activeDocument && (
        <div style={{ marginTop: 16 }}>
          <ProcessingPanel document={activeDocument} />
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this document?"
        body={
          <>
            <strong style={{ color: 'var(--fg)' }}>{pendingDelete?.originalFilename}</strong> and its{' '}
            {pendingDelete?.chunkCount ?? 0} indexed chunk{pendingDelete?.chunkCount === 1 ? '' : 's'} will be removed.
            Your AI will stop using it to answer questions. This cannot be undone.
          </>
        }
        confirmLabel="Delete document"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
