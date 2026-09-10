import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWorkspaceUserMembership1788826859644 implements MigrationInterface {
  name = "CreateWorkspaceUserMembership1788826859644";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" SERIAL NOT NULL, "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."memberships_role_enum" AS ENUM('owner', 'agent', 'viewer')`,
    );
    await queryRunner.query(
      `CREATE TABLE "memberships" ("id" SERIAL NOT NULL, "workspace_id" integer NOT NULL, "user_id" integer NOT NULL, "role" "public"."memberships_role_enum" NOT NULL DEFAULT 'viewer', "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_b30e6ce2c364503f9840fa6440b" UNIQUE ("workspace_id", "user_id"), CONSTRAINT "PK_25d28bd932097a9e90495ede7b4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9b76ecf1dda18a6adec17fe71c" ON "memberships" ("workspace_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7c1e2fdfed4f6838e0c05ae505" ON "memberships" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "workspaces" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_098656ae401f3e1a4586f47fd8e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_9b76ecf1dda18a6adec17fe71c4" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_7c1e2fdfed4f6838e0c05ae5051" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "memberships" DROP CONSTRAINT "FK_7c1e2fdfed4f6838e0c05ae5051"`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" DROP CONSTRAINT "FK_9b76ecf1dda18a6adec17fe71c4"`,
    );
    await queryRunner.query(`DROP TABLE "workspaces"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7c1e2fdfed4f6838e0c05ae505"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9b76ecf1dda18a6adec17fe71c"`,
    );
    await queryRunner.query(`DROP TABLE "memberships"`);
    await queryRunner.query(`DROP TYPE "public"."memberships_role_enum"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
