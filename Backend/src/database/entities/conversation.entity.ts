import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Workspace } from './workspace.entity';
import { ConversationStatus } from './conversation-status.enum';

// Deliberately not imported from modules/answer/ — database entities are lower-level
// infrastructure that feature modules depend on, never the other way around. This shape is
// kept in sync by hand with modules/answer/answer-result.interface.ts's Citation type.
export interface StoredCitation {
  index: number;
  chunkId: number;
  documentId: number;
  originalFilename: string;
  distance: number;
}

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'workspace_id' })
  workspaceId: number;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  // Groups sequential turns of the same widget conversation together, so the last N rows
  // sharing a sessionId can be fed back as context (Phase 11). Null for anything asked
  // outside the widget (e.g. the dashboard's own manual "test the AI" call) — there is no
  // ongoing session to group those into. Client-generated (see Widget's localStorage-backed
  // session id), never server-assigned — the server never initiates a session.
  @Index()
  @Column({ name: 'session_id', type: 'varchar', nullable: true })
  sessionId: string | null;

  @Column({ type: 'text' })
  question: string;

  // Always populated — the real generated answer, or the fixed refusal/escalation message
  // actually shown to the customer. `status` is what distinguishes why, not this column.
  @Column({ type: 'text' })
  answer: string;

  @Column({ type: 'enum', enum: ConversationStatus })
  status: ConversationStatus;

  // Null only when retrieval found zero chunks at all — there is no "closest distance" to
  // report if nothing was retrieved to measure a distance against.
  @Column({ name: 'min_distance', type: 'float', nullable: true })
  minDistance: number | null;

  @Column({ type: 'jsonb' })
  citations: StoredCitation[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
