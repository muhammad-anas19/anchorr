import { MigrationInterface, QueryRunner } from 'typeorm';

// Values are written out here rather than imported from the Permission enum on purpose: a
// migration must replay identically forever, and an import would make this file's meaning
// change whenever the enum does.
const PERMISSIONS: Array<[string, string]> = [
  ['members.view', 'See who is in the workspace and their roles'],
  ['members.manage', 'Change member roles and remove members'],
  ['members.invite', 'Invite people to the workspace and manage pending invitations'],
  ['documents.view', 'See knowledge-base documents and their processing status'],
  ['documents.manage', 'Upload and delete knowledge-base documents'],
  ['knowledge.query', 'Ask questions against the knowledge base (playground, retrieval)'],
  ['handoff.view', 'See the escalation queue, conversation transcripts and agent presence'],
  ['handoff.work', 'Go online as an agent, claim, reply to and resolve conversations'],
  ['widget.view', 'See the widget public key and allowed origins'],
  ['widget.manage', 'Change the widget allowed origins'],
];

const ROLE_PERMISSIONS: Record<'owner' | 'agent' | 'viewer', string[]> = {
  owner: PERMISSIONS.map(([key]) => key),
  agent: ['members.view', 'documents.view', 'documents.manage', 'knowledge.query', 'handoff.view', 'handoff.work'],
  viewer: ['members.view', 'documents.view', 'knowledge.query'],
};

export class CreatePermissions1790740000000 implements MigrationInterface {
  name = 'CreatePermissions1790740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "key" varchar(64) PRIMARY KEY,
        "description" text NOT NULL
      )
    `);

    // Composite primary key: a role holds a given permission at most once, and the PK index
    // (role first) is exactly what "load every permission for this role" scans.
    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "role" "memberships_role_enum" NOT NULL,
        "permission_key" varchar(64) NOT NULL
          REFERENCES "permissions"("key") ON DELETE CASCADE,
        PRIMARY KEY ("role", "permission_key")
      )
    `);

    for (const [key, description] of PERMISSIONS) {
      await queryRunner.query(`INSERT INTO "permissions" ("key", "description") VALUES ($1, $2)`, [key, description]);
    }
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        await queryRunner.query(`INSERT INTO "role_permissions" ("role", "permission_key") VALUES ($1, $2)`, [
          role,
          key,
        ]);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "role_permissions"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
  }
}
