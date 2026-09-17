# Anchor — Phase Roadmap

18 phases, each buildable in 2-5 evenings, each a self-contained unit introducing one or two new concepts. Full detail per completed phase lives in `docs/phases/NN-name.md` (diagnostic Q&A, architecture, code walkthrough, failure cases, closing quiz). This file is the map, not the territory — read it to see where things stand, then go to the phase doc for the real content.

**Status legend:** DONE · IN PROGRESS · PENDING

| # | Phase | Status | Depends on | Key concepts introduced |
|---|-------|--------|------------|--------------------------|
| 1 | Multi-tenant schema foundation | DONE — see `docs/phases/01-monorepo-multitenant-schema.md` | none | row-level multi-tenancy, TypeORM migrations vs `synchronize`, FK cascade behavior, indexing FK columns |
| 2 | Auth & RBAC | DONE — see `docs/phases/02-auth-rbac.md` | 1 | NestJS Guards, session/JWT auth, tenant-scoping enforcement (the guard the schema in Phase 1 was built for) |
| 3 | Knowledge base CRUD + file upload & storage | DONE — see `docs/phases/03-knowledge-base-file-upload.md` | 2 | multipart upload handling, storage adapter interface |
| 4 | Background jobs with BullMQ | DONE — see `docs/phases/04-background-jobs-bullmq.md` | 3 | Redis-backed job queues, producer/worker split, retries/backoff, idempotent handlers |
| 5 | Document parsing & extraction pipeline | DONE (closed by user choice with 3 topics left UNKNOWN — see phase doc) — see `docs/phases/05-document-parsing-extraction.md` | 4 | PDF/DOCX text extraction inside a worker, failure-state design |
| 6 | Chunking strategies | DONE | 5 | heading-based vs fixed-token chunking, overlap |
| 7 | Embeddings & pgvector storage | IN PROGRESS | 6 | embedding generation (Gemini), pgvector column type, ANN indexing |
| 8 | Vector similarity search (retrieval v1) | PENDING | 7 | query-time embedding, k-NN search |
| 9 | LLM provider interface & grounded answer generation | PENDING | 8 | provider abstraction design, RAG prompt assembly, citation attribution |
| 10 | Confidence scoring, refusal & escalation state machine | PENDING | 9 | retrieval-based confidence threshold, Conversation state machine |
| 11 | Public widget + real-time chat | PENDING | 2, 10 | WebSockets (Socket.IO), public API key + domain allowlist, separate widget build target. **Also where the Phase 1 auto-increment-PK decision needs revisiting for externally-exposed IDs.** |
| 12 | Agent console: human handoff | PENDING | 11 | presence tracking, optimistic concurrency on "claim" |
| 13 | Hybrid search (vector + keyword) | PENDING | 8 | Postgres full-text search, rank fusion |
| 14 | Semantic caching | PENDING | 9, 7 | similarity-keyed Redis caching, cache invalidation |
| 15 | Usage metering & rate limiting | PENDING | 9 | metering as an event stream, Redis rate limiting |
| 16 | Stripe billing integration | PENDING | 15 | Stripe subscriptions vs usage records, webhook handling |
| 17 | Evaluations framework | PENDING | 9, 13 | retrieval metrics vs generation metrics, experiment comparison |
| 18 | Analytics rollups & production hardening | PENDING | 11, 12, 15, 16, 17 | scheduled rollup/aggregation, Docker Compose for the full stack |

## Locked decisions affecting this roadmap

See `CLAUDE.md` and the `anchor-project-decisions` memory for the full list with reasoning. Summary:
- LLM provider: Google Gemini (chat + embeddings), behind a custom provider interface.
- Data layer: TypeORM + `pgvector`.
- Primary keys: auto-increment integers, not UUIDs (debt to repay at Phase 11).
- No monorepo — `Backend/`, `Frontend/`, `Widget/` are independent, npm-managed folders.
- Postgres: native instance managed via pgAdmin, not Docker. Redis: still Docker (`docker-compose.yml`).
