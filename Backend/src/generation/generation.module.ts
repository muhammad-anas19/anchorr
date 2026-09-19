import { Module } from '@nestjs/common';
import { ANSWER_GENERATION_PROVIDER } from './answer-generation-provider.interface';
import { GeminiAnswerGenerationProvider } from './gemini-answer-generation.provider';

@Module({
  providers: [{ provide: ANSWER_GENERATION_PROVIDER, useClass: GeminiAnswerGenerationProvider }],
  exports: [ANSWER_GENERATION_PROVIDER],
})
export class GenerationModule {}
