import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDocuments1789319175816 implements MigrationInterface {
    name = 'CreateDocuments1789319175816'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."documents_status_enum" AS ENUM('uploaded', 'processing', 'ready', 'failed')`);
        await queryRunner.query(`CREATE TABLE "documents" ("id" SERIAL NOT NULL, "workspace_id" integer NOT NULL, "uploaded_by_user_id" integer, "original_filename" character varying NOT NULL, "storage_key" character varying NOT NULL, "mime_type" character varying NOT NULL, "file_size_bytes" integer NOT NULL, "content_hash" character(64) NOT NULL, "status" "public"."documents_status_enum" NOT NULL DEFAULT 'uploaded', "failure_reason" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_c0acf262e5848697810c8e9f732" UNIQUE ("storage_key"), CONSTRAINT "UQ_01015068a027e42212ba822c10b" UNIQUE ("workspace_id", "content_hash"), CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5a879c083b13ba9dbd0751d0e6" ON "documents" ("workspace_id") `);
        await queryRunner.query(`ALTER TABLE "documents" ADD CONSTRAINT "FK_5a879c083b13ba9dbd0751d0e6a" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "documents" ADD CONSTRAINT "FK_6f8986d1406171fccbd6bb2d864" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT "FK_6f8986d1406171fccbd6bb2d864"`);
        await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT "FK_5a879c083b13ba9dbd0751d0e6a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5a879c083b13ba9dbd0751d0e6"`);
        await queryRunner.query(`DROP TABLE "documents"`);
        await queryRunner.query(`DROP TYPE "public"."documents_status_enum"`);
    }

}
