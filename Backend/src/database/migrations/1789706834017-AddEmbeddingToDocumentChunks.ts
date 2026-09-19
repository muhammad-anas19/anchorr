import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmbeddingToDocumentChunks1789706834017 implements MigrationInterface {
    name = 'AddEmbeddingToDocumentChunks1789706834017'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "document_chunks" ADD "embedding" vector(768)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "document_chunks" DROP COLUMN "embedding"`);
    }

}
