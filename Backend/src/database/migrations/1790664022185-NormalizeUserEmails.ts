import { MigrationInterface, QueryRunner } from 'typeorm';

// Until now emails were stored exactly as typed, so "Anas@x.com" and "anas@x.com" could register
// as two separate accounts and logging in with different capitalisation failed. Invitations
// bind access to an email address, which makes a single canonical form mandatory.
export class NormalizeUserEmails1790664022185 implements MigrationInterface {
  name = 'NormalizeUserEmails1790664022185';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuse rather than guess. If two existing accounts collapse to the same address, merging
    // them means choosing whose memberships, password and history survive — a decision for a
    // human, not a migration.
    const collisions = await queryRunner.query(`
      SELECT lower(trim(email)) AS email, count(*)::int AS accounts
      FROM users GROUP BY 1 HAVING count(*) > 1
    `);
    if (collisions.length > 0) {
      throw new Error(
        `Cannot normalise emails: these addresses belong to more than one account and must be ` +
          `merged by hand first: ${collisions.map((c: { email: string }) => c.email).join(', ')}`,
      );
    }

    await queryRunner.query(`UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email))`);

    // Defence in depth. The application normalises every email (normalizeEmail), but a CHECK
    // makes the database itself reject a non-canonical address from any code path that forgets —
    // a bulk import, a psql session, a future service. With every stored email lowercase, the
    // existing plain UNIQUE constraint on users.email becomes case-insensitive in effect.
    await queryRunner.query(`
      ALTER TABLE users ADD CONSTRAINT "CHK_users_email_normalized"
      CHECK (email = lower(trim(email)))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP CONSTRAINT "CHK_users_email_normalized"`);
  }
}
