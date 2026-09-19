import { config } from 'dotenv';
import { GeminiAnswerGenerationProvider } from './gemini-answer-generation.provider';

config();

describe('GeminiAnswerGenerationProvider', () => {
  const configService = { get: (key: string) => process.env[key] } as any;
  const provider = new GeminiAnswerGenerationProvider(configService);

  it(
    'generates a real answer, respecting the system prompt',
    async () => {
      const answer = await provider.generate(
        'You are a terse assistant. Reply with exactly one word, no punctuation.',
        'What color is the sky on a clear day?',
      );

      expect(typeof answer).toBe('string');
      expect(answer.trim().length).toBeGreaterThan(0);
      expect(answer.toLowerCase()).toContain('blue');
    },
    15000,
  );

  it(
    'refuses to answer from outside a provided context when explicitly instructed not to',
    async () => {
      const systemPrompt =
        'Answer ONLY using the context below. If the answer is not contained in the context, ' +
        'reply with exactly: "I don\'t have information about that."\n\n' +
        'Context:\n[1] Our office hours are 9am to 5pm, Monday to Friday.';

      const answer = await provider.generate(systemPrompt, 'What is the capital of France?');

      expect(answer).toContain("I don't have information about that");
    },
    15000,
  );
});
