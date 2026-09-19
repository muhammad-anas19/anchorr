import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { EmbeddingProvider } from './embedding-provider.interface';

const EMBEDDING_MODEL = 'gemini-embedding-001';
// The model's native output is 3072 dimensions — above pgvector's 2000-dimension ceiling
// for HNSW/IVFFlat indexes (the vector *type* itself allows up to 16000, but the index
// types this project needs for Phase 8 don't). 768 is an officially supported, requested
// truncation (Matryoshka-style: the first 768 values of the 3072-dim embedding are
// themselves a valid, meaningful embedding), not an arbitrary or unsupported hack.
const OUTPUT_DIMENSIONALITY = 768;

@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly client: GoogleGenAI;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('GEMINI_API_KEY');
    this.client = new GoogleGenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: [text],
      config: { outputDimensionality: OUTPUT_DIMENSIONALITY },
    });

    const values = response.embeddings?.[0]?.values;
    if (!values) {
      throw new Error('Gemini embedding response contained no embedding values.');
    }
    return values;
  }
}
