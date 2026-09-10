# Anchor

A multi-tenant AI customer-support platform. Companies create a workspace, upload their documentation, and get an embeddable chat widget. The AI answers customer questions using only that company's content, with citations, and escalates to a human agent when it isn't confident. Usage is metered and billed.

This is a learning project, not a race to ship — see [CLAUDE.md](CLAUDE.md) for how it's actually being built (phase-by-phase, diagnostic-first) and [docs/PHASES.md](docs/PHASES.md) for the full roadmap. `docs/phases/NN-*.md` holds the real record of what's been learned and built, phase by phase.

## Stack

TypeScript, NestJS, PostgreSQL + pgvector, Redis, BullMQ, Socket.IO, Next.js, Stripe, Docker. One LLM provider (Google Gemini) behind a custom interface — no LangChain.

## Repo structure

Three fully independent folders — no monorepo, no shared package (a deliberate choice, see `docs/phases/01-*.md`):

```
Backend/    NestJS API — entities, migrations, business logic
Frontend/   Next.js dashboard (built starting Phase 2+)
Widget/     Embeddable vanilla-TS chat widget (built starting Phase 11)
```

Each has its own `package.json`, its own `node_modules`, installed separately with plain `npm install`.

## Local setup

See [docs/SETUP.md](docs/SETUP.md).

## Current status

Phase 1 (multi-tenant schema foundation) — see `docs/phases/01-monorepo-multitenant-schema.md` for full detail, including what's still pending before it's fully closed out.
