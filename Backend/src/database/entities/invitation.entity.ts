import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Workspace } from './workspace.entity';
import { User } from './user.entity';
import { MembershipRole } from './membership-role.enum';

// Stored lifecycle only. "Expired" is deliberately NOT a stored status: it is derived from
// expires_at at read time. Storing it would need a scheduled job flipping rows at the right
// moment, and until that job ran, a stored 'pending' would be a lie. Deriving it is always right.
export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
}

@Entity('invitations')
@Index('IDX_invitations_workspace_created', ['workspaceId', 'createdAt'])
@Index('UQ_invitations_pending_email', ['workspaceId', 'email'], { unique: true, where: `status = 'pending'` })
export class Invitation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'workspace_id' })
  workspaceId!: number;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace!: Workspace;

  // Normalised (normalizeEmail), like users.email, so it can be compared to an account's email.
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'enum', enum: MembershipRole, enumName: 'memberships_role_enum' })
  role!: MembershipRole;

  // SHA-256 of the token that is emailed. Never the token itself — see InvitationsService.
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @Column({ type: 'enum', enum: InvitationStatus, enumName: 'invitations_status_enum', default: InvitationStatus.PENDING })
  status!: InvitationStatus;

  @Column({ name: 'invited_by_user_id', type: 'integer', nullable: true })
  invitedByUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by_user_id' })
  invitedBy!: User | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'send_count', type: 'integer', default: 1 })
  sendCount!: number;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'accepted_by_user_id', type: 'integer', nullable: true })
  acceptedByUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'accepted_by_user_id' })
  acceptedBy!: User | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  // Reported back by the email worker. 'sent' = accepted by the recipient's mail server.
  @Column({ name: 'email_status', type: 'varchar', length: 16, default: 'queued' })
  emailStatus!: 'queued' | 'sent' | 'failed';

  @Column({ name: 'email_sent_at', type: 'timestamptz', nullable: true })
  emailSentAt!: Date | null;

  @Column({ name: 'email_last_error', type: 'text', nullable: true })
  emailLastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
