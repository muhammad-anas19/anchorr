import { useEffect, useState } from 'react';
import type { Document, DocumentProgress } from './api';
import { getDocumentProgress } from './api';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';

const POLL_INTERVAL_MS = 1000;
const STAGES = ['parsing', 'chunking', 'embedding'] as const;
const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  parsing: 'Parsing document',
  chunking: 'Chunking',
  embedding: 'Generating embeddings',
};

function stageIndex(stage: string): number {
  return STAGES.indexOf(stage as (typeof STAGES)[number]);
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Step({ state, title, detail }: { state: 'done' | 'active' | 'pending'; title: string; detail?: string }) {
  const dotStyle: React.CSSProperties =
    state === 'done'
      ? { background: '#136c46' }
      : state === 'active'
        ? { border: '2px solid #2542b8', background: 'white' }
        : { border: '1.5px solid #d8d8d3', background: 'white' };

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 18 }}>
        <span style={{ width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none', ...dotStyle }}>
          {state === 'done' && (
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6">
              <path d="M3.5 8.5L6.5 11.5 12.5 5" />
            </svg>
          )}
          {state === 'active' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2542b8' }} />}
        </span>
        <span style={{ flex: 1, width: 1.5, background: state === 'pending' ? '#e7e7e4' : '#d8d8d3' }} />
      </div>
      <div style={{ paddingBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: state === 'active' ? 600 : 500, color: state === 'pending' ? '#9a9aa2' : state === 'active' ? '#2542b8' : '#17171a' }}>
          {title}
        </div>
        {detail && <div style={{ fontSize: 11, color: '#9a9aa2', marginTop: 5, fontFamily: 'monospace' }}>{detail}</div>}
      </div>
    </div>
  );
}

export function ProcessingPanel({ document }: { document: Document }) {
  const { workspaceId } = useWorkspace();
  const [progress, setProgress] = useState<DocumentProgress>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await getDocumentProgress(workspaceId, document.id);
        if (!cancelled) setProgress(result);
      } catch {
        // A 404/transient error just means "nothing to show right now" for this panel.
      }
    }
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId, document.id]);

  const liveIndex = progress ? stageIndex(progress.stage) : -1;

  function stateFor(stage: (typeof STAGES)[number]): 'done' | 'active' | 'pending' {
    const idx = STAGES.indexOf(stage);
    if (liveIndex === -1) {
      // No live job right now — either it hasn't started yet, or it already moved past
      // every stage we can observe (ephemeral progress, gone once the job finishes).
      return 'pending';
    }
    if (idx < liveIndex) return 'done';
    if (idx === liveIndex) return 'active';
    return 'pending';
  }

  const embeddingDetail =
    progress?.stage === 'embedding' ? `${progress.completed} of ${progress.total} chunks embedded` : undefined;
  const chunkingDetail =
    progress?.stage === 'chunking'
      ? `${progress.pageCount ?? '?'} pages · ${progress.wordCount.toLocaleString()} words`
      : undefined;

  return (
    <div style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{document.originalFilename}</div>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: '#6b6b73' }}>
        Processing runs in the background. You can leave this page.
      </p>
      <div>
        <Step state="done" title="Upload received" detail={`${formatSize(document.fileSizeBytes)}`} />
        <Step state={stateFor('parsing')} title="Parsing document" />
        <Step state={stateFor('chunking')} title="Chunking" detail={chunkingDetail} />
        <Step state={stateFor('embedding')} title="Generating embeddings" detail={embeddingDetail} />
        {progress?.stage === 'embedding' && (
          <div style={{ marginLeft: 30, marginTop: -8, marginBottom: 14, maxWidth: 260 }}>
            <div style={{ height: 4, borderRadius: 3, background: '#eeeeec', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%`,
                  height: '100%',
                  background: '#3459e6',
                }}
              />
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ width: 18, display: 'flex', justifyContent: 'center' }}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid #d8d8d3' }} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#9a9aa2' }}>Ready</div>
        </div>
      </div>
    </div>
  );
}
