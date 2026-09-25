export const ANSWER_GENERATION_PROVIDER = Symbol('ANSWER_GENERATION_PROVIDER');

export interface GenerateOptions {
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  // The real token counts the provider's own API reported for this call, when it reports
  // them at all — null for a substitute/test provider, or if a real provider genuinely
  // doesn't expose usage data. Never estimated or guessed when a real number isn't available.
  // promptTokens is just what was sent (the assembled context + question); totalTokens also
  // includes the model's own output and internal "thinking" tokens.
  promptTokens: number | null;
  totalTokens: number | null;
}

export interface AnswerGenerationProvider {
  generate(systemPrompt: string, userMessage: string, options?: GenerateOptions): Promise<GenerateResult>;
}
