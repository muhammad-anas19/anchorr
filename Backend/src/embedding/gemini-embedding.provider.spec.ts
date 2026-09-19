import { config } from 'dotenv';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';

config();

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

describe('GeminiEmbeddingProvider', () => {
  const configService = { get: (key: string) => process.env[key] } as any;
  const provider = new GeminiEmbeddingProvider(configService);

  it(
    'returns a real 768-dimension embedding for real text',
    async () => {
      const vector = await provider.embed('Refunds are available within 30 days of purchase.');

      expect(vector).toHaveLength(768);
      expect(vector.every((n) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
    },
    15000,
  );

  it(
    'places semantically similar text closer together than semantically unrelated text',
    async () => {
      const refundPolicy = await provider.embed('Refunds are available within 30 days of purchase.');
      const askingForMoneyBack = await provider.embed('How do I get my money back?');
      const shippingHours = await provider.embed('Our warehouse ships orders Monday through Friday.');

      const similarityToRelatedQuestion = cosineSimilarity(refundPolicy, askingForMoneyBack);
      const similarityToUnrelatedTopic = cosineSimilarity(refundPolicy, shippingHours);

      // The whole point of this phase: "how do I get my money back" shares zero words with
      // "refunds are available", yet should land meaningfully closer to it than a completely
      // unrelated sentence about shipping — proving the embedding captures meaning, not words.
      expect(similarityToRelatedQuestion).toBeGreaterThan(similarityToUnrelatedTopic);
    },
    20000,
  );
});
