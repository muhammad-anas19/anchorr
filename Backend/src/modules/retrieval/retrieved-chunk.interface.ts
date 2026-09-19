export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  originalFilename: string;
  chunkIndex: number;
  content: string;
  distance: number;
}
