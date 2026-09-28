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

  // Nullable: a chunk exists (from Phase 6) before it has an embedding (Phase 7) — a chunk
  // row's lifecycle is "created without one, then filled in once Gemini's embedding API
  // call for it succeeds." 768 matches Gemini's text embedding model's output dimension.
  @Column({ type: 'vector', length: 768, nullable: true })
  embedding: number[] | null;

  // Maintained entirely by Postgres (GENERATED ALWAYS ... STORED, see the migration), which
  // is why it is marked insert: false / update: false — TypeORM must never try to write it,
  // and Postgres rejects any attempt to. Declared here only so the column is not invisible
  // to anyone reading the entity, and so `synchronize` comparisons do not treat it as drift.
  @Column({ name: 'content_tsv', type: 'tsvector', nullable: true, insert: false, update: false, select: false })
  contentTsv?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
