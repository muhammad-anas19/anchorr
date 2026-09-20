import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Membership } from './membership.entity';

@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  // The only identifier ever exposed to the public widget surface — never `id`. Generated
  // once at workspace creation (see AuthService.register), the same pattern Phase 3 already
  // used for Document.storageKey: a random value set in application code, not a DB default.
  @Column({ name: 'public_key', unique: true })
  publicKey: string;

  // Domains the widget is allowed to run on for this workspace. A real, checked allowlist
  // (Phase 11's design), not a strong secret on its own — see the phase doc's Q2 for why.
  @Column({ name: 'allowed_origins', type: 'text', array: true, default: '{}' })
  allowedOrigins: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Membership, (membership) => membership.workspace)
  memberships: Membership[];
}
