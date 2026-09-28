export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  originalFilename: string;
  chunkIndex: number;
  content: string;
  // The real cosine distance, computed for EVERY returned chunk regardless of which search
  // found it. Kept alongside the fused ranking on purpose: after Phase 13, ranking and
  // confidence are two different jobs. `rrfScore` decides the order; this still decides
  // whether the answer layer trusts the result enough to call the LLM (Phase 10).
  distance: number;
  // Position within each individual ranking, 1-based. Null when that search did not return
  // this chunk at all — which is normal and informative: a chunk found only by keyword search
  // is exactly the exact-token case vector search is bad at, and vice versa.
  vectorRank: number | null;
  keywordRank: number | null;
  rrfScore: number;
}

// A wrapper rather than a bare array, so per-query information (which search found what, and
// eventually timing or fallback flags) has somewhere to live that is not a per-chunk field.
export interface RetrievalResult {
  chunks: RetrievedChunk[];
}
