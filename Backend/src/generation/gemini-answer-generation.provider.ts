import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AnswerGenerationProvider, GenerateOptions, GenerateResult } from './answer-generation-provider.interface';

export const GENERATION_MODEL = 'gemini-3.6-flash';
const DEFAULT_TEMPERATURE = 0.2;

@Injectable()
export class GeminiAnswerGenerationProvider implements AnswerGenerationProvider {
  private readonly client: GoogleGenAI;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('GEMINI_API_KEY');
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(systemPrompt: string, userMessage: string, options?: GenerateOptions): Promise<GenerateResult> {
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
    
    return {
      text,
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount ?? null,
    };
  }
}
