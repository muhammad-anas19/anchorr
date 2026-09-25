import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReadyAtToDocuments1790051696913 implements MigrationInterface {
    name = 'AddReadyAtToDocuments1790051696913'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "documents" ADD "ready_at" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "ready_at"`);
    }

}
