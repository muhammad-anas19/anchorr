import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 15, increment 3: the allowance a workspace may consume in a period.
//
// This table is a GATE, not the bill. `used` is a fast counter checked and incremented before
// the answer pipeline runs; usage_events remains the source of truth, and `used` can always
// be recomputed from it (QuotaService.reconcile). The two can drift by design — a crash
// between reserving a unit and recording its event leaks one unit — and the drift only ever
// errs toward refusing slightly early, never toward an unbilled answer.
export class CreateWorkspaceQuotas1790790000000 implements MigrationInterface {
  name = 'CreateWorkspaceQuotas1790790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workspace_quotas" (
        "id" SERIAL PRIMARY KEY,
        "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
        "metric" varchar(32) NOT NULL CONSTRAINT "CHK_workspace_quotas_metric" CHECK (metric IN ('answer')),
        "allowance" integer NOT NULL CONSTRAINT "CHK_workspace_quotas_allowance" CHECK (allowance > 0),
        -- May reach allowance, never exceed it: the reserve statement only increments while
        -- used < allowance. The CHECK makes a bug elsewhere fail loudly instead of overspending.
        "used" integer NOT NULL DEFAULT 0,
        -- Half-open [period_start, period_end): an instant belongs to exactly one period.
        "period_start" timestamptz NOT NULL,
        "period_end" timestamptz NOT NULL,
        -- Where the allowance came from: 'trial' now; plan rows arrive in Phase 16.
        "source" varchar(32) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_workspace_quotas_used" CHECK (used >= 0 AND used <= allowance),
        CONSTRAINT "CHK_workspace_quotas_period" CHECK (period_end > period_start),
        CONSTRAINT "UQ_workspace_quotas_period" UNIQUE ("workspace_id", "metric", "period_start")
      )
    `);
    // "The current period for this workspace": workspace + metric, then a range on the period.
    await queryRunner.query(`
      CREATE INDEX "IDX_workspace_quotas_lookup" ON "workspace_quotas" ("workspace_id", "metric", "period_end")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "workspace_quotas"`);
  }
}
