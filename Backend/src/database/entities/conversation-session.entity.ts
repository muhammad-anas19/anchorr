import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Workspace } from './workspace.entity';
import { User } from './user.entity';
import { ConversationSessionStatus } from './conversation-session-status.enum';

// The unit an agent actually claims. `Conversation` (Phase 9/10) is an immutable per-turn
// log — there's no single row in it representing "this ongoing session" to attach claim
// state to. This table is that missing "state of the conversation as a whole" record, kept
// deliberately separate from the turn-by-turn log it's derived from (Phase 12's Q&A).
@Entity('conversation_sessions')
@Unique(['workspaceId', 'sessionId'])
export class ConversationSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'workspace_id' })
  workspaceId: number;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  // The same string Conversation.sessionId carries — the widget's own localStorage-backed id.
  // Scoped uniquely per workspace, not globally — matches Document's UNIQUE(workspaceId,
  // contentHash) precedent, even though a widget-generated UUID colliding across two
  // different workspaces is astronomically unlikely in practice.
  @Column({ name: 'session_id' })
  sessionId: string;

  @Column({ type: 'enum', enum: ConversationSessionStatus, default: ConversationSessionStatus.OPEN })
  status: ConversationSessionStatus;

  @Column({ name: 'claimed_by_user_id', type: 'integer', nullable: true })
  claimedByUserId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'claimed_by_user_id' })
  claimedByUser: User | null;

  @Column({ name: 'claimed_at', type: 'timestamp', nullable: true })
  claimedAt: Date | null;

  // Distinct from createdAt: a session row can be created as OPEN and escalate much later,
  // so "how long has this been waiting for a human" is only answerable from the moment it
  // actually entered the queue. Nullable because a session that never escalated has no
  // meaningful value here — not because the time is unknown.
  @Column({ name: 'escalated_at', type: 'timestamp', nullable: true })
  escalatedAt: Date | null;

  // Deliberately not derived from updatedAt: updatedAt moves on ANY write (a claim, a
  // status correction), so counting "resolved today" off it would silently include sessions
  // resolved days ago but touched since.
  @Column({ name: 'resolved_at', type: 'timestamp', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
