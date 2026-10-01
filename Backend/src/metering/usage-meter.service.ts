import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ConversationStatus } from '../database/entities/conversation-status.enum';
import type { UsageMetric } from '../database/entities/usage-event.entity';

export interface UsageEventInput {
  workspaceId: number;
  metric: UsageMetric;
  quantity: number;
  billable: boolean;
  idempotencyKey: string;
  conversationId?: number | null;
  documentId?: number | null;
  attributes?: Record<string, unknown>;
}


export function isBillableAnswer(status: ConversationStatus): boolean {
  return status === ConversationStatus.ANSWERED || status === ConversationStatus.REFUSED;
}


@Injectable()
export class UsageMeter {
  async record(manager: EntityManager, event: UsageEventInput): Promise<void> {
    await manager.query(
      `INSERT INTO usage_events
         (workspace_id, metric, quantity, billable, idempotency_key, conversation_id, document_id, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ON CONSTRAINT "UQ_usage_events_idempotency" DO NOTHING`,
      [
        event.workspaceId,
        event.metric,
        event.quantity,
        event.billable,
        event.idempotencyKey,
        event.conversationId ?? null,
        event.documentId ?? null,
        JSON.stringify(event.attributes ?? {}),
      ],
    );
  }
}
