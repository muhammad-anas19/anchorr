# Phase 1 — Multi-Tenant Schema Foundation

## Objective

Stand up the repo structure and the core tenancy model every later phase builds on: `Workspace`, `User`, `Membership`, with a row-level multi-tenancy pattern (`workspace_id` on every tenant-scoped table).

**Repo structure note:** the plan below was originally a pnpm monorepo (`apps/api`/`web`/`widget` sharing a `packages/shared-types`). That was reversed mid-phase — see "Architecture & decisions (as built)" for what actually shipped and why.

## Why the system needs this

Anchor is multi-tenant from day one — every document, conversation, and analytic belongs to exactly one workspace, and no query anywhere in the system is allowed to accidentally cross that boundary. Getting the tenancy model and enforcement pattern right before any real feature exists means every phase after this one inherits safe defaults instead of having to retrofit scoping into code that already leaks.

---

## The diagnostic

10 questions asked up front, answered in one batch, scored honestly (not corrected in the moment).

### Q1 — Monorepo rationale
**Asked:** We're using a monorepo — one repo holding `api`, `web`, and `widget` side by side, instead of three separate repos. What's the actual benefit of that at this stage, and what would be a sign you should've used separate repos instead?

**Your answer:** "so basically they all are different and their purpose is different i am current keeping them same because it is convenient to view changes in them at one window"

**Score: SHAKY**

**Correct answer:** The real benefit is shared code, not viewing convenience. `api`, `web`, and `widget` will share TypeScript types (`Document`, `Conversation`, API response shapes). In separate repos, sharing that means publishing a private npm package and bumping versions in three places every time a type changes. In a monorepo, `web` imports directly from a `packages/shared-types` folder next door — the change is visible instantly, no publish step (see Q2). The sign you'd want separate repos instead: different teams owning each app with different access control, or wildly different release cadences (e.g. the widget shipping daily while the dashboard ships weekly) where one repo's CI becomes a bottleneck for the other.

### Q2 — Workspace package linking
**Asked:** With npm/pnpm workspaces, how does a package in one workspace get access to code from another workspace in the same repo? If you edit that shared code, do the other packages see the change immediately, or is there a build/publish step in between?

**Your answer:** "we download the package using npm i packagename and than import in file where we want to use it, and downloading it means downloading its code on our machine."

**Score: UNKNOWN**

**Correct answer:** That describes installing an *external* package from the npm registry — unrelated to what workspaces do. Workspaces solve a different problem: code that lives inside your own repo, in a sibling folder, that you want to `import` without publishing it anywhere. When `apps/*`/`packages/*` are declared as workspaces in the root `package.json`, the package manager doesn't copy the sibling package into `node_modules` — it creates a **symlink**. `apps/web/node_modules/@anchor/shared-types` literally points at `packages/shared-types`. Edit a file there, and `web` sees the new content on its very next import — no rebuild, no republish, no version bump, because it was never "installed," just linked.

### Q3 — Multi-tenancy pattern
**Asked:** We're storing every tenant (workspace)'s data in the same Postgres database and the same tables, distinguished by a `workspace_id` column. What's the alternative to this (schema-per-tenant or database-per-tenant), and what's the actual tradeoff — why wouldn't you always pick maximum isolation?

**Your answer:** "we are going with schema per tenant because if we do db per tenant if we create any migration we have to run them for multiple dbs, and in current approach we just have to make sure we write perfect queries to make sure no unauthorized user can access any workspace"

**Score: SHAKY**

**Correct answer:** There are three distinct models, and the answer mixes their names up:
- **Database-per-tenant**: each workspace gets its own Postgres database. Maximum isolation, but a migration must run once per tenant database, and any cross-tenant query (e.g. Anchor's own ops dashboard) means querying N databases and merging results.
- **Schema-per-tenant**: one database, each workspace gets its own Postgres *schema* (namespace) — `tenant_abc123.documents` vs `tenant_xyz789.documents`. Better than database-per-tenant for connection management, but you still run migrations once per schema.
- **Row-level (shared schema, shared tables)**: one database, one `documents` table, every row carries a `workspace_id` column. One migration ever, updates every tenant at once. The cost: every query must remember to filter by `workspace_id`, or it leaks data across tenants.

What you described — "write perfect queries so no unauthorized user can access any workspace" — **is the row-level model**, not schema-per-tenant. That's what Anchor actually uses. The real tradeoff isn't "which is safest" in the abstract — it's operational simplicity (one schema, one migration path) traded against needing airtight enforcement in application code (Q4).

### Q4 — Preventing cross-tenant data leaks
**Asked:** Suppose a developer writes a query that lists documents but forgets to filter by `workspace_id`. What actually happens as a result, and what are the ways a codebase can prevent that class of bug from ever shipping?

**Your answer:** "if a developer make this mistake than we can make our logic of code something like returning default doc if there is no workspace d present in req"

**Score: UNKNOWN**

**Correct answer:** The failure mode isn't a missing input — it's a query like `documentsRepository.find({ where: { status: 'ready' } })` with no `workspace_id` filter at all. That query doesn't error and doesn't return nothing — it returns **every ready document from every workspace in the database**. Northwind Devices' customer sees Acme Corp's documents. That's a real data breach, and "return a default doc" doesn't apply because nothing was missing from the request — the code itself never asked the database to filter.

The fix is making the unsafe path harder to reach than the safe one:
- A **request-scoped `TenantContextService`**: once a request is authenticated (Phase 2), a guard extracts `workspace_id` from the JWT/session onto a per-request provider.
- A **base repository / query helper** every entity service uses instead of the raw TypeORM repository, which automatically merges `{ workspace: { id: ctx.workspaceId } }` into any `where` clause. A developer has to deliberately bypass this helper to write the unsafe query.
- Optionally later: **Postgres Row-Level Security (RLS)** — a database-level policy filtering rows by a session variable, protecting even a raw SQL query with zero app-level filtering. Real complexity cost (must `SET` a session variable per request, awkward with connection pooling) — treat as a later hardening step, not a Phase 1 requirement.

### Q5 — `synchronize` vs migrations
**Asked:** In TypeORM, what's the difference between letting `synchronize: true` sync your schema automatically vs. writing migrations? Why does one become dangerous as soon as you have real data?

**Your answer:** "dont know"

**Score: UNKNOWN**

**Correct answer:** `synchronize: true` means: on every app startup, TypeORM diffs your `@Entity()` classes against the live database schema and auto-applies whatever `ALTER TABLE` statements make the database match the code. Convenient with an empty database — no migration files, change an entity, restart, done.

It becomes dangerous once real data exists because the diffing isn't safe by construction. Rename a column in your entity, and TypeORM doesn't know you renamed it — it sees "old column gone, new column appeared" and does `DROP COLUMN old_name` + `ADD COLUMN new_name`, silently deleting every value that was in that column. Migrations are the alternative because a migration file is something *you* wrote and reviewed — `ALTER TABLE documents RENAME COLUMN old_name TO new_name` says explicitly what happens, and it lives in git as a permanent, ordered, reviewable history of every schema change the database has ever gone through.

### Q6 — FK / cascade behavior
**Asked:** When you define a `@ManyToOne` relation in TypeORM (e.g., a Document belongs to a Workspace), what actually gets created in the database, and what happens if you try to delete a Workspace that still has Documents?

**Your answer:** "so in document table we keep workspace id column as FK that points to the id of workspace that doc belongs to, and we do restrict property any db operation fails if we delete it withour deleteing document and on cascade db dont ie any error it silently deletes all the workspace related data too."

**Score: SOLID** — correctly separated RESTRICT (delete fails, protects data) from CASCADE (delete silently propagates to child rows). No gap to teach here; this is the mechanism as-is.

### Q7 — Index tradeoff
**Asked:** Why would you put an index on the `workspace_id` column of every tenant-scoped table? What query pattern does that index actually speed up, and what does adding it cost you?

**Your answer:** "index make read fast and writes sow"

**Score: SHAKY**

**Correct answer:** Right shape, missing the mechanism. Without an index, `WHERE workspace_id = 'abc'` forces Postgres into a **sequential scan** — read every row in the table, check if it matches, discard if not. On a `documents` table with a million rows across all tenants, that's a million row-reads to find one workspace's twelve documents. An index on `workspace_id` is a separate sorted structure (a B-tree) letting Postgres jump straight to matching rows — exactly the query pattern *every* tenant-scoped query in Anchor runs, since every query filters by workspace. The write cost: every `INSERT`/`UPDATE`/`DELETE` on that table also updates the index's B-tree, not just the table row — more work per write, but for Anchor's read-heavy dashboard/widget traffic, clearly worth it.

### Q8 — UUID vs auto-increment
**Asked:** We'll use UUIDs as primary keys instead of auto-incrementing integers. What's the real reason to prefer UUIDs in a multi-tenant SaaS system, and what do you give up by using them?

**Your answer:** "uuid cost us more storage becase they are large digit number, but i am thinking to go with auto incremental ids in this project"

**Score: SHAKY**

**Correct answer:** The storage-cost point is real (a UUID is 16 bytes vs 4-8 for an int) but that's the minor half of the tradeoff. The actual reason SaaS systems default to UUIDs is **enumerability**: if `Workspace.id` is a sequential integer, workspace `#4471` existing tells an attacker `#4470` and `#4472` probably exist too — they can iterate through every ID in the system. This matters for Anchor specifically because workspace/document IDs will eventually appear in URLs the widget calls — a public-ish surface.

**Decision made (see project decisions log):** the project is going with **auto-increment integers** anyway, consciously accepting the enumeration tradeoff now. **Debt to repay later:** Phase 11 (public widget) needs a mitigation for any ID exposed in a widget-facing/customer-facing API call — e.g. a separate random public token/slug — rather than exposing the raw integer PK externally.

### Q9 — NestJS DI purpose
**Asked:** NestJS organizes code into Modules, each with Providers (services) and Controllers, wired together by dependency injection. What problem does that structure solve that you wouldn't get if you just imported classes directly and `new`'d them up wherever you needed them?

**Your answer:** "it makes our code scalable and make it easy to test seperate services using dependency injection"

**Score: SHAKY**

**Correct answer:** "Testable" is the correct core answer, just worth being precise about why. If `DocumentsService` does `new EmbeddingProvider()` directly inside itself, testing `DocumentsService` always calls the real Gemini API (slow, costs money, needs network). With DI, `DocumentsService` just declares "give me something that implements `EmbeddingProvider`" and Nest's container decides what concrete instance to hand it — in a test, a fake one returning a canned vector instantly. "Scalable" isn't quite the right word for what DI buys — the precise term is **decoupling**: `DocumentsService` never needs to know which embedding provider it's using, so swapping Gemini for something else later (the whole point of Phase 9's provider interface) means changing one line of module wiring, not hunting through every file that did `new GeminiClient()`.

### Q10 — pgvector extension + migrations
**Asked:** Postgres extensions like `pgvector` get enabled with `CREATE EXTENSION`. Where should that statement live in a project that uses migrations, and what happens if two developers each try to run their own migrations that both do this?

**Your answer:** "i dont know anything"

**Score: UNKNOWN**

**Correct answer:** `CREATE EXTENSION IF NOT EXISTS vector;` is itself SQL, so it lives inside a normal migration file — typically the very first one, since every later migration adding a `vector` column depends on the extension already existing. TypeORM tracks which migrations have run in a `migrations` table in the database itself (one row per migration file, recorded the moment it successfully runs). If two developers each write a migration containing that statement: whoever runs theirs first succeeds and is recorded. The `IF NOT EXISTS` clause is what saves the second developer — without it, their migration fails with "extension already exists" the moment they run it; with it, the statement quietly no-ops and their migration succeeds too. This is why extension-creation is always written as idempotent SQL — not because two people run migrations *simultaneously*, but because migrations get replayed independently across environments (local, CI, staging, production), and each one needs to survive "this might already be true."

---

## Topics you must know before moving on

Ranked by how load-bearing they are for everything downstream:

1. **The three multi-tenancy models and which one Anchor uses** (Q3) — row-level, shared schema/tables, `workspace_id` on every row. Everything from Phase 2's auth guard onward assumes you have this straight.
2. **Why tenant-scoping has to be structural, not remembered** (Q4) — the actual failure mode is a silent cross-tenant data leak, not an error. This is the single most important idea in this phase.
3. **`synchronize` vs migrations, and why `synchronize` is a data-loss risk** (Q5) — this project never uses `synchronize: true` past initial scaffolding; you need to know why, not just the rule.
4. **How workspace/monorepo symlinking actually works** (Q2) — distinguishes "installed from registry" from "linked from a sibling folder." *Note: the project reversed the monorepo decision mid-phase (see below) — no `packages/shared-types` exists — but the concept itself is still worth knowing for the next time a monorepo is the right call.*
5. **Index mechanics: sequential scan vs B-tree** (Q7) — not just "index = fast," but *why*, so you can reason about which columns deserve one later without being told.
6. **The UUID-vs-int enumerability tradeoff, and that this project took on that debt deliberately** (Q8) — remember this is coming due again at Phase 11.
7. **What NestJS DI is actually decoupling** (Q9) — testability is a symptom; the mechanism is not hard-coding concrete dependencies.
8. **Idempotent migrations, and why** (Q10) — replay-safety across environments, not concurrency.

---

## Architecture & decisions (as built)

### Repo structure — reversed mid-phase

The original design was a pnpm monorepo (`apps/api`, `apps/web`, `apps/widget`, `packages/shared-types`). Partway through scaffolding, the user explicitly reversed this: **no shared package, no workspace linking, three fully independent top-level folders** — `Backend/`, `Frontend/`, `Widget/` — each with its own `package.json` and its own `node_modules`, installed separately. If a type needs to exist in more than one folder later, it gets duplicated or manually kept in sync, not shared via a linked package. This is logged in the project decisions memory as a deliberate, explicit choice — not an oversight.

```
anchor/
├── Backend/           NestJS — entities, migrations, TypeORM config (this phase)
├── Frontend/           empty placeholder (Next.js, Phase 2+)
├── Widget/             empty placeholder (vanilla TS, Phase 11+)
├── docker-compose.yml   Redis only, dev-only (Postgres is native — see "Package manager & Postgres hosting" below)
└── docs/phases/         this file and its siblings
```

### Schema

```
Workspace                     Membership                    User
┌─────────────────┐  1     * ┌────────────────────┐  * 1  ┌──────────────────┐
│ id (int, PK)     │◄─────────│ id (int, PK)       │──────►│ id (int, PK)     │
│ name             │  CASCADE │ workspace_id (FK)  │ CASCADE│ email (unique)   │
│ created_at       │          │ user_id (FK)        │       │ password_hash    │
└─────────────────┘          │ role (enum)         │       │ created_at       │
                              │ created_at          │       └──────────────────┘
                              │ UNIQUE(workspace_id, user_id) │
                              │ INDEX(workspace_id), INDEX(user_id) │
                              └────────────────────┘
```

- **Primary keys: auto-increment integers**, not UUIDs — a deliberate decision (see Q8 and the project decisions log) accepting the enumeration tradeoff for now, with a known debt to repay at Phase 11 (public widget) once IDs cross into customer-facing territory.
- **Membership is a real entity**, not a bare `@ManyToMany`, because it carries an attribute (`role`) a plain join table can't hold — same relation mechanism as Q6, applied to a three-entity join.
- **`ON DELETE CASCADE`** on both FKs in `Membership`: deleting a `Workspace` or a `User` removes their membership rows. This was a deliberate choice — `Membership` is a pure association record with no independent meaning once either side is gone, unlike (say) a future `Document`, which will likely use `RESTRICT` or a soft-delete instead once it holds real content.
- **Indexes on both FK columns** (`workspace_id`, `user_id`) — Postgres does not auto-index foreign key columns (unlike the primary key), so these were added explicitly, per the Q7 mechanism.
- **`UNIQUE(workspace_id, user_id)`** — a user can only have one membership row per workspace.
- **Enforcement of tenant-scoping itself (the Q4 guard/base-repository pattern) is deliberately NOT built yet** — there's no authenticated request to extract a `workspace_id` from until Phase 2. This phase only lays the groundwork the guard will sit on top of.

### Database & migrations

- **TypeORM, `synchronize: false` from the first commit.** One migration: `CreateWorkspaceUserMembership`, generated via `typeorm migration:generate`, diffing the three entity classes against the (empty) database. **An `EnablePgvectorExtension` migration existed briefly and was removed** — see "pgvector: enabled, then deferred" below for why.
- **Local dev database**: originally Postgres 16 via the `pgvector/pgvector:pg16` Docker image; switched to a **native Postgres 18 instance managed through pgAdmin** instead (the user's own call — see "Package manager & Postgres hosting" below). Redis stays in `docker-compose.yml`, on host port `6380` (not the default `6379`) — see "Failure cases" for why.

### Package manager & Postgres hosting — changed after this phase's build

Two infrastructure choices made during the build were reversed once the user reviewed them, and both are worth understanding rather than just accepting:

**pnpm → npm.** The build originally used `pnpm` (a package manager that saves disk space via a shared content-addressable store, and is stricter than `npm`/`yarn` about not letting a package accidentally `import` a dependency it never declared — see Q2's teaching on symlinked workspace packages, which was pnpm-specific reasoning). The user was unfamiliar with pnpm and asked to switch to plain `npm` — the package manager that ships with Node itself, using the far more common `package-lock.json` instead of `pnpm-lock.yaml`. Practically, nothing about the entities, migrations, or app code changes — only the lockfile format and the `install`/`run` commands (`npm install`, `npm run migration:run` instead of `pnpm install`, `pnpm migration:run`). One thing to note: pnpm's strict linking would have caught it immediately if `dotenv` were used without being declared as a direct dependency (a "phantom dependency" bug); npm's flatter `node_modules` layout often lets that kind of bug work by accident, then break later when a sibling package's own dependencies change. `dotenv` stays an explicit dependency here regardless of package manager — that's just good practice, not something to undo now that pnpm is gone.

**Dockerized Postgres → native Postgres via pgAdmin.** The user already runs Postgres natively on this machine (in fact, this is the same native instance that caused the port-5432 collision documented in "Failure cases" below) and manages it with pgAdmin, so they asked to drop the Dockerized Postgres entirely rather than run two Postgres installs side by side.

### pgvector: enabled, then deferred

Once `Backend/.env` had real credentials for the native Postgres 18 instance, the `anchor` database itself didn't exist yet (created directly via a one-off `pg` client script issuing `CREATE DATABASE anchor;` against the default `postgres` maintenance database, using the native superuser). Running migrations against it then failed exactly where the earlier "open question" predicted: `error: extension "vector" is not available`, with Postgres's own hint spelling out why — *"The extension must first be installed on the system where PostgreSQL is running."* Enabling an extension via SQL and having its files physically present on disk are two different things (this is precisely what Q10 distinguishes) — the Docker image used earlier shipped pgvector pre-built; this native Windows Postgres 18 install does not.

Installing it for real means Visual Studio Build Tools (C++ workload) plus compiling pgvector from source via `nmake`, matched to this exact Postgres version — a genuine toolchain install, not a quick fix. Given Phase 1's tables have zero vector columns (nothing needs it before Phase 7, embeddings), the decision was to **defer**: the `EnablePgvectorExtension` migration file was deleted (it had rolled back cleanly — TypeORM wraps each migration in a transaction, so failure left no partial state and no row in the `migrations` tracking table, as if it had never run), and `migration:run` was retried with just `CreateWorkspaceUserMembership` — which succeeded. **This is a decision to revisit at Phase 7**, not a problem that's been solved; the same three options (install the toolchain, switch back to Docker just for Postgres, or find another path) are still on the table then.

---

## Data flow: entity change → running schema

1. A developer edits/adds a `@Entity()` class (e.g., adds a column to `Membership`).
2. `npm run migration:generate src/database/migrations/<Name>` connects to the dev database using `src/database/data-source.ts`, compares the live schema against what the entity classes now say it should be, and writes a migration file with explicit `up`/`down` SQL — nothing is applied yet, this step only writes a file.
3. A developer reviews the generated SQL (this is the whole point of migrations over `synchronize` — see Q5) and runs `npm run migration:run`.
4. TypeORM checks the `migrations` table (auto-created on first run) for which migration `name`s have already executed, runs only the new ones inside a transaction, and records each one by inserting a row into `migrations` the moment it succeeds.
5. At app boot, `TypeOrmModule.forRootAsync` in `app.module.ts` opens a connection pool using the same entity classes, with `synchronize: false` — it never touches schema, only reads/writes rows.

Two separate TypeORM configs exist on purpose: `data-source.ts` (a plain `DataSource`, used only by the CLI for migrations) and the `TypeOrmModule.forRootAsync(...)` config inside `app.module.ts` (used by the running Nest app, wired through `ConfigService` so it reads the same `.env` values through Nest's config system rather than duplicating `process.env` access).

---

## Migrations: what each table and column actually stores

*(An `EnablePgvectorExtension` migration existed briefly — `CREATE EXTENSION IF NOT EXISTS vector;`, no tables — but it failed against the native Postgres install (extension not physically installed) and was deleted rather than left in a broken state. See "pgvector: enabled, then deferred" above. It'll be recreated in Phase 7.)*

### `1788826859644-CreateWorkspaceUserMembership`

**`workspaces`** — one row per tenant (a company using Anchor, e.g. "Northwind Devices"). Every other tenant-scoped table in the system will eventually point back to a row here via `workspace_id`.

| Column | Type | Stores |
|---|---|---|
| `id` | integer, PK, auto-increment | The workspace's unique identifier. Every tenant-scoped table's `workspace_id` FK points here. |
| `name` | varchar | Display name shown in the dashboard (e.g. "Northwind Devices"). |
| `created_at` | timestamp | When the workspace was created. Defaults to `now()` at insert time. |

**`users`** — one row per person who can log into Anchor's own dashboard. **Not** the same as a customer chatting with the widget — those aren't modeled at all yet (that arrives around Phase 11).

| Column | Type | Stores |
|---|---|---|
| `id` | integer, PK, auto-increment | The user's unique identifier. |
| `email` | varchar, unique | Login identifier. Uniqueness is enforced at the database level, not just app-side validation. |
| `password_hash` | varchar | A hashed password (never the raw password) — the actual hashing logic doesn't exist until Phase 2; this column just reserves the shape now. |
| `created_at` | timestamp | Account creation time. |

**`memberships`** — the join between a workspace and a user, recording *who belongs to which workspace and what they're allowed to do there*. This table is what makes multi-tenancy real: a user's access to any workspace's data flows entirely through whether a membership row exists for that pair.

| Column | Type | Stores |
|---|---|---|
| `id` | integer, PK, auto-increment | The membership row's own identifier (not a compound key on `workspace_id`+`user_id`, even though those two together are unique — see below). |
| `workspace_id` | integer, FK → `workspaces.id` | Which workspace this membership grants access to. Indexed (Q7) and `ON DELETE CASCADE` (Q6) — deleting a workspace deletes every membership that pointed at it. |
| `user_id` | integer, FK → `users.id` | Which user this membership belongs to. Indexed and `ON DELETE CASCADE` — deleting a user deletes every membership they held. |
| `role` | enum (`owner` \| `agent` \| `viewer`), default `viewer` | What the user is allowed to do in that specific workspace. A real Postgres `ENUM` type (`memberships_role_enum`), not a free-text column — the database itself rejects any other value. Defaults to the least-privileged role. |
| `created_at` | timestamp | When the membership was granted. |

Table-level constraint: `UNIQUE(workspace_id, user_id)` — a given user can have at most one membership row per workspace (can't simultaneously be recorded as both "owner" and "viewer" of the same workspace).

---

## Code walkthrough

**`src/database/entities/membership-role.enum.ts`** — the three roles (`owner`, `agent`, `viewer`) as a plain TypeScript enum, reused by the `@Column({ type: 'enum', enum: MembershipRole })` on `Membership.role`. TypeORM turns this into a real Postgres `ENUM` type (`memberships_role_enum`), not just a `varchar` with app-side validation — the database itself rejects any other string.

**`src/database/entities/workspace.entity.ts`** / **`user.entity.ts`** — straightforward: auto-increment `id`, a couple of columns, a `createdAt` via `@CreateDateColumn`, and a `@OneToMany` back-reference to `Membership` (the inverse side of the relation, used for eager-loading a workspace's members later — it declares no column of its own).

**`src/database/entities/membership.entity.ts`** — the one with real design decisions in it:
- `workspaceId`/`userId` are declared *twice* in a sense: once as a plain `@Column({ name: 'workspace_id' })` (for reading/writing the raw FK integer without loading the related entity) and once as the relation itself (`@ManyToOne` + `@JoinColumn({ name: 'workspace_id' })`). Both point at the same physical column — TypeORM recognizes this by the matching `name`. This lets code do `membership.workspaceId` (cheap, no join) or `membership.workspace.name` (triggers a join/second query) depending on what's actually needed.
- `@Index()` sits on the plain `@Column`, not the relation — this is what produces the `CREATE INDEX ... ON memberships (workspace_id)` from Q7.
- `{ onDelete: 'CASCADE' }` on both `@ManyToOne`s is what produces `ON DELETE CASCADE` in the generated migration — this is Q6's mechanism, chosen deliberately here (see "Architecture & decisions" above for why).
- `@Unique(['workspaceId', 'userId'])` at the class level (not per-column) because it's a *composite* uniqueness rule spanning two columns.

**`src/database/data-source.ts`** — the CLI-only `DataSource`. Calls `dotenv`'s `config()` explicitly and imports `dotenv` as a direct dependency, rather than relying on it being a transitive dependency of `@nestjs/config` — a "phantom dependency" that happens to work today but isn't guaranteed to keep working if `@nestjs/config`'s own dependencies ever change. This mattered enough to catch immediately under pnpm's strict linking (which was in use when this file was written); it's kept explicit under npm too, since it's correct regardless of package manager.

**`src/app.module.ts`** — wires `ConfigModule.forRoot({ isGlobal: true })` so `.env` values are available anywhere via `ConfigService`, and `TypeOrmModule.forRootAsync` reads those same values to build the runtime connection — this is the "Nest-integrated" half of the dual-config split described in Data Flow above.

**`src/database/migrations/1788826859644-CreateWorkspaceUserMembership.ts`** — generated, not hand-written. Worth reading once anyway: it's the SQL translation of everything decided in the entities — `CREATE TYPE ... AS ENUM`, the two `CREATE INDEX` statements, the composite `UNIQUE` constraint, and the two `ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE CASCADE` statements, all inside one migration.

**`src/database/schema.integration.spec.ts`** — see "Tests" below.

---

## Failure cases (tested for real, not hypothetical)

1. **Duplicate membership.** Inserting a second `(workspace_id, user_id)` pair was tried on purpose (both via raw `psql` and via the Jest test). Postgres rejected it: `duplicate key value violates unique constraint`. Confirms the `UNIQUE` constraint is real, not just documented intent.
2. **Cascade delete.** Deleted a `Workspace` row that still had a `Membership` pointing at it. The membership row disappeared silently along with it — no error, no orphaned row. This is exactly the CASCADE behavior from Q6, observed rather than assumed.
3. **Port collision with an unrelated native Postgres service.** (This happened while the project was still using Dockerized Postgres and pnpm — both have since changed, but the failure itself is worth keeping as a real example.) While testing the migration, `migration:run` failed with `password authentication failed for user "anchor"` — even after resetting the password directly in the container and confirming it worked from *inside* the container. The real cause: this dev machine has a **native Windows Postgres service** also listening on port 5432 (IPv4), separate from Docker's port-forward (which had only bound the IPv6 side). Node's `pg` driver resolving `localhost` hit the native instance — a completely different database with different credentials — not the Docker one. Fixed by moving the Docker container to host port `5433` (and Redis, which hit an equivalent collision with an unrelated project's `ticketrush-redis` container on 6379, to `6380`). **Lesson:** "connection refused" and "wrong password" can both mean "you're talking to the wrong server entirely," not just "bad config" — worth checking `Get-NetTCPConnection -LocalPort <port>` before assuming the container itself is misconfigured. **Directly relevant now:** that native Postgres service is exactly what the project switched *to* as its primary database (see "Package manager & Postgres hosting" above) — so its actual credentials (whatever pgAdmin is configured with) are what `Backend/.env` needs now, not the Docker ones this section describes.
4. **Environment file-persistence flakiness.** Several files (`docker-compose.yml`, and everything inside `apps/api` except subdirectories) vanished after being written or moved, with no error reported at the time. Recovered by recreating them and verifying with `find <dir> -type f` immediately after every write/move from then on. Documented in the project decisions memory so future sessions in this environment don't lose time rediscovering it.
5. **Target database doesn't exist yet.** After pointing `Backend/.env` at the native Postgres, the very first `migration:run` failed with `database "anchor" does not exist` — a different error from bad credentials (`3D000` vs `28P01`), and a reminder that "switch the connection string" isn't complete until the target database itself has actually been created. Fixed with a one-off `CREATE DATABASE anchor;` run via a plain `pg` client script against the native superuser's default `postgres` database.
6. **pgvector not installed on the native instance.** See "pgvector: enabled, then deferred" above — `CREATE EXTENSION` failed with `extension "vector" is not available`, and the migration rolled back cleanly (TypeORM runs each migration in a transaction). Confirms enabling ≠ having installed, and that a failed migration here is safe to just delete and retry, not something requiring manual cleanup.

---

## Tests and why each exists

`src/database/schema.integration.spec.ts` — an integration test (real Postgres connection via the same `AppDataSource` used by the CLI, not a mock) with two cases:
- **Duplicate membership is rejected** — proves the `UNIQUE(workspace_id, user_id)` constraint through the actual TypeORM repository API, the same path application code will use, not just raw SQL.
- **Deleting a workspace cascades to its memberships** — proves the `ON DELETE CASCADE` behavior the same way.

Why an integration test rather than a unit test: there is no business logic yet to unit-test in isolation — the entire point of this phase is database-enforced constraints, so the test has to actually hit the database to mean anything. A unit test that mocked the repository would only prove the mock behaves as configured, not that Postgres enforces what the entities declare.

**Known simplification, not yet fixed:** the test reuses the same dev database (truncating it before each test) rather than a dedicated test database. That's acceptable for now because Phase 1 has no data worth protecting yet; it becomes a real problem once other phases' dev data exists and would get wiped by test runs. Revisit before then — likely a second, separate database on the same native Postgres instance, pointed at by a test-specific `.env`.

---

## Reverse-engineering guide — if you open this in six months

1. Read `docker-compose.yml` first — as of this phase it only runs Redis (port `6380`, non-default). Postgres is native (pgAdmin-managed), so check `Backend/.env` for its actual connection details rather than expecting a container.
2. `Backend/src/database/entities/` — the three entities are the entire data model as of this phase. Start with `membership.entity.ts`; it's the one with actual design decisions (dual column/relation declaration, cascade, composite unique, indexes).
3. `Backend/src/database/migrations/` — currently just `CreateWorkspaceUserMembership`. These are the source of truth for what's actually in the database — entities describe intent, migrations describe history. If a `vector`/pgvector-related migration exists here when you're reading this, Phase 7 resolved the deferral described above — check `docs/phases/07-*.md` for how.
4. `Backend/src/database/data-source.ts` vs `Backend/src/app.module.ts` — if a "works via CLI but not at runtime" (or vice versa) bug ever shows up, the discrepancy is almost certainly here — two separate config paths reading the same `.env`.
5. Run `npm test` inside `Backend/` — if `schema.integration.spec.ts` passes, the constraints described above are still real; if it fails, something about the schema regressed.

---

## Closing quiz

10 questions, batched, scored honestly. Weaker than the diagnostic in places — that's real signal, not just noise, and it's exactly what the "topics to master" section below is built from.

### C1 — Where the safety actually comes from
**Asked:** If application code tried to insert a membership without checking for an existing one first, where does the safety actually come from?
**Answer:** "so the unique constraints make sure tha every userid and workspace id must be unique so that there is no scope of conflict."
**Score: SHAKY.** This slightly misstates the constraint: it's not that `user_id` alone must be unique (a user legitimately has many memberships, one per workspace) or that `workspace_id` alone must be unique (a workspace has many members) — it's that the **pair** `(workspace_id, user_id)` must be unique. More importantly, the question asked *where the safety comes from*, and the precise answer is: **the database itself rejects the second `INSERT`** — Postgres raises a unique-violation error the instant a duplicate pair is attempted, regardless of whether the application code checked first. The safety is structural (enforced at the data layer) — the application never has to be trusted to remember the check.

### C2 — What's currently stopping the leak
**Asked:** What's currently stopping a bug where a query lists memberships across every workspace?
**Answer:** "we have not implemented logic so how can i tell"
**Score: SHAKY.** The substance is right — nothing is implemented yet — but the framing matters: the correct, precise answer is **"nothing is stopping it — this is a live, open gap right now, not a neutral absence."** Anchor has no authenticated requests yet, so the concrete exploit path doesn't exist *yet* either, but the moment Phase 2 adds a controller that queries `memberships` without a workspace filter, that query will leak across every tenant with no error and no warning. Treat "not built yet" as an active vulnerability window that closes when Phase 2 ships the guard — not a "not applicable" non-issue.

### C3 — What the migrations table is for
**Asked:** Why does a `migrations` table exist, and what does TypeORM use it for?
**Answer:** "so it checks is any migration is aready ran or not."
**Score: SHAKY.** Correct core idea, thin on mechanism. Precisely: TypeORM inserts one row per migration (`name`, `timestamp`) the instant it completes successfully. On every `migration:run`, it reads this table first, diffs it against the migration files present in `src/database/migrations/`, and runs only the ones with no matching row — that's the actual mechanism behind "already ran or not."

### C4 — Why two separate indexes, not just the composite unique constraint
**Asked:** Why does `Membership` need separate indexes on `workspace_id` and `user_id`, rather than relying on the composite `UNIQUE(workspace_id, user_id)` constraint alone?
**Answer:** "so that it dont have to scan all te role just it can categories sing indexes absed on workspace id and user id"
**Score: SHAKY.** This repeats the general "indexes avoid full scans" idea correctly but misses the specific mechanism the question is actually testing: **a composite index on `(workspace_id, user_id)` can only be used efficiently for lookups on `workspace_id` alone, or on both columns together — not for a lookup on `user_id` alone.** This is the *leftmost-prefix rule*: a multi-column B-tree index is sorted first by the leftmost column, so `WHERE user_id = 5` can't binary-search into it (user_id values are scattered throughout the index, not grouped). A query like "which workspaces does this user belong to?" (`WHERE user_id = ?`, no `workspace_id`) would still force a sequential scan without `user_id`'s own separate index. This is a very general, very transferable piece of SQL knowledge — see "topics to master" below.

### C5 — Two TypeORM configs
**Asked:** Why does this project have two separate places that configure the TypeORM connection?
**Answer:** "dnot know"
**Score: UNKNOWN.** Already taught in the phase doc's Data Flow section: `data-source.ts` is a plain `DataSource` used only by the CLI (`migration:generate`/`migration:run`), and `TypeOrmModule.forRootAsync(...)` in `app.module.ts` is what the running Nest app actually uses, wired through `ConfigService`. They exist separately because the TypeORM CLI runs *outside* Nest's dependency-injection system entirely — it's a standalone script, so it can't ask Nest's `ConfigService` for anything; it has to build its own connection config from scratch, reading `.env` directly via `dotenv`.

### C6 — Why resetting the password inside the container didn't fix the auth failure
**Asked:** In your own words, why not, and what was the real problem?
**Answer:** "maybe after resettng password we didnot restart docker compose."
**Score: UNKNOWN — and this one's worth sitting with.** This wasn't a restart issue; restarting wouldn't have changed anything, because the password was never actually wrong. The real chain of reasoning (documented in "Failure cases" above): (1) `pg_hba.conf` had `127.0.0.1` set to `trust`, meaning the loopback test that "confirmed it worked from inside the container" never actually checked the password at all — trust auth ignores whatever password is sent. (2) The actual failure was a **port collision**: a native Windows Postgres service was also listening on port 5432, and the Node app's connection to `localhost:5432` was hitting that completely different server, with completely different credentials — not the Docker container. No amount of correctly resetting the Docker container's password could ever have fixed a connection that wasn't reaching that container. The fix was moving the container to a different host port. This is a debugging-methodology lesson, not a Postgres lesson — see "topics to master" below.

### C7 — What `down()` is for
**Asked:** What is a migration's `down()` method for, and when would it actually run in practice?
**Answer:** "so it reverted all the migraton we up"
**Score: SHAKY.** The direction is right (down undoes up) but the scope is likely misunderstood: `migration:revert` reverts **exactly one migration — the most recently applied one** — not "all migrations run so far." To undo three migrations, you run `migration:revert` three separate times. In practice this runs when a migration that already shipped turns out to be wrong (a bad column type, a constraint that breaks something) and needs to be undone in a specific environment before a corrected migration replaces it — it is *not* a routine part of the generate → run cycle, and reverting a migration that other code already depends on (e.g., the app is already reading a column the migration added) is genuinely dangerous.

### C8 — What NestJS's DI container does with `inject: [ConfigService]`
**Answer:** "dont kow"
**Score: UNKNOWN.** At boot, Nest sees `TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (config) => ({...}) })` and does roughly: "before I can call `useFactory`, I need an instance of `ConfigService` — do I already have one built? If not, construct it (which itself may need its own dependencies resolved first, recursively), then call `useFactory(thatInstance)` and use whatever it returns as the TypeORM config." This is the same DI mechanism from Q9 in the original diagnostic, just visible in async form: the array literally tells Nest what to go build and hand over before the factory function can run.

### C9 — Symlinked workspace packages
**Answer:** "dont know"
**Score: UNKNOWN.** Moot for Anchor specifically now (no monorepo), but the concept regressed from being taught in the original diagnostic, worth one more pass since monorepos are common industry-wide: a workspace package isn't copied into a sibling's `node_modules` — the package manager creates a symlink, so editing the shared package's source is instantly visible to everything that imports it, with no publish or version-bump step, because nothing was ever actually "installed."

### C10 — What changes about auto-increment PKs once the widget exists
**Answer:** "dont know"
**Score: UNKNOWN.** Already logged as a real, tracked decision (see the decisions log and `docs/PHASES.md`): once Phase 11 exposes IDs through the public widget API, sequential integer IDs become guessable (seeing workspace `#4471` implies `#4470`/`#4472` probably exist) — a real enumeration risk for anything customer-facing. The fix isn't switching every PK to a UUID; it's adding a **separate, random, public-facing token** for anything referenced externally (e.g. a `public_id` column or similar), while internal PKs stay as fast, simple integers for joins.

---

## Topics to master — not just for Anchor, for being a genuinely strong engineer

This is the real output of running both quizzes back to back: five topics recur, are weak, and matter far beyond this project. Ranked by leverage.

1. **Systematic debugging: form a hypothesis the evidence actually supports, don't guess a plausible-sounding fix.** (C6) This is the single highest-leverage gap here. "Maybe we didn't restart docker compose" is a guess with no supporting evidence — nothing about the symptom ("password authentication failed") pointed at "needs a restart." The actual investigation had answers available the whole time: `pg_hba.conf` showed `trust` for loopback (meaning the "confirmation" test proved nothing), and `Get-NetTCPConnection -LocalPort 5432` showed two processes bound to the port. The skill isn't Postgres-specific — it's: *before proposing a fix, ask what observation would distinguish your theory from the alternatives, then go get that observation.* This is the difference between an engineer who fixes things and one who fixes things *and knows why they were broken* — the latter doesn't reintroduce the same bug in six months.
2. **Database constraints are how you enforce invariants that must never be violated — not application code, not "we'll remember to check."** (C1, C2) A unique constraint, a foreign key, a `NOT NULL` — these exist precisely because application code has bugs, gets refactored by people who don't know every rule, and gets bypassed by scripts, admin tools, and future you at 2am. The instinct to ask "where does the safety *actually* come from" — the database, not a check in a service method — is one of the clearest tells of a backend engineer who's been burned in production versus one who hasn't yet. C2 is the sharper version of this same idea: an unimplemented safeguard isn't neutral, it's an open door.
3. **Composite indexes have a shape, not just a presence/absence.** (C4) "Add an index" is a beginner's mental model; "which columns, in which order, and which query patterns does that order actually serve" is the professional one. The leftmost-prefix rule (a composite index on `(a, b)` serves `WHERE a = ?` and `WHERE a = ? AND b = ?`, but not `WHERE b = ?` alone) shows up in every relational database, in virtually every backend codebase with more than one query pattern per table, and is a near-universal interview question for a reason — it separates people who've memorized "indexes make things fast" from people who understand what indexes actually are (sorted structures with a specific sort order).
4. **Dependency injection is control being handed to a container, not a testing convenience.** (C8, and originally Q9) This is worth a third pass because it keeps testing as UNKNOWN despite being taught twice. The pattern (NestJS, Spring, Angular, .NET) is always the same: code declares *what it needs*, a container decides *what instance to provide*, and that indirection is what makes testing, swapping implementations, and managing object lifecycles all possible without rewriting the code that depends on them. Understanding this cold is closer to "how virtually all serious backend frameworks are built" than it is to "a NestJS quirk."
5. **A past architectural decision has a scope, and that scope can change.** (C10) Auto-increment IDs were a reasonable choice when nothing outside the team ever saw one. The moment an ID crosses a trust boundary (a public API, a customer-facing URL, a third-party integration), the tradeoffs that made the original decision fine no longer automatically hold — and noticing *when a decision's original context has expired* is a skill distinct from making the decision correctly the first time. Tracking this explicitly (as this project's decisions log does) rather than hoping to remember is itself the professional habit worth keeping.

## Interview questions this phase generates

- "Walk me through what happens, step by step, when two concurrent requests try to insert the same `(workspace_id, user_id)` pair into a table with a unique constraint." (Tests C1/Q6's mechanism, plus transaction/concurrency reasoning this phase didn't need to cover yet.)
- "You have a table with a composite index on `(a, b)`. A query filters only on `b`. Is the index used? Why or why not? How would you fix it if this query pattern is common?" (Directly C4.)
- "A service can't connect to 'the database' with credentials you're sure are correct. What's your systematic process for figuring out what's actually happening?" (Directly C6 — a great one to be able to answer well now, given it was a real weak spot.)
- "Explain the difference between `synchronize: true` and a migration-based workflow, and describe a concrete way `synchronize` could destroy production data." (Q5 from the original diagnostic — still worth being able to answer fluently.)
- "What does `ON DELETE CASCADE` actually do at the database level, and when is it the wrong choice compared to `RESTRICT` or a soft delete?" (Q6 from the original diagnostic, which was SOLID — good one to keep sharp since it'll come up again once `Document` exists.)

## What I still don't understand

(Genuinely still open after this quiz — carry these forward, don't let them go quiet just because Phase 1 is closing.)

- The two-TypeORM-config split (C5) and NestJS's async DI resolution (C8) — both taught above, but neither was demonstrated back correctly, so treat both as still shaky in practice until they show up again in Phase 2's guard/service wiring and get re-tested there.
- The precise mechanics of `migration:revert` (C7) — specifically, what happens if application code already depends on something a migration added, and that migration gets reverted underneath it. Worth deliberately breaking once there's a second migration to practice on.

