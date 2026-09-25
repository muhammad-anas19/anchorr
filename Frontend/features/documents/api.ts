import { request } from '../../shared/api/client';
import { BACKEND_URL } from '../../shared/config';
import { getToken } from '../../shared/auth/token';

export interface Document {
  id: number;
  workspaceId: number;
  uploadedByUserId: number | null;
  uploadedByEmail: string | null;
  originalFilename: string;
  mimeType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  fileSizeBytes: number;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  failureReason: string | null;
  chunkCount: number;
  readyAt: string | null;
  createdAt: string;
}

// Whatever the live job (if any) last reported via job.updateProgress() — see the phase
// doc / DocumentEmbeddingProcessor for the exact shape of each stage. Redis-only and
// non-durable: null just means "no live job right now" (already ready/failed, or between
// stages), not an error.
export type DocumentProgress =
  | { stage: 'parsing' }
  | { stage: 'chunking'; pageCount: number | null; wordCount: number }
  | { stage: 'embedding'; completed: number; total: number }
  | null;

export function listDocuments(workspaceId: number): Promise<Document[]> {
  return request(`/workspaces/${workspaceId}/documents`);
}

export function getDocumentProgress(workspaceId: number, documentId: number): Promise<DocumentProgress> {
  return request(`/workspaces/${workspaceId}/documents/${documentId}/progress`);
}

export function deleteDocument(workspaceId: number, documentId: number): Promise<void> {
  return request(`/workspaces/${workspaceId}/documents/${documentId}`, { method: 'DELETE' });
}

// Not routed through shared/api/client's request() — file uploads use FormData, and
// XMLHttpRequest (not fetch) is what makes real upload-progress events possible below.
export function uploadDocument(
  workspaceId: number,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Document> {
  const formData = new FormData();
  formData.append('file', file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_URL}/workspaces/${workspaceId}/documents`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let body: unknown = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // no JSON body — fall through to the status check below
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as Document);
      } else {
        reject(new Error((body as { message?: string })?.message ?? 'Upload failed.'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error.'));
    xhr.send(formData);
  });
}
