import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

// One allowance for one period. See the CreateWorkspaceQuotas migration for why this is a gate
// derived from usage_events rather than the bill itself.
@Entity('workspace_quotas')
@Unique('UQ_workspace_quotas_period', ['workspaceId', 'metric', 'periodStart'])
@Index('IDX_workspace_quotas_lookup', ['workspaceId', 'metric', 'periodEnd'])
export class WorkspaceQuota {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'workspace_id' })
  workspaceId!: number;

  @Column({ type: 'varchar', length: 32 })
  metric!: 'answer';

  @Column({ type: 'integer' })
  allowance!: number;

  @Column({ type: 'integer', default: 0 })
  used!: number;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart!: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd!: Date;

  @Column({ type: 'varchar', length: 32 })
  source!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
