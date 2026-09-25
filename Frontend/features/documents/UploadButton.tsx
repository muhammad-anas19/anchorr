'use client';

import { useRef, useState } from 'react';
import { Icon } from '../../shared/ui/Icon';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { uploadDocument, Document } from './api';

export function UploadButton({
  workspaceId,
  onUploaded,
}: {
  workspaceId: number;
  onUploaded: (doc: Document) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);

  async function handleFileChosen(file: File) {
    setProgress(0);
    try {
      const doc = await uploadDocument(workspaceId, file, setProgress);
      // Says "queued", not "uploaded", because that is what actually happened: the HTTP
      // response returns before parsing, chunking or embedding have run.
      notifySuccess(`“${doc.originalFilename}” uploaded — queued for processing.`);
      onUploaded(doc);
    } catch (err) {
      notifyError(err, 'Upload failed.');
    } finally {
      setProgress(null);
      // Without this, choosing the same file twice in a row fires no change event at all.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const busy = progress !== null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file);
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="anc-btn"
        style={{
          height: 30,
          padding: '0 12px',
          borderRadius: 7,
          border: 0,
          background: 'var(--btn-bg)',
          color: 'var(--btn-fg)',
          font: '500 12.5px/1 var(--font-sans)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Icon name="upload" size={13} strokeWidth={1.6} />
        {busy ? `Uploading… ${progress}%` : 'Upload document'}
      </button>
    </>
  );
}
