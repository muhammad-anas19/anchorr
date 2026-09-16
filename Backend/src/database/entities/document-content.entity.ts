import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Document } from './document.entity';

@Entity('document_contents')
export class DocumentContent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'document_id', unique: true })
  documentId: number;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @Column({ name: 'extracted_text', type: 'text' })
  extractedText: string;

  @Column({ name: 'page_count', type: 'integer', nullable: true })
  pageCount: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
