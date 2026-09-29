import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written, like every migration since Phase 10: migration:generate would also try to drop
// and recreate the Phase 8 HNSW index it cannot read.
//
// Every timestamp here is timestamptz, unlike the older tables. timestamptz stores an absolute
// instant, so it does not matter whether a value was written by node-postgres or by now() — the
// five-hour bug of Phase 13 (JS local time vs. Postgres UTC in a plain timestamp column) cannot
// happen in this table. Values are still written with now() for consistency.
export class CreateInvitations1790750000000 implements MigrationInterface {
  name = 'CreateInvitations1790750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "invitations_status_enum" AS ENUM ('pending', 'accepted', 'revoked')`);

    await queryRunner.query(`
      CREATE TABLE "invitations" (
        "id" SERIAL PRIMARY KEY,
        "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
        "email" varchar(320) NOT NULL CONSTRAINT "CHK_invitations_email_normalized" CHECK (email = lower(trim(email))),
        "role" "memberships_role_enum" NOT NULL,
        "token_hash" varchar(64) NOT NULL CONSTRAINT "UQ_invitations_token_hash" UNIQUE,
        "status" "invitations_status_enum" NOT NULL DEFAULT 'pending',
        "invited_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "expires_at" timestamptz NOT NULL,
        "send_count" integer NOT NULL DEFAULT 1,
        "last_sent_at" timestamptz NOT NULL DEFAULT now(),
        "accepted_at" timestamptz,
        "accepted_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "revoked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        -- A row's timestamps must agree with its status, so no code path can leave an
        -- 'accepted' invitation with nobody recorded as accepting it.
        CONSTRAINT "CHK_invitations_status_fields" CHECK (
          (status = 'pending'  AND accepted_at IS NULL AND revoked_at IS NULL) OR
          (status = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
          (status = 'revoked'  AND revoked_at IS NOT NULL AND accepted_at IS NULL)
        )
      )
    `);

    // At most one PENDING invitation per email per workspace — a partial unique index. A plain
    // UNIQUE(workspace_id, email) would be wrong: it would forbid ever re-inviting someone
    // whose earlier invitation was accepted (and who later left) or revoked. The WHERE clause
    // limits uniqueness to the rows where a duplicate actually means something.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_invitations_pending_email"
      ON "invitations" ("workspace_id", "email") WHERE status = 'pending'
    `);

    // The list endpoint: one workspace's invitations, newest first.
    await queryRunner.query(`
      CREATE INDEX "IDX_invitations_workspace_created" ON "invitations" ("workspace_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "invitations"`);
    await queryRunner.query(`DROP TYPE "invitations_status_enum"`);
  }
}
