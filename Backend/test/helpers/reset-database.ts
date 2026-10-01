import { config } from 'dotenv';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

// Tables that hold data owned by migrations, not by tests. Truncating them would erase the
// migration history or the RBAC seed that every request depends on.
const PRESERVED = new Set(['migrations', 'permissions', 'role_permissions']);

// Redis keys derived from a Postgres id. RESTART IDENTITY below hands those ids to the next
// test, but Redis keeps the keys, so the next test's workspace 1 would inherit the previous
// test's state. Currently only the /ask rate-limit bucket (`ask:{workspaceId}`). Everything
// else in Redis is keyed by something that is NOT reused — a workspace's random publicKey
// (widget buckets, answer cache), an email (login throttle) — and the answer-cache suite
// deliberately leaves its keys in place to prove exactly that.
const ID_KEYED_REDIS_PATTERNS = ['ask:*'];

let redis: Redis | null = null;
function testRedis(): Redis {
  if (!redis) {
    config();
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), lazyConnect: false });
  }
  return redis;
}

// Empties every other table in one statement, reading the current table list from Postgres —
// and clears the Redis state keyed by the ids it restarts.
//
// This replaces a TRUNCATE list copied by hand into ~20 test files. Every new table that
// referenced an existing one broke every file whose list didn't include it — "cannot truncate
// a table referenced in a foreign key constraint" — seven times across this project (Phases
// 2-6, 12, and the invitations table). A hand-maintained list of "all the tables" is a second
// copy of the schema that drifts; asking the database is the only copy that can't.
//
// The Redis half is the lesson from Phase 12 one layer down: a test that resets the database
// it can see and forgets the one it can't. Phase 15's per-workspace rate limit made it real —
// one suite's requests drained the next test's workspace-1 bucket, and quota tests saw 429s.
//
// RESTART IDENTITY resets ids to 1 so tests can refer to workspace 1, user 1 and so on.
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const rows: Array<{ tablename: string }> = await dataSource.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((row) => row.tablename).filter((name) => !PRESERVED.has(name));
  await dataSource.query(`TRUNCATE ${tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY`);

  const client = testRedis();
  for (const pattern of ID_KEYED_REDIS_PATTERNS) {
    const keys = await client.keys(pattern);
    if (keys.length) await client.del(...keys);
  }
}
