export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
