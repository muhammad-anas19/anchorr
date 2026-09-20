import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPublicKeyAndAllowedOriginsToWorkspaces1789920408222 implements MigrationInterface {
    name = 'AddPublicKeyAndAllowedOriginsToWorkspaces1789920408222'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspaces" ADD "public_key" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "workspaces" ADD CONSTRAINT "UQ_f87a064287769257daff99bbe4e" UNIQUE ("public_key")`);
        await queryRunner.query(`ALTER TABLE "workspaces" ADD "allowed_origins" text array NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN "allowed_origins"`);
        await queryRunner.query(`ALTER TABLE "workspaces" DROP CONSTRAINT "UQ_f87a064287769257daff99bbe4e"`);
        await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN "public_key"`);
    }

}
