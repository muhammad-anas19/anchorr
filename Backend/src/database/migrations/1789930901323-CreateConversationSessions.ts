import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateConversationSessions1789930901323 implements MigrationInterface {
    name = 'CreateConversationSessions1789930901323'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."conversation_sessions_status_enum" AS ENUM('open', 'escalated', 'claimed', 'resolved')`);
        await queryRunner.query(`CREATE TABLE "conversation_sessions" ("id" SERIAL NOT NULL, "workspace_id" integer NOT NULL, "session_id" character varying NOT NULL, "status" "public"."conversation_sessions_status_enum" NOT NULL DEFAULT 'open', "claimed_by_user_id" integer, "claimed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_1e7abe4a44b6931b3d70a6b2fc8" UNIQUE ("workspace_id", "session_id"), CONSTRAINT "PK_f5da074d9b5bf59ea03eaac4b48" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_abfbfb68573c6fdbee1d6f4dc4" ON "conversation_sessions" ("workspace_id") `);
        await queryRunner.query(`ALTER TABLE "conversation_sessions" ADD CONSTRAINT "FK_abfbfb68573c6fdbee1d6f4dc41" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "conversation_sessions" ADD CONSTRAINT "FK_de90010723620ed1a6d9942ff91" FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_sessions" DROP CONSTRAINT "FK_de90010723620ed1a6d9942ff91"`);
        await queryRunner.query(`ALTER TABLE "conversation_sessions" DROP CONSTRAINT "FK_abfbfb68573c6fdbee1d6f4dc41"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_abfbfb68573c6fdbee1d6f4dc4"`);
        await queryRunner.query(`DROP TABLE "conversation_sessions"`);
        await queryRunner.query(`DROP TYPE "public"."conversation_sessions_status_enum"`);
    }

}
