import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written: migration:generate still tries to drop the Phase 8 HNSW index, and could not
// express this migration's own HNSW index from decorators anyway.
//
// Everything here serves the shadow semantic tier: on a cache miss, find the nearest
// previously-answered question and RECORD it — distance and which conversation — without ever
// serving it. Measured before building: genuine paraphrases sit 0.19-0.26 apart while a
// negation pair with opposite answers sits 0.053 apart, so no threshold is safe to serve on.
// These columns gather the real data needed to know whether that is true of real traffic.
export class AddShadowCacheColumnsToConversations1790571949151 implements MigrationInterface {
  name = 'AddShadowCacheColumnsToConversations1790571949151';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The question's own embedding — already computed for retrieval on every miss, so storing
    // it costs a write, not an API call. NULL on a cache hit, which embeds nothing.
    await queryRunner.query(`ALTER TABLE "conversations" ADD "question_embedding" vector(768)`);

    // The knowledge base and prompt the answer was generated under. A prior answer is only a
    // legitimate candidate if a real cache could have served it, and a real cache keys on both —
    // an answer grounded in last week's documents, or produced by last week's prompt, is not.
    await queryRunner.query(`ALTER TABLE "conversations" ADD "knowledge_version" integer`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD "prompt_version" integer`);

    // How this turn related to the cache: hit / miss / bypass. Also the cheapest possible
    // source for hit-rate reporting later — it is already on every conversation row.
    await queryRunner.query(`ALTER TABLE "conversations" ADD "cache_outcome" varchar(8)`);

    // The shadow result itself: the nearest ELIGIBLE earlier conversation, and how far away it
    // was. Self-referencing; SET NULL so deleting an old conversation never deletes a newer one.
    await queryRunner.query(`ALTER TABLE "conversations" ADD "nearest_prior_conversation_id" integer`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD "nearest_prior_distance" double precision`);
    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_nearest_prior"
      FOREIGN KEY ("nearest_prior_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL
    `);

    // Same index type and operator class as document_chunks.embedding (Phase 8), matching the
    // <=> cosine-distance operator the lookup uses.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_question_embedding_hnsw"
      ON "conversations" USING hnsw ("question_embedding" vector_cosine_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_conversations_question_embedding_hnsw"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_nearest_prior"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "nearest_prior_distance"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "nearest_prior_conversation_id"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "cache_outcome"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "prompt_version"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "knowledge_version"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "question_embedding"`);
  }
}
