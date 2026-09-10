# Local development setup

## Prerequisites

- Node.js 20+ (repo tested against Node 24)
- npm (bundled with Node) — **not pnpm**, see `docs/phases/01-*.md` for why that switch happened
- A local PostgreSQL 16 instance with the **pgvector** extension available (see "Postgres" below — this project uses a native install managed via pgAdmin, not Docker)
- Docker Desktop, for Redis only

## Postgres

Postgres runs **natively on the machine**, not in Docker (a deliberate choice — see `docs/phases/01-*.md`, "Package manager & Postgres hosting"). Whoever sets this up needs:

1. A running Postgres 16+ instance (managed however you like — pgAdmin is what's in use here).
2. A database for Anchor (e.g. `anchor`) and a role with a password, with privileges on that database.
3. **The `pgvector` extension's files physically installed** for that Postgres install — this is different from just running `CREATE EXTENSION`, which only works if the extension is already present on disk. On Windows this typically means a prebuilt `vector.dll`/`vector.control` matching the exact Postgres version, or compiling it with Visual Studio Build Tools. Confirm this before Phase 7 (embeddings) at the latest — Phase 1's migration already tries `CREATE EXTENSION IF NOT EXISTS vector;` and will fail if it's missing.

Once you have connection details, fill them into `Backend/.env` (see below) and run the migrations.

## Redis

```
docker compose up -d
```

from the repo root brings up Redis on `localhost:6380` (not the default `6379` — see the phase 1 doc for why: an unrelated project's Redis container was already using it on this machine).

## Backend

```
cd Backend
npm install
```

Create `Backend/.env`:

```
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=<your Postgres role>
DB_PASSWORD=<your Postgres password>
DB_NAME=anchor
```

Run migrations:

```
npm run migration:run
```

Run the app:

```
npm run start:dev
```

Health check: `GET http://localhost:3001/health` should return `{"status":"ok"}`.

Run tests (hits the real database — see `docs/phases/01-*.md` for why there's no mocking here yet):

```
npm test
```

## Frontend / Widget

Not built out yet — placeholder `package.json` only, until Phase 2 (Frontend) and Phase 11 (Widget).
