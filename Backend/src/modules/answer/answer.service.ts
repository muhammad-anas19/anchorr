import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RetrievalService } from '../retrieval/retrieval.service';
import { RetrievedChunk } from '../retrieval/retrieved-chunk.interface';
import {
  ANSWER_GENERATION_PROVIDER,
  AnswerGenerationProvider,
} from '../../generation/answer-generation-provider.interface';
import { Conversation } from '../../database/entities/conversation.entity';
import { ConversationStatus } from '../../database/entities/conversation-status.enum';
import { AnswerResult, Citation } from './answer-result.interface';

const NO_INFORMATION_ANSWER = "I don't have information about that.";
const ESCALATION_ANSWER =
  "I'm having trouble generating an answer right now — let me connect you with a member of our team who can help.";
const CITATION_PATTERN = /\[(\d+)\]/g;

// A real starting point, not a guessed one: measured directly against this project's own
// embedding model — a genuinely related question scored ~0.22 distance (and a differently
// -phrased related question in Phase 8's own test scored ~0.38), while a genuinely unrelated
// question scored ~0.56. 0.45 sits between the observed related and unrelated ranges. Tunable
// once Phase 17 (Evaluations) gives real outcome data — not asserted as permanently correct.
const CONFIDENT_DISTANCE_THRESHOLD = 0.45;

@Injectable()
export class AnswerService {
  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(ANSWER_GENERATION_PROVIDER) private readonly generationProvider: AnswerGenerationProvider,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
  ) {}

  async answer(workspaceId: number, question: string): Promise<AnswerResult> {
    const chunks = await this.retrievalService.retrieveRelevantChunks(workspaceId, question);

    // chunks are already ordered closest-first (Phase 8) — chunks[0] IS the minimum distance,
    // no separate aggregation needed. Using the closest match only (not an average across all
    // k results), per this phase's design: averaging in mediocre also-rans that LIMIT k
    // returns regardless of quality would dilute a genuinely strong single match.
    const minDistance = chunks.length > 0 ? chunks[0].distance : null;

    // Short-circuit: never call the generation LLM with nothing to ground it, or with only
    // weak, unlikely-to-be-relevant matches — see Phase 9's Q6 and Phase 10's own diagnostic.
    // A weak match is treated exactly like no match at all: refused, not answered.
    if (minDistance === null || minDistance >= CONFIDENT_DISTANCE_THRESHOLD) {
      return this.persistAndReturn(workspaceId, question, {
        answer: NO_INFORMATION_ANSWER,
        citations: [],
        status: ConversationStatus.REFUSED,
      }, minDistance);
    }

    const systemPrompt = buildSystemPrompt(chunks);
    let rawAnswer: string;
    try {
      rawAnswer = await this.generationProvider.generate(systemPrompt, question);
    } catch {
      // A genuine generation failure (Phase 9's real 500 case) is a concrete, real reason to
      // flag this for a human — "the AI tried and couldn't complete the answer" — unlike a
      // guessed confidence middle-zone with no real data behind it. No retry: the customer is
      // waiting live (Phase 9's Q10 reasoning).
      return this.persistAndReturn(workspaceId, question, {
        answer: ESCALATION_ANSWER,
        citations: [],
        status: ConversationStatus.ESCALATED,
      }, minDistance);
    }

    const citations = resolveCitations(rawAnswer, chunks);
    return this.persistAndReturn(workspaceId, question, {
      answer: rawAnswer,
      citations,
      status: ConversationStatus.ANSWERED,
    }, minDistance);
  }

  private async persistAndReturn(
    workspaceId: number,
    question: string,
    result: AnswerResult,
    minDistance: number | null,
  ): Promise<AnswerResult> {
    await this.conversations.save({
      workspaceId,
      question,
      answer: result.answer,
      status: result.status,
      minDistance,
      citations: result.citations,
    });
    return result;
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
