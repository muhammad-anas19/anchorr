import { Module } from '@nestjs/common';
import { EMBEDDING_PROVIDER } from './embedding-provider.interface';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';

@Module({
  providers: [{ provide: EMBEDDING_PROVIDER, useClass: GeminiEmbeddingProvider }],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
