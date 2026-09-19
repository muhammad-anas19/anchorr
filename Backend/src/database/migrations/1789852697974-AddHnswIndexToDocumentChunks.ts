import { MigrationInterface, QueryRunner } from "typeorm";

// Written by hand: TypeORM's @Index() decorator only generates plain B-tree indexes, with
// no way to express "USING hnsw" + an operator class through the entity/decorator system —
// migration:generate correctly found nothing to diff, since nothing in the entity describes
// this. vector_cosine_ops specifically matches the `<=>` cosine-distance operator this
// project's retrieval queries use — an index built with a different operator class (e.g. for
// L2 distance) would not be usable by a query ordering on `<=>`.
export class AddHnswIndexToDocumentChunks1789852697974 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE INDEX "IDX_document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw (embedding vector_cosine_ops)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_document_chunks_embedding_hnsw"`);
    }

}
