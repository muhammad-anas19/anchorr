export const ANSWER_GENERATION_PROVIDER = Symbol('ANSWER_GENERATION_PROVIDER');

export interface GenerateOptions {
  temperature?: number;
}

export interface AnswerGenerationProvider {
  generate(systemPrompt: string, userMessage: string, options?: GenerateOptions): Promise<string>;
}
