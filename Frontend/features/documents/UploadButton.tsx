import { useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
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
  const [error, setError] = useState<string | null>(null);

  async function handleFileChosen(file: File) {
    setError(null);
    setProgress(0);
    try {
      const doc = await uploadDocument(workspaceId, file, setProgress);
      onUploaded(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
      <Button onClick={() => inputRef.current?.click()} disabled={progress !== null}>
        {progress !== null ? `Uploading… ${progress}%` : 'Upload document'}
      </Button>
      {error && <span style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</span>}
    </div>
  );
}
