import { DataSource } from 'typeorm';

// Tables that hold data owned by migrations, not by tests. Truncating them would erase the
// migration history or the RBAC seed that every request depends on.
const PRESERVED = new Set(['migrations', 'permissions', 'role_permissions']);

// Empties every other table in one statement, reading the current table list from Postgres.
//
// This replaces a TRUNCATE list copied by hand into ~20 test files. Every new table that
// referenced an existing one broke every file whose list didn't include it — "cannot truncate
// a table referenced in a foreign key constraint" — seven times across this project (Phases
// 2-6, 12, and the invitations table). A hand-maintained list of "all the tables" is a second
// copy of the schema that drifts; asking the database is the only copy that can't.
//
// RESTART IDENTITY resets ids to 1 so tests can refer to workspace 1, user 1 and so on.
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const rows: Array<{ tablename: string }> = await dataSource.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((row) => row.tablename).filter((name) => !PRESERVED.has(name));
  await dataSource.query(`TRUNCATE ${tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY`);
}
