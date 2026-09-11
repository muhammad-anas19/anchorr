# Anchor — Project Memory for Claude

Read this first in any new session on this repo. If anything here conflicts with what you observe in the code, trust the code and update this file.

## What Anchor is

A multi-tenant AI customer-support platform. Companies create a workspace, upload documentation, and get an embeddable chat widget. The AI answers customer questions using only that company's content, with citations, and escalates to a human agent when it isn't confident. Usage is metered and billed.

A static design prototype exists at `Anchor_Prototype.html` (repo root) — a bundled design-canvas artifact, not readable as plain HTML. If you need to re-consult it, its actual markup is inside a `<script type="__bundler/template">` tag as an escaped JSON string; extract and `JSON.parse()` it (see any earlier session's approach) rather than reading the file directly.

## Who this is for and how to work

The user is a full-stack developer (~18 months experience), strong in NestJS/Next.js/PostgreSQL/auth, **new to vector search, RAG, job queues, evaluation, and usage billing**. This is explicitly a learning project — optimize for **understanding gained per phase**, not code generated per hour. A phase isn't done until the user can explain it without the code in front of them.

**Never silently correct or "just fix" a decision the user made.** If you think a choice is wrong, say so once, explain the tradeoff, then follow whatever they decide. Several early decisions in this project were the user overriding a recommendation (see "Locked decisions" below) — that's normal and expected, not something to relitigate.

### The phase loop (from the original kickoff — still the working protocol)

Every phase follows this sequence:

0. **Diagnose first.** Before explaining anything, ask 8-12 questions on the concepts the phase requires. **Present the whole batch at once** (not one-at-a-time — the user asked for this explicitly), get one combined reply, then score each topic SOLID / SHAKY / UNKNOWN honestly. Don't correct answers while scoring.
1. **Teach only the gaps.** Skip SOLID topics. Name what was missing for SHAKY. Teach UNKNOWN from first principles with an analogy and a concrete example from this codebase. **This content goes into `docs/phases/NN-name.md`, not into the chat reply** — the user asked for this explicitly too. Keep the chat response short: confirm the doc was written, maybe one line of what's next.
2. **Design.** Propose the architecture (with a diagram), explain alternatives and tradeoffs. Wait for agreement before writing code.
3. **Build in small increments.** Explain → implement → test → review, one increment at a time. Never "changed 25 files, here's a summary."
4. **Walk through the code** — meaningful blocks only, into the phase doc.
5. **Break it deliberately** — kill a process mid-operation, force a timeout, process something twice, whatever applies. Predict first, then actually trigger it, then report what really happened. For a phase with no running service yet (like Phase 1), a real constraint violation (unique/cascade) tested for real counts as this step.
6. **Document the phase** — see the required sections below.
7. **Closing quiz** — re-ask the Step 0 topics plus new ones from what was actually built. Batch these too. If a critical topic is still UNKNOWN, teach it and re-ask; the phase isn't done.
8. **"Topics to master" — after BOTH quizzes (opening diagnostic and closing quiz) are scored, write a ranked list into the phase doc** of what's still weak, explicitly reframed around **transferable software engineering skill** — not Anchor trivia. Format (see `docs/phases/01-*.md`'s "Topics to master" section for a full example): each entry is a `### N. <canonical, searchable topic name>` heading (e.g. "Composite (multi-column) indexes and the leftmost-prefix rule" — something you could type into a search engine), followed by a `**Search:**` line with 2-3 real query phrases, then `**Exposed by:**` naming the quiz question(s), then the explanation of why it's high-leverage across most backend projects generally, not just this one. The bar: topics a genuinely excellent engineer has cold. Requested explicitly by the user (2026-09-11) as a standing requirement for every phase — first as prose explanations, then refined the same day to require the searchable-heading format specifically so the list doubles as a study list.

### `docs/phases/NN-name.md` required sections

Objective and why the system needs it; the diagnostic (every question, the user's actual answer, the score, the correct explanation); a "topics you must know before moving on" list ranked by how load-bearing each is; architecture and decisions with tradeoffs; complete data flow; **for every migration in the phase, a plain-language breakdown of what each table stores and what each column stores** (not just the SQL — see `docs/phases/01-*.md`'s "Migrations: what each table and column actually stores" for the expected format); code walkthrough of every significant file; failure cases actually tested (not hypothetical); tests and why each exists; a reverse-engineering guide (where to start if reopened in six months); closing quiz with real answers; interview questions the phase generates; what's still not understood.

### Other standing rules from the kickoff

- Don't copy code from the prototype — it's a static mock, reimplement properly.
- Don't add dependencies outside the stack without asking.
- Don't skip tests, even in an infra-only phase (Phase 1 added a real Jest integration test rather than relying only on manual `psql` checks).
- Say "I don't know" rather than guessing.

## Stack

TypeScript, NestJS, PostgreSQL + pgvector, Redis, BullMQ, Socket.IO, Next.js, Stripe, Docker. One LLM provider (Google Gemini, chat + embeddings) behind a custom interface — no LangChain.

## Repo structure

**Not a monorepo** (this was the original plan, reversed by the user early in Phase 1 — see Locked Decisions). Three fully independent folders, each with its own `package.json`/`node_modules`, installed separately with npm:

```
Backend/    NestJS API — built starting Phase 1
Frontend/   Next.js dashboard — placeholder only, built starting Phase 2+
Widget/     Embeddable vanilla-TS chat widget — placeholder only, built starting Phase 11
docs/
  PHASES.md         full 18-phase roadmap with status
  SETUP.md          local dev environment setup
  phases/NN-*.md    per-phase record (the real documentation output of this project)
docker-compose.yml  Redis only (see Locked Decisions — Postgres is native, not Docker)
```

## Locked decisions (see `docs/PHASES.md` for the short version, `docs/phases/01-*.md` and the `anchor-project-decisions` memory for full reasoning)

- **LLM provider:** Google Gemini for both chat and embeddings.
- **Data layer:** TypeORM + the `pgvector` Postgres extension.
- **Primary keys:** auto-increment integers, not UUIDs — chosen knowingly despite the enumeration-risk tradeoff. **Debt to repay at Phase 11**: any ID exposed via the public widget API needs a mitigation (e.g. a separate random public token) rather than exposing the raw integer PK.
- **No monorepo, no shared package** — reversed mid-Phase-1. If a type needs to exist in more than one folder, duplicate it or keep it in sync manually.
- **npm, not pnpm** — reversed mid-Phase-1; the user was unfamiliar with pnpm.
- **Postgres: native instance via pgAdmin, not Docker** — reversed mid-Phase-1. Native Postgres 18, database `anchor`, user `postgres`. Redis stays in Docker (`docker-compose.yml`, host port `6380` — not the default `6379`, which collides with an unrelated project's container on this machine).
- **pgvector: deferred to Phase 7** — not installed on the native Postgres 18 instance (confirmed by a real failed `CREATE EXTENSION`, not assumed). No migration currently enables it. Revisit when Phase 7 needs it — see `docs/phases/01-*.md`'s "pgvector: enabled, then deferred" for the three options considered.

## Current status

**Phase 1 (multi-tenant schema foundation) — built, not yet fully closed out.**

Done:
- `Backend/` scaffolded (NestJS, npm-managed).
- Three entities: `Workspace`, `User`, `Membership` (with `MembershipRole` enum), row-level tenancy (`workspace_id` FK on `Membership`), `ON DELETE CASCADE` on both FKs, indexes on both FK columns, `UNIQUE(workspace_id, user_id)`.
- One migration (`CreateWorkspaceUserMembership`) applied successfully against the native Postgres 18 instance (database `anchor`, created manually since it didn't exist yet).
- **`pgvector` deferred to Phase 7** — the native Postgres 18 install doesn't have it physically installed (confirmed via a real failed migration, not assumed); installing it needs Visual Studio Build Tools + compiling from source. The `EnablePgvectorExtension` migration was deleted (it never successfully applied) rather than left broken. See `docs/phases/01-*.md`, "pgvector: enabled, then deferred," for the full reasoning and the three options still on the table for Phase 7.
- A Jest integration test (`Backend/src/database/schema.integration.spec.ts`) proving the UNIQUE and CASCADE behavior for real, passing against the live native database.
- App boots cleanly (`npm start` in `Backend/`, `GET /health` → `{"status":"ok"}`) against the native database.
- Full diagnostic (10 questions) scored and documented in `docs/phases/01-monorepo-multitenant-schema.md`.

**Phase 1 closing quiz: answered and scored (2026-09-11).** Mixed results — several real gaps, not glossed over: see `docs/phases/01-*.md`'s Closing Quiz and "Topics to master" sections. Still genuinely UNKNOWN going into Phase 2: the two-TypeORM-config split, NestJS's async DI resolution (`inject: [...]`), and the specifics of `migration:revert`'s scope. These are carried forward deliberately, not forgotten — expect them to resurface when Phase 2 builds the auth guard (which is exactly where DI and config wiring get exercised for real).

**Next up:** Phase 2 — Auth & RBAC (see `docs/PHASES.md`). Note before starting: Phase 2 is also where the tenant-scoping gap named in C2 above (nothing currently stops a cross-workspace query) actually gets closed — that's the whole point of the guard/`TenantContextService` this phase is designed around.

## Environment quirks worth knowing (this specific machine/session)

- Bash `mv` on a directory can silently drop regular files while preserving subdirectories. Files have also vanished spontaneously with no operation touching them. **Always verify with `find <dir> -type f` after any write/move**, and recreate anything missing.
- If VS Code's Source Control panel shows an absurd change count or references paths that no longer exist, it's a stale cache — check `git status --short` from the CLI first.
- This machine runs multiple unrelated Docker projects and a native Postgres install. Port collisions are real and silent (wrong-server auth failures, not connection errors) — always check `Get-NetTCPConnection -LocalPort <port>` / `docker ps -a` before assuming a container's config is wrong.
