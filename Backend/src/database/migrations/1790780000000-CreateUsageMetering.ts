import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 15, increment 1: the meter, and client idempotency keys for answers.
//
// Hand-written, like every migration since Phase 10 (migration:generate would try to drop and
// recreate the Phase 8 HNSW index it cannot read).
export class CreateUsageMetering1790780000000 implements MigrationInterface {
  name = 'CreateUsageMetering1790780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "usage_events" (
        "id" BIGSERIAL PRIMARY KEY,
        -- RESTRICT, not CASCADE like every other workspace-owned table: billing history is a
        -- financial record. Deleting a workspace must not silently erase what it was billed for.
        "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
        "metric" varchar(32) NOT NULL CONSTRAINT "CHK_usage_events_metric" CHECK (metric IN ('answer', 'chunk_embedded')),
        "quantity" integer NOT NULL CONSTRAINT "CHK_usage_events_quantity" CHECK (quantity > 0),
        -- Whether this event counts toward billing and quota, decided when it is written (from
        -- the product rule in force then) and never recomputed silently. The attributes below
        -- keep the raw facts, so a changed rule can still be re-applied to history deliberately.
        "billable" boolean NOT NULL,
        -- When the usage happened (what periods are assigned by) vs when the row was written.
        -- They differ when work is recorded late — a queued job, a retry.
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "recorded_at" timestamptz NOT NULL DEFAULT now(),
        -- Identifies the unit of work, so the same work can never be metered twice.
        "idempotency_key" varchar(200) NOT NULL,
        "conversation_id" integer REFERENCES "conversations"("id") ON DELETE SET NULL,
        "document_id" integer REFERENCES "documents"("id") ON DELETE SET NULL,
        -- The raw facts: status, tokens, cache outcome, model. Never a price.
        "attributes" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "UQ_usage_events_idempotency" UNIQUE ("workspace_id", "metric", "idempotency_key")
      )
    `);
    // Every read is "this workspace, this time range" — period totals, the daily chart, quota
    // reconciliation. Half-open [from, to) range scans on this index.
    await queryRunner.query(`
      CREATE INDEX "IDX_usage_events_workspace_occurred" ON "usage_events" ("workspace_id", "occurred_at")
    `);

    // The client's own key for "this exact request", so a retry after a lost response replays
    // the original answer instead of running (and charging for) a second one. Already
    // namespaced by the caller before it gets here (see AnswerService), so one caller can
    // never read another's replay. NULLs are distinct in a Postgres UNIQUE, so requests
    // without a key are unaffected.
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "idempotency_key" varchar(200)`);
    await queryRunner.query(`
      ALTER TABLE "conversations" ADD CONSTRAINT "UQ_conversations_idempotency" UNIQUE ("workspace_id", "idempotency_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "UQ_conversations_idempotency"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "idempotency_key"`);
    await queryRunner.query(`DROP TABLE "usage_events"`);
  }
}
