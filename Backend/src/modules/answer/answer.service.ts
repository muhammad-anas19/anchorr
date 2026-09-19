import { Inject, Injectable } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievedChunk } from '../retrieval/retrieved-chunk.interface';
import {
  ANSWER_GENERATION_PROVIDER,
  AnswerGenerationProvider,
} from '../../generation/answer-generation-provider.interface';
import { AnswerResult, Citation } from './answer-result.interface';

const NO_INFORMATION_ANSWER = "I don't have information about that.";
const CITATION_PATTERN = /\[(\d+)\]/g;

@Injectable()
export class AnswerService {
  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(ANSWER_GENERATION_PROVIDER) private readonly generationProvider: AnswerGenerationProvider,
  ) {}

  async answer(workspaceId: number, question: string): Promise<AnswerResult> {
    const chunks = await this.retrievalService.retrieveRelevantChunks(workspaceId, question);

    // Short-circuit: never call the generation LLM with nothing to ground it — see Phase 9's
    // diagnostic Q6. Cheaper and structurally safer than trusting a prompt instruction to
    // handle an empty context gracefully.
    if (chunks.length === 0) {
      return { answer: NO_INFORMATION_ANSWER, citations: [] };
    }

    const systemPrompt = buildSystemPrompt(chunks);
    const rawAnswer = await this.generationProvider.generate(systemPrompt, question);
    const citations = resolveCitations(rawAnswer, chunks);

    return { answer: rawAnswer, citations };
  }
}

function buildSystemPrompt(chunks: RetrievedChunk[]): string {
  const context = chunks.map((chunk, i) => `[${i + 1}] ${chunk.content}`).join('\n');
  return (
    "You are a customer support assistant. Answer the customer's question using ONLY the " +
    'information in the context below — do not use any outside knowledge. If the answer is ' +
    `not contained in the context, reply with exactly: "${NO_INFORMATION_ANSWER}"\n\n` +
    'When you use information from the context, cite it by putting the matching bracketed ' +
    'number(s) immediately after the relevant sentence, like [1] or [1][2].\n\n' +
    `Context:\n${context}`
  );
}

function resolveCitations(rawAnswer: string, chunks: RetrievedChunk[]): Citation[] {
  const referencedIndexes = new Set<number>();
  for (const match of rawAnswer.matchAll(CITATION_PATTERN)) {
    referencedIndexes.add(Number(match[1]));
  }

  const citations: Citation[] = [];
  for (const index of referencedIndexes) {
    const chunk = chunks[index - 1]; // prompt numbers chunks 1..k; array is 0-indexed
    if (!chunk) {
      // The model cited a number that doesn't correspond to any chunk we actually sent —
      // a real possibility (models don't always follow instructions perfectly, per Q12).
      // Silently dropped rather than surfaced as an error: an unresolvable citation number
      // shouldn't break the whole response.
      continue;
    }
    citations.push({
      index,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      originalFilename: chunk.originalFilename,
    });
  }
  return citations.sort((a, b) => a.index - b.index);
}
