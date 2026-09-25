import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written rather than generated. `migration:generate` has tried to drop and recreate
// the Phase 8 HNSW index as a plain index on every run since Phase 10 (its differ doesn't
// understand `USING hnsw`), so any migration whose change is this small is safer written by
// hand than generated and then hand-corrected.
export class AddEscalationTimestampsToConversationSessions1790311439226 implements MigrationInterface {
  name = 'AddEscalationTimestampsToConversationSessions1790311439226';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversation_sessions" ADD "escalated_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "conversation_sessions" ADD "resolved_at" TIMESTAMP`);

    // Existing escalated rows predate this column. Backfilling from created_at is the
    // closest available truth (recordEscalation creates the row at escalation time in the
    // common case) and keeps "longest wait" from reading NULL for every pre-existing row.
    await queryRunner.query(
      `UPDATE "conversation_sessions" SET "escalated_at" = "created_at" WHERE "status" IN ('escalated', 'claimed', 'resolved')`,
    );

    // The queue is always read filtered by workspace and ordered by how long something has
    // been waiting — this composite index matches that access pattern's leading columns.
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_sessions_workspace_status" ON "conversation_sessions" ("workspace_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_conversation_sessions_workspace_status"`);
    await queryRunner.query(`ALTER TABLE "conversation_sessions" DROP COLUMN "resolved_at"`);
    await queryRunner.query(`ALTER TABLE "conversation_sessions" DROP COLUMN "escalated_at"`);
  }
}
