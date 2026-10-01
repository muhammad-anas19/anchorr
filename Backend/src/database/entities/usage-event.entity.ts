import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type UsageMetric = 'answer' | 'chunk_embedded';


@Entity('usage_events')
@Unique('UQ_usage_events_idempotency', ['workspaceId', 'metric', 'idempotencyKey'])
@Index('IDX_usage_events_workspace_occurred', ['workspaceId', 'occurredAt'])
export class UsageEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'workspace_id' })
  workspaceId!: number;

  @Column({ type: 'varchar', length: 32 })
  metric!: UsageMetric;

  @Column({ type: 'integer' })
  quantity!: number;

  @Column({ type: 'boolean' })
  billable!: boolean;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  @Column({ name: 'recorded_at', type: 'timestamptz', default: () => 'now()' })
  recordedAt!: Date;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 200 })
  idempotencyKey!: string;

  @Column({ name: 'conversation_id', type: 'integer', nullable: true })
  conversationId!: number | null;

  @Column({ name: 'document_id', type: 'integer', nullable: true })
  documentId!: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  attributes!: Record<string, unknown>;
}
