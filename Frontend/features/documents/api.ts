import { request } from '../../shared/api/client';
import { BACKEND_URL } from '../../shared/config';
import { getValidAccessToken } from '../../shared/auth/session';

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
export async function uploadDocument(
  workspaceId: number,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Document> {
  const formData = new FormData();
  formData.append('file', file);

  // Resolved before the request is built, because this path can't use the 401-retry in
  // shared/api/client — a retry here would have to re-send the whole file, and the progress
  // bar the user is watching would jump back to 0%. Refreshing first avoids the situation.
  const token = await getValidAccessToken();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_URL}/workspaces/${workspaceId}/documents`);
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
