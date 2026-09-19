export interface Citation {
  index: number;
  chunkId: number;
  documentId: number;
  originalFilename: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
}
