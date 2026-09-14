import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Workspace } from './workspace.entity';
import { User } from './user.entity';
import { DocumentStatus } from './document-status.enum';

@Entity('documents')
@Unique(['workspaceId', 'contentHash'])
export class Document {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'workspace_id' })
  workspaceId: number;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @Column({ name: 'uploaded_by_user_id', type: 'integer', nullable: true })
  uploadedByUserId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedBy: User | null;

  @Column({ name: 'original_filename' })
  originalFilename: string;

  @Column({ name: 'storage_key', unique: true })
  storageKey: string;

  @Column({ name: 'mime_type' })
  mimeType: string;

  @Column({ name: 'file_size_bytes' })
  fileSizeBytes: number;

  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  @Column({ type: 'enum', enum: DocumentStatus, default: DocumentStatus.UPLOADED })
  status: DocumentStatus;

  @Column({ name: 'failure_reason', type: 'varchar', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
