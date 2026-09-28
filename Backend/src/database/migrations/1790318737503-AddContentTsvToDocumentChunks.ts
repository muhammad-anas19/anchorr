import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written, like every migration since Phase 10: `migration:generate` still tries to drop
// the Phase 8 HNSW index and recreate it as a plain btree, because its differ does not
// understand `USING hnsw`. It also could not express a GENERATED column or a GIN index from
// entity decorators anyway.
export class AddContentTsvToDocumentChunks1790318737503 implements MigrationInterface {
  name = 'AddContentTsvToDocumentChunks1790318737503';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // GENERATED ALWAYS ... STORED, not a plain column the application fills in: Postgres
    // recomputes it on every INSERT and UPDATE of `content`, so it is structurally impossible
    // for the search index to drift out of sync with the text it indexes. The same reasoning
    // as computing `embedding` at write time — derived values belong to write time, because a
    // value computed during a query cannot be indexed at all.
    //
    // 'english' is written explicitly rather than relying on the server's
    // default_text_search_config, which is a runtime setting someone can change underneath
    // us. If the config used here ever differed from the one used at query time, the two
    // would silently stop matching — no error, just zero keyword results forever.
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      ADD COLUMN "content_tsv" tsvector
      GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED
    `);

    // GIN, not btree: a btree indexes one whole value per row in sorted order, which answers
    // "equals / greater than / in order". The question here is the inverse — "which rows
    // contain this lexeme" — which needs an inverted index mapping term -> rows.
    //
    // Not CONCURRENTLY: TypeORM runs migrations inside a transaction, and CREATE INDEX
    // CONCURRENTLY cannot run in one. It briefly locks writes to document_chunks, which is
    // correct at this project's scale. A table large enough for that lock to matter would
    // need this run outside the migration runner.
    await queryRunner.query(`
      CREATE INDEX "IDX_document_chunks_content_tsv"
      ON "document_chunks" USING GIN ("content_tsv")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_document_chunks_content_tsv"`);
    await queryRunner.query(`ALTER TABLE "document_chunks" DROP COLUMN "content_tsv"`);
  }
}
