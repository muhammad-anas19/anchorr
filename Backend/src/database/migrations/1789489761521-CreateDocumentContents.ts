import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDocumentContents1789489761521 implements MigrationInterface {
    name = 'CreateDocumentContents1789489761521'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "document_contents" ("id" SERIAL NOT NULL, "document_id" integer NOT NULL, "extracted_text" text NOT NULL, "page_count" integer, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_dfc809fb593cb08f0e97825a630" UNIQUE ("document_id"), CONSTRAINT "PK_df836cc733bff6e502c32f984fa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "document_contents" ADD CONSTRAINT "FK_dfc809fb593cb08f0e97825a630" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "document_contents" DROP CONSTRAINT "FK_dfc809fb593cb08f0e97825a630"`);
        await queryRunner.query(`DROP TABLE "document_contents"`);
    }

}
