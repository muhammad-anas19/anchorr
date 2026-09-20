import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionIdToConversations1789920910578 implements MigrationInterface {
    name = 'AddSessionIdToConversations1789920910578'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversations" ADD "session_id" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_285e84ab2537d6af999be71aa5" ON "conversations" ("session_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_285e84ab2537d6af999be71aa5"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "session_id"`);
    }

}
