import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AnswerGenerationProvider, GenerateOptions } from './answer-generation-provider.interface';

// gemini-2.5-flash (the model named in Google's own docs/examples at the time this was
// written) returned a real 404 — "no longer available to new users" — pointing directly at
// this replacement. Same lesson as Phase 7's embedding model: verify against the live API,
// don't trust a name from memory or documentation.
const GENERATION_MODEL = 'gemini-3.6-flash';
// Low by design, not left at the API's default: a factual support answer should favor
// consistency over creative variation (Q7's reasoning) — a real, deliberate choice, not an
// accident of whatever the SDK happens to default to.
const DEFAULT_TEMPERATURE = 0.2;

@Injectable()
export class GeminiAnswerGenerationProvider implements AnswerGenerationProvider {
  private readonly client: GoogleGenAI;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('GEMINI_API_KEY');
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(systemPrompt: string, userMessage: string, options?: GenerateOptions): Promise<string> {
    const response = await this.client.models.generateContent({
      model: GENERATION_MODEL,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error('Gemini generation response contained no text.');
    }
    return text;
  }
}
