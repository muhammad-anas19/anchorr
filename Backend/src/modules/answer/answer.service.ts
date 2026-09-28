import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_K, RetrievalService } from '../retrieval/retrieval.service';
import { GENERATION_MODEL } from '../../generation/gemini-answer-generation.provider';
import { RetrievedChunk } from '../retrieval/retrieved-chunk.interface';
import {
  ANSWER_GENERATION_PROVIDER,
  AnswerGenerationProvider,
  GenerateResult,
} from '../../generation/answer-generation-provider.interface';
import { Conversation } from '../../database/entities/conversation.entity';
import { ConversationStatus } from '../../database/entities/conversation-status.enum';
import { HandoffService } from '../handoff/handoff.service';
import { AnswerConfig, AnswerResult, Citation } from './answer-result.interface';

const NO_INFORMATION_ANSWER = "I don't have information about that.";
const ESCALATION_ANSWER =
  "I'm having trouble generating an answer right now — let me connect you with a member of our team who can help.";
const CITATION_PATTERN = /\[(\d+)\]/g;

export const CONFIDENT_DISTANCE_THRESHOLD = 0.45;


@Injectable()
export class AnswerService {
  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(ANSWER_GENERATION_PROVIDER) private readonly generationProvider: AnswerGenerationProvider,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly handoffService: HandoffService,
  ) {}

  async getConfig(workspaceId: number): Promise<AnswerConfig> {
    return {
      searchMode: 'Hybrid',
      topK: DEFAULT_K,
      model: GENERATION_MODEL,
      confidenceThreshold: CONFIDENT_DISTANCE_THRESHOLD,
      searchableChunks: await this.retrievalService.countSearchableChunks(workspaceId),
    };
  }

  async answer(workspaceId: number, question: string, sessionId: string | null = null): Promise<AnswerResult> {
    const { chunks } = await this.retrievalService.retrieveRelevantChunks(workspaceId, question);

    const distances = chunks.map((chunk) => chunk.distance).filter((d) => Number.isFinite(d));
    const minDistance = distances.length > 0 ? Math.min(...distances) : null;

    const retrievedChunks = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      originalFilename: chunk.originalFilename,
      distance: chunk.distance,
      snippet: chunk.content.slice(0, 160),
      vectorRank: chunk.vectorRank,
      keywordRank: chunk.keywordRank,
    }));
    if (minDistance === null || minDistance >= CONFIDENT_DISTANCE_THRESHOLD) {
      return this.persistAndReturn(workspaceId, question, {
        answer: NO_INFORMATION_ANSWER,
        citations: [],
        status: ConversationStatus.REFUSED,
        minDistance,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks,
      }, sessionId);
    }
    const history = sessionId ? await this.fetchRecentHistory(workspaceId, sessionId) : [];

    const systemPrompt = buildSystemPrompt(chunks, history);
    let generated: GenerateResult;
    try {
      generated = await this.generationProvider.generate(systemPrompt, question);
    } catch {
      return this.persistAndReturn(workspaceId, question, {
        answer: ESCALATION_ANSWER,
        citations: [],
        status: ConversationStatus.ESCALATED,
        minDistance,
        promptTokens: null,
        totalTokens: null,
        retrievedChunks,
      }, sessionId);
    }

    const citations = resolveCitations(generated.text, chunks);
    return this.persistAndReturn(workspaceId, question, {
      answer: generated.text,
      citations,
      status: ConversationStatus.ANSWERED,
      minDistance,
      promptTokens: generated.promptTokens,
      totalTokens: generated.totalTokens,
      retrievedChunks,
    }, sessionId);
  }

  private async fetchRecentHistory(workspaceId: number, sessionId: string): Promise<Conversation[]> {
    const rows = await this.conversations.find({
      where: { workspaceId, sessionId },
      order: { createdAt: 'DESC' },
      take: 5,
    });
    return rows.reverse();
  }

  private async persistAndReturn(
    workspaceId: number,
    question: string,
    result: AnswerResult,
    sessionId: string | null,
  ): Promise<AnswerResult> {
    await this.conversations.save({
      workspaceId,
      sessionId,
      question,
      answer: result.answer,
      status: result.status,
      minDistance: result.minDistance,
      citations: result.citations,
    });

    // A genuine escalation is the one outcome an agent actually needs to see (Phase 12) —
    // recorded against the session as a whole, not this one turn, and only when there's a
    // session to record it against at all (the dashboard's own manual /ask calls have none).
    if (result.status === ConversationStatus.ESCALATED && sessionId) {
      await this.handoffService.recordEscalation(workspaceId, sessionId);
    }

    return result;
  }
}

function buildSystemPrompt(chunks: RetrievedChunk[], history: Conversation[]): string {
  const context = chunks.map((chunk, i) => `[${i + 1}] ${chunk.content}`).join('\n');
  const historySection =
    history.length > 0
      ? '\n\nPrevious turns in this conversation (for context only — citations above still ' +
        'refer only to the numbered context, not to these prior turns):\n' +
        history.map((turn) => `Customer: ${turn.question}\nAssistant: ${turn.answer}`).join('\n')
      : '';
  return (
    "You are a customer support assistant. Answer the customer's question using ONLY the " +
    'information in the context below — do not use any outside knowledge. If the answer is ' +
    `not contained in the context, reply with exactly: "${NO_INFORMATION_ANSWER}"\n\n` +
    'When you use information from the context, cite it by putting the matching bracketed ' +
    'number(s) immediately after the relevant sentence, like [1] or [1][2].\n\n' +
    `Context:\n${context}${historySection}`
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
      distance: chunk.distance,
    });
  }
  return citations.sort((a, b) => a.index - b.index);
}
