import { MigrationInterface, QueryRunner } from 'typeorm';

// Usage and cost figures are business data, like billing: owner-only by default. Granting
// agents read access later is one row here, not a code change — the point of Increment 1b.
export class AddUsageViewPermission1790800000000 implements MigrationInterface {
  name = 'AddUsageViewPermission1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO permissions (key, description) VALUES ('usage.view', 'See usage, cost drivers and the plan allowance')`,
    );
    await queryRunner.query(`INSERT INTO role_permissions (role, permission_key) VALUES ('owner', 'usage.view')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM permissions WHERE key = 'usage.view'`);
  }
}
