import { Column, Entity, PrimaryColumn } from 'typeorm';

// The catalogue of permissions that exist. Keyed by the string itself ('documents.manage')
// rather than an integer id, so role_permissions rows read meaningfully in psql and a key can
// be referenced from code without a lookup.
@Entity('permissions')
export class PermissionEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'text' })
  description!: string;
}
