import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDocumentChunks1789627295889 implements MigrationInterface {
    name = 'CreateDocumentChunks1789627295889'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "document_chunks" ("id" SERIAL NOT NULL, "document_id" integer NOT NULL, "chunk_index" integer NOT NULL, "content" text NOT NULL, "char_start" integer NOT NULL, "char_end" integer NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_2a33856c811764d7ed06a05b633" UNIQUE ("document_id", "chunk_index"), CONSTRAINT "PK_7f9060084e9b872dbb567193978" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b371ff8bc1e4f65fc3d01420be" ON "document_chunks" ("document_id") `);
        await queryRunner.query(`ALTER TABLE "document_chunks" ADD CONSTRAINT "FK_b371ff8bc1e4f65fc3d01420be5" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "document_chunks" DROP CONSTRAINT "FK_b371ff8bc1e4f65fc3d01420be5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b371ff8bc1e4f65fc3d01420be"`);
        await queryRunner.query(`DROP TABLE "document_chunks"`);
    }

}
