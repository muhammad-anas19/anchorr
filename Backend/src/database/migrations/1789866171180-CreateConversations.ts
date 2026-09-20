import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateConversations1789866171180 implements MigrationInterface {
    name = 'CreateConversations1789866171180'

    // The auto-generated version of this migration also tried to DROP Phase 8's real HNSW
    // index and recreate it as a plain, non-HNSW index in down() — TypeORM's schema diffing
    // doesn't understand `USING hnsw (... vector_cosine_ops)` (the exact gap Phase 8's own
    // migration had to work around by hand), so it saw an "undeclared" index and wanted to
    // "fix" it. Stripped out by hand — unrelated to what this migration actually does.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."conversations_status_enum" AS ENUM('answered', 'refused', 'escalated')`);
        await queryRunner.query(`CREATE TABLE "conversations" ("id" SERIAL NOT NULL, "workspace_id" integer NOT NULL, "question" text NOT NULL, "answer" text NOT NULL, "status" "public"."conversations_status_enum" NOT NULL, "min_distance" double precision, "citations" jsonb NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2136015a4b73fb4898773f2226" ON "conversations" ("workspace_id") `);
        await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_2136015a4b73fb4898773f2226f" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_2136015a4b73fb4898773f2226f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2136015a4b73fb4898773f2226"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
        await queryRunner.query(`DROP TYPE "public"."conversations_status_enum"`);
    }

}
