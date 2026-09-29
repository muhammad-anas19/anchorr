import { MigrationInterface, QueryRunner } from 'typeorm';

// The first permissions added after the initial seed — and the workflow every future one
// follows: add the key to the Permission enum AND insert it here. Deploying the enum change
// without this migration makes PermissionsService refuse to boot (its drift check), rather
// than silently 403-ing the new routes for everyone.
export class AddMembershipLifecyclePermissions1790760000000 implements MigrationInterface {
  name = 'AddMembershipLifecyclePermissions1790760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('workspace.leave', 'Leave the workspace'),
        ('workspace.transfer_ownership', 'Hand ownership to another member')
    `);
    // Leaving is granted to every role explicitly rather than exempted from the permission
    // check: deny-by-default stays uniform, and a policy like "members of managed workspaces
    // can't leave on their own" becomes a row deletion instead of a code change.
    await queryRunner.query(`
      INSERT INTO role_permissions (role, permission_key) VALUES
        ('owner', 'workspace.leave'), ('agent', 'workspace.leave'), ('viewer', 'workspace.leave'),
        ('owner', 'workspace.transfer_ownership')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // role_permissions rows go with them (ON DELETE CASCADE).
    await queryRunner.query(`DELETE FROM permissions WHERE key IN ('workspace.leave', 'workspace.transfer_ownership')`);
  }
}
