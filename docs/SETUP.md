# Local development setup

## Prerequisites

- Node.js 20+ (repo tested against Node 24)
- npm (bundled with Node) — **not pnpm**, see `docs/phases/01-*.md` for why that switch happened
- Docker Desktop — runs both Redis and Anchor's own Postgres (see "Postgres" below)

## Postgres

**Revised in Phase 7** — Anchor's database now runs in Docker, not on a native install. (Phases 1-6 used a native Postgres via pgAdmin; that reversed once `pgvector` was needed — see `docs/phases/07-*.md` for the full reasoning. If this machine also has a native Postgres installed for other, unrelated projects, it's untouched and still on port 5432 — Anchor no longer uses it.)

```
docker compose up -d
```

from the repo root brings up **both** Redis (`localhost:6380`) and Anchor's Postgres (`localhost:5433`, image `pgvector/pgvector:pg18`, container `anchor-postgres`) — pgvector is already built into that image, no manual extension install needed. Data persists in the named volume `anchor_postgres_data`; `docker compose down -v` fully resets it (safe in dev — nothing here is meant to be durable).

To connect from pgAdmin (or any client) directly: host `localhost`, port `5433`, database `anchor`, user `postgres`, password `mypostgres` (see `Backend/.env`, which already points here).

Once the container is up, fill `Backend/.env` (see below) and run the migrations.

## Redis

Brought up by the same `docker compose up -d` above, on `localhost:6380` (not the default `6379` — see the phase 1 doc for why: an unrelated project's Redis container was already using it on this machine).

## Backend

```
cd Backend
npm install
```

Create `Backend/.env`:

```
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=mypostgres
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
