import { request } from '../../shared/api/client';

export interface Citation {
  index: number;
  chunkId: number;
  documentId: number;
  originalFilename: string;
  distance: number;
}

export interface RetrievedChunkSummary {
  chunkId: number;
  documentId: number;
  originalFilename: string;
  distance: number;
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  status: 'answered' | 'refused' | 'escalated';
  minDistance: number | null;
  promptTokens: number | null;
  totalTokens: number | null;
  retrievedChunks: RetrievedChunkSummary[];
}

export function ask(workspaceId: number, question: string, sessionId: string): Promise<AnswerResult> {
  return request(`/workspaces/${workspaceId}/ask`, {
    method: 'POST',
    body: JSON.stringify({ question, sessionId }),
  });
}
