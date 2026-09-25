import { ConversationStatus } from '../../database/entities/conversation-status.enum';

// The retrieval settings actually in force for this workspace. "Vector" is not a placeholder
// for "Hybrid": hybrid search (Phase 13) genuinely does not exist yet, and labelling the
// screen Hybrid would describe a system that hasn't been built.
export interface AnswerConfig {
  searchMode: 'Vector';
  topK: number;
  model: string;
  confidenceThreshold: number;
  searchableChunks: number;
}

export interface Citation {
  index: number;
  chunkId: number;
  documentId: number;
  originalFilename: string;
  distance: number;
}

// A trimmed view of every chunk retrieval actually returned for this question — not just
// the ones the model chose to cite. Ephemeral, response-only data (like totalTokens below):
// useful for a live "what did the model see" UI, but not persisted anywhere, unlike
// status/minDistance/citations, which Phase 10 deliberately chose to keep for the state
// machine's own sake.
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
  status: ConversationStatus;
  minDistance: number | null;
  promptTokens: number | null;
  totalTokens: number | null;
  retrievedChunks: RetrievedChunkSummary[];
}
