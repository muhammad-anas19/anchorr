import { ConversationStatus } from '../../database/entities/conversation-status.enum';

// The retrieval settings actually in force for this workspace. Became 'Hybrid' in Phase 13,
// when a real keyword ranking started running alongside the vector one — before that it said
// 'Vector' precisely because describing the screen as Hybrid would have named a system that
// did not exist.
export interface AnswerConfig {
  searchMode: 'Hybrid';
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
  // Which search found this chunk, and where it placed. Null means that search did not
  // return it at all — informative in itself: keyword-only means an exact-token hit the
  // vector side missed, vector-only means a paraphrase with no shared words.
  vectorRank: number | null;
  keywordRank: number | null;
}

// Three values, not a boolean, because "not cached" has two very different causes:
//   hit    — served from cache; no embedding call, no generation call.
//   miss   — eligible for caching, but nothing cached yet (or it was invalidated).
//   bypass — deliberately NOT eligible: this turn used conversation history, so its answer
//            depends on context that is not in the question text and must never be shared.
// A playground showing "miss" for a follow-up question would suggest a cache that is simply
// cold; "bypass" says truthfully that the cache was never going to be used.
export type CacheOutcome = 'hit' | 'miss' | 'bypass';

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  status: ConversationStatus;
  minDistance: number | null;
  promptTokens: number | null;
  totalTokens: number | null;
  retrievedChunks: RetrievedChunkSummary[];
  cache: CacheOutcome;
}
