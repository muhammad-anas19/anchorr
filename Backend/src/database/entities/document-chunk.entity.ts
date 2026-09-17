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
import { Document } from './document.entity';

@Entity('document_chunks')
@Unique(['documentId', 'chunkIndex'])
export class DocumentChunk {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'document_id' })
  documentId: number;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @Column({ name: 'chunk_index', type: 'integer' })
  chunkIndex: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'char_start', type: 'integer' })
  charStart: number;

  @Column({ name: 'char_end', type: 'integer' })
  charEnd: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
