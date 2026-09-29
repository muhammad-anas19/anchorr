import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written, for the same reason as every migration since Phase 10: migration:generate
// still tries to drop the Phase 8 HNSW index and recreate it as a plain btree.
export class AddKnowledgeVersionToWorkspaces1790564497556 implements MigrationInterface {
  name = 'AddKnowledgeVersionToWorkspaces1790564497556';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A counter, incremented whenever the set of chunks this workspace's retrieval can see
    // changes. It is part of every answer-cache key, so bumping it makes every previously
    // cached answer for the workspace unreachable in one statement — no scan, no delete.
    //
    // It lives here in Postgres rather than beside the cache entries in Redis on purpose.
    // Under memory pressure an LRU eviction policy can evict the COUNTER while keeping the
    // ENTRIES; the counter would then restart at 0, climb back to 12, and resurrect answers
    // cached against a knowledge base that has since changed. A durable counter cannot be
    // evicted out from under the entries it guards.
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "knowledge_version" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN "knowledge_version"`);
  }
}
