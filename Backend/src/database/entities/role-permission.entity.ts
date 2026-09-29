import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MembershipRole } from './membership-role.enum';
import { PermissionEntity } from './permission.entity';

// Which role holds which permission. Many-to-many between roles and permissions, and the whole
// of the RBAC policy lives in this one table.
//
// Roles are NOT a table: they reuse the existing memberships_role_enum type, so a role here can
// only ever be one memberships can actually hold. Making roles a table (custom roles per
// workspace) is the next step real products take — see the doc's "custom roles" note.
@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn({ type: 'enum', enum: MembershipRole, enumName: 'memberships_role_enum' })
  role!: MembershipRole;

  @PrimaryColumn({ name: 'permission_key', type: 'varchar', length: 64 })
  permissionKey!: string;

  @ManyToOne(() => PermissionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_key' })
  permission!: PermissionEntity;
}
