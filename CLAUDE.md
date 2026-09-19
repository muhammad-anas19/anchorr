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
- **Within a phase, build `Backend/` first, then `Frontend/` if that phase actually needs a UI, then `Widget/` if that phase actually needs it** — never all three by default. Most early phases are backend-only (Phase 1, Phase 2 were); don't add Frontend/Widget work to a phase just because those folders exist — only when that phase's own objective calls for it. Requested explicitly by the user (2026-09-13); Phase 2 was deliberately left backend-only rather than retrofitted, per the user's own call when asked.

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

**Inside `Backend/src/`** (reorganized mid-Phase-2 to match a pattern from the user's other project — see `docs/phases/02-*.md`'s "Repo layout" note):

```
Backend/src/
├── common/            cross-cutting guards/decorators used across module boundaries — NOT split by feature
│   ├── decorators/      current-user.decorator.ts, roles.decorator.ts
│   └── guards/          jwt-auth, login-throttle, workspace, roles — all guards live here regardless of "owning" module
├── database/           entities, migrations, data-source.ts — top-level sibling to modules/, not nested inside one
├── modules/             every feature module
│   ├── auth/
│   ├── tenancy/          just tenant-context.service.ts + tenancy.module.ts (its guards are in common/)
│   └── workspaces/
├── redis/               top-level sibling to modules/, not nested inside auth/
├── app.module.ts
└── main.ts
```

**Rule going forward:** a new guard, interceptor, filter, or cross-cutting decorator goes in `src/common/`, not inside whichever feature module first needed it. A new feature (with its own controller/service/module) goes in `src/modules/<name>/`. Shared infrastructure that multiple modules depend on (database, redis, and similarly config/cache/stripe if/when they exist) stays a top-level sibling to `modules/`.

## Locked decisions (see `docs/PHASES.md` for the short version, `docs/phases/01-*.md` and the `anchor-project-decisions` memory for full reasoning)

- **LLM provider:** Google Gemini for both chat and embeddings.
- **Data layer:** TypeORM + the `pgvector` Postgres extension.
- **Primary keys:** auto-increment integers, not UUIDs — chosen knowingly despite the enumeration-risk tradeoff. **Debt to repay at Phase 11**: any ID exposed via the public widget API needs a mitigation (e.g. a separate random public token) rather than exposing the raw integer PK.
- **No monorepo, no shared package** — reversed mid-Phase-1. If a type needs to exist in more than one folder, duplicate it or keep it in sync manually.
- **npm, not pnpm** — reversed mid-Phase-1; the user was unfamiliar with pnpm.
- **Postgres: revised again in Phase 7 — Anchor's own database now runs in Docker, not the native install.** Original Phase-1 decision (native Postgres via pgAdmin) held through Phases 1-6, but Phase 7 needed `pgvector`, which has no official Windows binary and would have required installing MSVC/Visual Studio Build Tools just to compile it against the native install — friction the user explicitly didn't want to accept. Real-world context that shaped the call: production RAG systems essentially never compile pgvector by hand either — managed Postgres (RDS, Supabase, Neon) ships it pre-built, and Linux/Docker Postgres gets it via a one-line package install or the official `pgvector/pgvector` image; hand-compiling on native Windows Postgres is a dev-machine-only problem, not a production pattern worth preserving. **Current setup:** native Postgres 18 (via pgAdmin) stays installed, untouched, still on port 5432, still available for the user's *other*, unrelated local projects — Anchor no longer uses it. Anchor's entire database now runs in a separate Docker container (`pgvector/pgvector:pg18`, service `postgres` in the repo-root `docker-compose.yml`, container name `anchor-postgres`), on host port **5433** (not 5432, so both instances coexist without conflict), with a named volume (`anchor_postgres_data`) for dev persistence — `docker compose down -v` fully resets it. `Backend/.env`'s `DB_PORT` changed from `5432` to `5433` to point at it; nothing else in the connection config changed. Verified via a real `CREATE EXTENSION vector` + a real `vector(3)` test table (created, populated, queried, dropped) — not assumed. All 5 existing migrations re-ran clean against the fresh instance, and the full test suite (54 tests) passes against it. **One real Postgres-18-specific Docker gotcha hit and fixed along the way:** the official image's volume-mount convention changed in Postgres 18+ — it now expects the volume mounted at `/var/lib/postgresql` (the parent directory), not `/var/lib/postgresql/data` (the pre-18 convention) — mounting at the old path makes the container refuse to start at all (it detects "data in the wrong place" and exits repeatedly rather than silently corrupting anything).
- **pgvector: installed for real in Phase 7** — via the Docker Postgres switch above. No longer deferred.

## Current status

**Phase 1 (multi-tenant schema foundation) — fully done.** Schema, migration, tests, diagnostic and closing quiz all complete — see `docs/phases/01-monorepo-multitenant-schema.md` for the full record. Carried-forward open items from Phase 1's closing quiz (the two-TypeORM-config split, NestJS's async DI resolution, `migration:revert`'s scope) got real, concrete exercise during Phase 2's build below — check Phase 2's closing quiz to see whether they actually stuck.

**Phase 2 (Auth & RBAC) — fully done.**

Done:
- Full auth flow: `POST /auth/register` (creates `User` + `Workspace` + an `owner` `Membership`), `/auth/login`, `/auth/refresh` (rotates on every use, revokes the old token), `/auth/logout` (revokes). JWT access (15 min) + refresh (7 days) via `@nestjs/jwt` + `passport-jwt`. Passwords hashed with bcrypt (12 rounds); refresh tokens hashed with SHA-256 (deliberately not bcrypt — see the phase doc for why that's the *correct* choice here, not a shortcut).
- New `refresh_tokens` table/migration (`CreateRefreshTokens`), FK to `users`, `ON DELETE CASCADE`.
- Tenant-scoping actually closed for real: `WorkspaceGuard` checks the authenticated user has a `Membership` for the `:workspaceId` in the URL (403 if not) and populates a request-scoped `TenantContextService`; `RolesGuard` + `@Roles(...)` enforce owner-only actions off that context. Proven via `PATCH /workspaces/:workspaceId/members/:userId` (owner-only) vs `GET .../members` (any member).
- Login brute-force protection: a Redis-backed `LoginThrottleGuard` (5 attempts per email+IP per 60s) — Redis's first real job in this project. Phase 15 will generalize this into the full rate-limiting system; this is a deliberately narrow stopgap.
- **`Backend/src/` reorganized mid-phase**: `common/` now holds all guards/decorators (cross-cutting, not split by feature), `modules/` holds feature modules (`auth`, `tenancy`, `workspaces`), `database/` and `redis/` stay top-level siblings. See "Repo structure" above and `docs/phases/02-*.md`'s "Repo layout" note for the full mapping — this was a deliberate mid-phase restructure requested by the user, not a refactor Claude initiated.
- 5 test suites, 18 tests, all real (no mocks) — hitting the native Postgres and real Redis. Includes deliberately-broken cases: refresh token reuse after rotation, revoked-token reuse, cross-workspace 403, non-owner RBAC 403, forged-signature JWT, expired JWT, and the login throttle's 6th-attempt 429.
- Full diagnostic (10 questions, 4 SOLID/4 SHAKY/2 UNKNOWN) documented in `docs/phases/02-auth-rbac.md`.
- Two real, unforced failures surfaced and fixed during the build (both documented in the phase doc's Failure Cases): a stale incremental TypeScript build cache silently serving an old route after `dist/` wasn't cleared, and parallel Jest worker processes racing on the shared dev database (fixed with `--runInBand` — the deeper fix, a dedicated test database, is still not done).

**Phase 2 closing quiz: answered and scored (2026-09-12).** Came back notably weaker than the opening diagnostic (0 SOLID / 3 SHAKY / 7 UNKNOWN, vs. 4/4/2 at the start) — several of these were things just built and demonstrated working hours earlier, which is real signal that "watched it work" and "can explain the mechanism" are different levels of understanding, not something to gloss over. Full Q&A, corrections, and a combined "Topics to master" list (7 items, ranked) are in `docs/phases/02-auth-rbac.md`. **Two topics are flagged as still critically weak going into Phase 3** and should get deliberate re-exposure rather than being assumed fixed: request-scoped DI / `ExecutionContext` (unresolved across *both* quizzes now), and the bcrypt-vs-SHA-256 entropy distinction (actually regressed between quizzes).

**Phase 3 (Knowledge base CRUD + file upload & storage) — fully done.**

Done:
- `Document` entity + migration (`CreateDocuments`): `workspace_id` (FK, `CASCADE`), `uploaded_by_user_id` (FK, `SET NULL` — deliberately different from `Membership`/`RefreshToken`'s `CASCADE`, since a document belongs to the workspace, not the uploader), `original_filename` (display only), `storage_key` (a `randomUUID()`, never derived from user input), `mime_type` (sniffed, not client-declared), `content_hash` (SHA-256), `status` enum (`uploaded`/`processing`/`ready`/`failed` — only `uploaded` is used so far), `UNIQUE(workspace_id, content_hash)`.
- `StorageAdapter` interface (`save`/`read`/`delete`) + `LocalDiskStorageAdapter`, swappable for S3 later via one new class and one line in `DocumentsModule`.
- Magic-byte MIME sniffing (`mime-sniffer.ts`) — no new dependency; the client's declared `Content-Type` is never trusted, only the actual bytes.
- `POST/GET/DELETE /workspaces/:workspaceId/documents[/:documentId]`, nested and guarded exactly like Phase 2's pattern (`JwtAuthGuard` → `WorkspaceGuard` → `RolesGuard`); upload/delete are Owner/Agent-only, list/get open to any member.
- 50MB upload limit enforced by `multer` at ingestion (`413` before the handler runs, not after buffering).
- Duplicate detection at two layers: an app-level pre-check (fast, friendly `409`) plus the `UNIQUE` DB constraint as the real backstop — **proven necessary, not theoretical**, by a concurrent-upload test (see below).
- 7 test suites, 29 tests, all real (Postgres + Redis + actual filesystem, no mocks).
- Full diagnostic (10 questions, 2 SOLID/6 SHAKY/2 UNKNOWN — notably, the same SQL/command-injection mixup recurred twice where the real answer was path traversal) documented in `docs/phases/03-knowledge-base-file-upload.md`.
- **Two more real, unforced failures**, both directly relevant to Phase 2's still-flagged-weak topics: (1) `DocumentsModule` failed to boot because `WorkspaceGuard`'s transitive request-scope needs `Repository<Membership>` reconstructable within *whichever module is consuming the guard*, not just wherever it was declared — a live, concrete encounter with the exact DI-scope topic still marked weak. (2) The `TRUNCATE`-list bug from Phase 2 recurred a third time (a new referencing table broke three other test files' cleanup) — now three phases of evidence that a dedicated test database is overdue, not a one-off.

**Phase 3 closing quiz: answered and scored (2026-09-14).** 3 SOLID / 3 SHAKY / 4 UNKNOWN. Two real wins (path traversal named cold, content-hash duplicate-detection reasoning solid), but `multipart/form-data`'s actual mechanism is now wrong for the *second* time in a *different* way (first: confused with resumable upload; now: confused with a security/verification mechanism) — this needs a different teaching approach next time, not a third prose explanation. One answer (on REST URL nesting) directly contradicted what `WorkspaceGuard`'s own code does — worth remembering that reasoning about API design in the abstract isn't a substitute for reading the actual guard. Full Q&A and a 6-item "Topics to master" list are in `docs/phases/03-*.md`. **Genuine cross-phase progress worth noting**: the request-scoped DI topic (flat UNKNOWN through all of Phase 2) moved to SHAKY this phase, via a real, unstaged encounter — not fully landed, but moving the right direction.

**Phase 4 (Background jobs with BullMQ) — built and tested, closing quiz not yet posed.**

Done:
- `@nestjs/bullmq` + `bullmq`, sharing the existing Redis instance (`REDIS_HOST`/`REDIS_PORT` from `.env`, since Phase 2). `src/queue/queue.module.ts` holds only the shared connection config (top-level infra, same tier as `database/`/`redis/`); the actual queue + processor live in `src/modules/documents/processing/`.
- `DocumentsService.upload()` now enqueues a `document-processing` job (`{ documentId }`, `attempts: 3`, exponential backoff) right after saving the row — enqueuing is fast and awaited, but the HTTP response goes out before any actual processing starts.
- `DocumentProcessingProcessor`: idempotency-guarded (`ready`/`failed` → no-op), flips `uploaded → processing → ready`. No real parsing yet — that's Phases 5-7. On exhausted retries, `@OnWorkerEvent('failed')` sets `status: 'failed'` + `failureReason`.
- Concurrency explicitly set to 5 (not left at BullMQ's silent default of 1). Worker runs in the same Node process as the API — a deliberate simplification, flagged for revisit once real processing (Phase 5+) has meaningful CPU/latency cost.
- 8 test suites, 32 tests. Includes a forced-failure test that watches all 3 retry attempts actually exhaust (real backoff timers, not mocked) and lands on `status: 'failed'`, plus an idempotent-redelivery test.
- **A live, non-automated demonstration of BullMQ's stall-detection mechanism**: two standalone workers, one made to hang (simulating a crash) and force-killed mid-job, the other picking up the stalled job once its lock expired. Real captured log output is in the phase doc's Failure Cases — this was deliberately *not* turned into a permanent test (killing real OS processes and waiting out real lock timers is slow/fragile for CI), just directly observed and documented once.
- Full diagnostic (10 questions, 3 SOLID/3 SHAKY/4 UNKNOWN) documented in `docs/phases/04-background-jobs-bullmq.md`. Notably: at-least-once vs exactly-once got swapped (UNKNOWN) — worth watching, since idempotency (Q5) follows directly from getting that distinction right.

**Phase 4 closing quiz: answered and scored (2026-09-14).** 2 SOLID / 3 SHAKY / 5 UNKNOWN. Notable and worth remembering: the stall-detection question (Q3) came back "don't know" *immediately* after watching it demonstrated live with real log output — the strongest signal yet in this project that watching something work and being able to explain it are genuinely different skills. Also confused two separate BullMQ timing mechanisms (retry backoff vs. stall detection/lock expiry) that "look similar" but protect against unrelated failure modes — flagged as the top thing to nail down before it causes real confusion in production. Full Q&A and a 5-item "Topics to master" list are in `docs/phases/04-*.md`. One genuine win: the at-least-once/exactly-once distinction, swapped in the opening diagnostic, came back correctly explained *and* correctly tied to why this project's idempotency guard is the practical fix — real, lasting improvement within a single phase.

**Phase 5 (Document parsing & extraction pipeline) — built and tested, closing quiz not yet posed.**

Done:
- New `document_contents` table/migration (`CreateDocumentContents`): one row per document, `document_id` `UNIQUE` FK to `documents` with `CASCADE` delete, `extracted_text` (`text`, TOASTed), nullable `page_count` (explicit `type: 'integer'` — the union-type-reflects-to-`Object` lesson from earlier phases applied correctly from the start).
- `src/modules/documents/processing/extraction/`: `extraction.ts` (dispatcher — MIME-based routing, a 30s timeout, `isEffectivelyEmpty()` heuristic), `pdf-extractor.ts` (`pdf-parse`), `docx-extractor.ts` (`mammoth`). Two named failure types: `UnsupportedMimeTypeError`, `ExtractionTimeoutError`.
- `DocumentProcessingProcessor` (Phase 4's placeholder replaced with the real pipeline): reads via `StorageAdapter`, extracts, and branches — deterministic "no extractable text" sets `status: 'failed'` directly with **no throw** (so no retries are wasted on a file that can never succeed), while genuine errors still propagate into Phase 4's existing retry/backoff machinery unchanged. Content is written via `upsert` (not `insert`) keyed on `document_id`, so a redelivered job that crashed after writing content but before flipping status lands on the same end state instead of hitting the `UNIQUE` constraint.
- Real, non-hand-rolled test fixtures (`sample.pdf`, `scanned.pdf`, `sample.docx`) — see the phase doc's Reverse-engineering guide for why (hand-rolling raw PDF bytes failed repeatedly with unexplained `bad XRef entry` errors; headless Chrome + `jszip` proved far more reliable).
- `esModuleInterop: true` added to `tsconfig.json` (needed for `pdf-parse`/`mammoth`'s default-export CJS shape; verified `ioredis`'s existing default import is unaffected). One follow-on fix required: `import * as request from 'supertest'` (3 e2e test files) had to become `import request from 'supertest'` under the new interop setting.
- `document_contents` added to every existing test file's `TRUNCATE` list — the exact same recurring bug pattern from Phases 2-4, now seen a fourth time.
- A real, documented Jest-only bug (not a production bug): calling `pdf-parse` from inside a BullMQ worker's job callback — several native-I/O frames deep — reproducibly broke `pdf-parse`'s own lazy internal `require()` under Jest specifically (confirmed absent in a plain `node` process). Worked around by having the two real-extraction e2e tests call `processor.process()` directly rather than through the real queue; the queue-mechanism tests (retry/backoff, idempotency) still run through BullMQ for real, since neither touches `pdf-parse`. Full diagnosis is in the phase doc's Failure Cases — worth reading before assuming a similar future error means the application code is wrong.
- Full test suite: 44 tests, 11 suites, all real (Postgres + Redis + real filesystem + real PDF/DOCX bytes), verified green across two consecutive full runs.
- Full diagnostic (10 questions, **0 SOLID / 0 SHAKY / 10 UNKNOWN** — the user's self-identified weakest phase) documented in unusually exhaustive detail in `docs/phases/05-document-parsing-extraction.md`, per explicit request to cover adjacent/background knowledge, not just the literal questions.

**Phase 5 closing quiz: answered and scored (2026-09-16), phase closed by explicit user choice (2026-09-17) with 3 re-taught topics left unanswered.** Closing quiz came back at **0 SOLID / 1 SHAKY / 9 UNKNOWN** — essentially unmoved from the opening diagnostic's 0/0/10, the weakest result of any phase so far (compare Phase 2's 0/3/7, Phase 4's 2/3/5). Per protocol, the 3 most load-bearing UNKNOWNs (PDF-as-drawing-instructions, `job.updateProgress()`'s Redis-only/non-durable scope, upsert-based idempotency) were re-taught with a different angle and re-asked; the user chose to move straight to Phase 6 without answering. Flagged once, then respected as the user's call. **Standing open item, most notable one:** `job.updateProgress()`'s storage location produced the *identical* wrong answer ("it's in the database, and it survives") across three separate exposures (opening diagnostic → closing quiz → unaddressed re-ask) — treat this as unresolved, not fixed, the next time BullMQ progress reporting comes up (Phase 12's real-time work is the likely trigger). Full Q&A, the re-teach, and a 7-item "Topics to master" list are in `docs/phases/05-*.md`.

**Phase 6 (Chunking strategies) — built and tested, closing quiz not yet posed.**

Done:
- New `document_chunks` table/migration (`CreateDocumentChunks`): `document_id` (FK, `CASCADE`, indexed — *not* unique, unlike Phase 5's one-to-one `document_contents`), `chunk_index` + `UNIQUE(document_id, chunk_index)`, `content` (`text`), `char_start`/`char_end` (offsets into `document_contents.extracted_text`, unused so far but cheap to capture now). Registered in both `data-source.ts` and `app.module.ts` from the start this time — no repeat of Phase 5's two-config miss.
- `src/modules/documents/processing/chunking/chunking.ts`: `chunkText()` — pure, dependency-free, fixed-size (~1000 char, a token-count proxy) chunking with ~150-char overlap and boundary-snapping (paragraph → sentence → whitespace, in that order of preference) so cuts avoid slicing mid-word where a nearby natural boundary exists. Provably terminating regardless of how the size/overlap constants are tuned (`cursor = Math.max(nextCursor, cursor + 1)` forces progress every iteration).
- `DocumentProcessingProcessor` extended (not a new job — a deliberate design call, since chunking is free local CPU work with none of Phase 7's paid-API concerns): after the Phase 5 extraction + `document_contents` upsert, `chunkText()` runs, then a `dataSource.transaction(...)` deletes any existing chunks for the document and inserts the fresh set atomically — a delete-then-insert "replace," not a per-row upsert, since a re-run can produce a different *number* of chunks than a previous run left behind.
- Two real, deliberately-triggered "break it" tests (not hypothetical): the `UNIQUE(document_id, chunk_index)` constraint proven to reject a raw duplicate insert, and the delete-then-insert transaction proven to roll back atomically when the insert half fails partway through (the original chunk survives untouched) — both confirmed by actually running them, not just reasoning about them.
- `document_chunks` added to every test file's `TRUNCATE` list proactively this time, before it could recur as a bug for a fifth time.
- Full test suite: 54 tests, 12 suites, all real, verified green.
- Full diagnostic (10 questions, 0 SOLID / 2 SHAKY / 8 UNKNOWN) documented in `docs/phases/06-chunking-strategies.md` — continuing Phase 5's pattern of RAG-pipeline fundamentals (tokens, embedding granularity, chunk-boundary tradeoffs) landing weak on first exposure.

**Phase 6 closing quiz: answered and scored (2026-09-17).** Came back at **1 SOLID / 1 SHAKY / 6 UNKNOWN** — a modest real improvement over the opening diagnostic's 0/2/8. Two genuine wins: the composite-`UNIQUE(document_id, chunk_index)` reasoning landed SOLID, and "chunking runs in the same job as extraction" was correctly recalled (though with inverted reasoning — said chunking is slow, when the real reason is the opposite: it's fast/free, unlike Phase 7's paid embedding calls). **The one answer flagged as actively concerning, not just incomplete**: describing what happens if the server crashes mid-transaction as permanent data loss requiring a re-upload — the exact opposite of what this phase's own tested transaction-rollback guarantee proves. Per the user's explicit request ("these are very new for me... keep every small detail... so I can crack any interview"), every closing-quiz answer got a full, interview-oriented explanation rather than a brief correction — see `docs/phases/06-*.md` for the complete Q&A, a 6-item "Topics to master" list, and dedicated interview-question and what's-still-not-understood sections.

**Phase 7 (Embeddings & pgvector storage) — built and tested, closing quiz not yet posed.**

Done:
- **Postgres hosting reversed** — Anchor's whole database now runs in Docker (`pgvector/pgvector:pg18`, port 5433), not the native install (still there, still on 5432, still available for other local projects) — see "Locked decisions" above for the full reasoning and the real Postgres-18 volume-mount gotcha hit along the way.
- `document_chunks.embedding` column (`vector(768)`, nullable) via `AddEmbeddingToDocumentChunks`. 768, not the model's native 3072, to stay under pgvector's 2000-dim HNSW/IVFFlat indexing ceiling — requested via `outputDimensionality`, verified as a genuine Matryoshka-style prefix (not an unrelated smaller model) by comparing first-5-values between a 3072 and a 768 call on the same text.
- `EmbeddingProvider` interface + `GeminiEmbeddingProvider` (`@google/genai`, the first Gemini-calling code in this project). Real model-name correction needed mid-build: the documented example model (`text-embedding-004`) 404'd for real — retired; found the current one (`gemini-embedding-001`) by calling `client.models.list()` against the live API.
- New, separate `document-embedding` BullMQ queue/processor — deliberately not fused into Phase 5/6's job, since embedding is the first genuinely paid/rate-limited/sometimes-unavailable external call in this pipeline. One job per document; each chunk embedded and saved individually, with a per-chunk `embedding IS NULL` skip so a retry never re-pays for chunks that already succeeded — proven with a deterministic partial-failure test (a controlled substitute provider, real Postgres), not just reasoned about.
- **`Document.status = 'ready'` now means "fully embedded," not just "chunked."** `DocumentProcessingProcessor` no longer sets `ready` itself — it enqueues the embedding job and stays at `processing`; only `DocumentEmbeddingProcessor` sets `ready`, once every chunk has an embedding.
- A real, working proof of the whole phase's reason to exist: a test embeds "Refunds are available within 30 days of purchase" and "How do I get my money back?" (zero shared words) and confirms they land closer together (cosine similarity) than either does to an unrelated sentence about shipping.
- A real `429 RESOURCE_EXHAUSTED` hit during testing (an oversized input, compounded by the day's own API traffic) — concrete, first-hand evidence for why per-chunk (not per-document) idempotency was the right call.
- Full test suite: 60 tests, 14 suites, all real (Postgres + Redis + real Gemini API calls + a controlled substitute provider only for the one deterministic partial-failure scenario a real API can't reliably reproduce on demand), verified green.
- Full diagnostic (12 questions, 1 SOLID / 4 SHAKY / 7 UNKNOWN) documented in unusually exhaustive detail in `docs/phases/07-embeddings-pgvector.md`, per explicit request — genuinely better than Phase 5/6's opening diagnostics.

**Phase 7 closing quiz: answered and scored (2026-09-18).** Came back at **3 SOLID / 4 SHAKY / 5 UNKNOWN — the best closing-quiz result of any phase so far** (compare Phase 5's 0/1/9, Phase 6's 1/1/6). Genuine, correctly-reasoned wins: per-chunk retry idempotency (Q5), and — the most product-mature result yet — correctly explaining *why* `Document.status = 'ready'` had to move to the embedding processor rather than just stating that it did (Q6, Q12). Still open: the actual math of cosine similarity, why brute-force vector search degrades and what an ANN index trades away to fix it, and the concrete reason 768 dimensions was chosen over the model's native 3072 — all three got a second, differently-worded first-principles pass (with a worked numeric example for cosine similarity) in `docs/phases/07-*.md`'s dedicated "no gaps left" section, per explicit request, rather than just a corrected quiz answer. Full Q&A, that section, and a 6-item "Topics to master" list are in the phase doc.

**Next up:** Phase 8 — Vector similarity search (retrieval v1) (see `docs/PHASES.md`).

## Environment quirks worth knowing (this specific machine/session)

- Bash `mv` on a directory can silently drop regular files while preserving subdirectories. Files have also vanished spontaneously with no operation touching them. **Always verify with `find <dir> -type f` after any write/move**, and recreate anything missing.
- If VS Code's Source Control panel shows an absurd change count or references paths that no longer exist, it's a stale cache — check `git status --short` from the CLI first.
- This machine runs multiple unrelated Docker projects and a native Postgres install. Port collisions are real and silent (wrong-server auth failures, not connection errors) — always check `Get-NetTCPConnection -LocalPort <port>` / `docker ps -a` before assuming a container's config is wrong.
