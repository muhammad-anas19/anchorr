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
  // Phase 13. Null means that search did not return this chunk — the prototype mocked these
  // up as "vector 0.91 / keyword 0.88"; they are real ranks now, not scores.
  vectorRank: number | null;
  keywordRank: number | null;
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

// The retrieval settings actually in force, read from the Backend rather than restated here
// — if the threshold or the model changes server-side, this screen follows automatically.
export interface AnswerConfig {
  searchMode: 'Hybrid';
  topK: number;
  model: string;
  confidenceThreshold: number;
  searchableChunks: number;
}

export function getAnswerConfig(workspaceId: number, signal?: AbortSignal): Promise<AnswerConfig> {
  return request(`/workspaces/${workspaceId}/ask/config`, { signal });
}

export function ask(workspaceId: number, question: string, sessionId: string): Promise<AnswerResult> {
  return request(`/workspaces/${workspaceId}/ask`, {
    method: 'POST',
    body: JSON.stringify({ question, sessionId }),
  });
}
