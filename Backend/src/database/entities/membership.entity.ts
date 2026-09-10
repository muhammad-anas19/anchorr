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
import { MembershipRole } from './membership-role.enum';

@Entity('memberships')
@Unique(['workspaceId', 'userId'])
export class Membership {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'workspace_id' })
  workspaceId: number;

  @ManyToOne(() => Workspace, (workspace) => workspace.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @Index()
  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => User, (user) => user.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: MembershipRole, default: MembershipRole.VIEWER })
  role: MembershipRole;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
