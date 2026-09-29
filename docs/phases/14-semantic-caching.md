# Phase 14 — Semantic caching

**Depends on:** Phase 9 (generation), Phase 7 (embeddings) · **Introduces:** similarity-keyed caching, cache invalidation, stampede protection

---

## Objective, and why the system needs it

Every `POST /ask` currently pays for two external calls, measured against the real APIs from this machine:

| Call | Measured | Notes |
|---|---|---|
| `EmbeddingProvider.embed(question)` | **391 – 593 ms** warm, **1280 ms** cold | cheap-ish; 1000/day free quota |
| `AnswerGenerationProvider.generate(...)` | **1748 – 2141 ms** | the expensive one; **20/day** free quota |

Generation dominates both **latency** (~75% of the external time) and **cost/quota** (the 20-per-day limit is what has repeatedly broken this project's own test runs). Support questions are heavily repetitive — the same few dozen questions account for most traffic in almost any support product — so answering a repeat from a cache instead of regenerating it is the obvious lever.

**The objective of this phase is to skip the generation call for repeat questions — without ever serving a customer an answer to a different question than the one they asked.** The second half of that sentence turns out to be the whole phase.

---

## The measurement that shapes the entire design

Before designing anything, real question pairs were embedded and compared. A semantic cache works only if there is a similarity threshold that lets genuine paraphrases hit **and** keeps different-answer questions apart.

| Pair | Should share an answer? | Cosine distance |
|---|---|---|
| "How do I get a refund?" / identical | yes | **0.0000** |
| "How do I get a refund?" / "How do i get a refnd?" | yes (typo) | **0.1359** |
| "What are your opening hours?" / "When are you open?" | yes | **0.1946** |
| "How do I reset my password?" / "I forgot my password, what do I do?" | yes | **0.2314** |
| "How do I get a refund?" / "How can I get my money back?" | yes | **0.2609** |
| **"Can I get a refund after 30 days?" / "…within 30 days?"** | **NO — opposite answers** | **0.0534** |
| **"What does error E-4021 mean?" / "…E-4022 mean?"** | **NO** | **0.1409** |
| **"How do I cancel my subscription?" / "…my order?"** | **NO** | **0.1895** |
| "What is the refund policy?" / "…for enterprise plans?" | no | 0.3087 |
| "How do I get a refund?" / "What are your opening hours?" | no | 0.4950 |

**There is no threshold that works.**

- To catch the "money back" paraphrase you need a threshold above **0.26**. That same threshold serves the **negation pair (0.053)**, the **wrong error code (0.141)** and **order-vs-subscription (0.190)** from cache. A customer asking whether they can get a refund *after* 30 days would be told the answer for *within* 30 days — confidently, with citations, and fast.
- To exclude the negation pair you need a threshold below **0.053**. That excludes even the typo (0.136). At that point the "semantic" cache is an exact-match cache with extra steps.

**Why this happens.** An embedding measures **topical similarity** — "what is this text about". A cache needs **answer equivalence** — "would the correct answer be the same". Those are different properties. "After 30 days" and "within 30 days" are about exactly the same topic, so they embed almost identically; they just happen to have opposite answers. Nothing about cosine distance can see that, because the distinction lives in one small word that barely moves a 768-dimensional average.

This is the Phase 13 lesson again in a new shape: **measure the premise before building the feature.** Semantic caching is widely described as a standard pattern. On this model, for this kind of product, the naive version of it would be a machine for serving confident wrong answers.

---

## The diagnostic (Step 0)

**Result: 5 SOLID · 6 SHAKY · 1 UNKNOWN** — the strongest opening diagnostic of any RAG-related phase in this project by a wide margin (Phases 5, 6, 7 and 13 all opened at 0–1 SOLID). Caching is a general backend concept rather than a RAG-specific one, and it shows.

---

### Q1. Which paid/slow calls does `/ask` make, and which dominates?

**Your answer:** *"so doing semantic caching in redis can reduce extra llm calls and reduce latency at large scale. we can cache based on token limits like if any call is expensive we can cache it also we can cache last 2-3 messages of customer"*

**Score: SHAKY.** The purpose of caching is right. The question itself — *which* calls, and which dominates — was not answered, and two of the ideas point in unhelpful directions.

**The actual calls:** exactly two external ones, `embed` and `generate` (table above). Retrieval is a Postgres query against the local database — fast, and not external. Generation dominates at ~2 s against ~0.5 s.

**On "cache based on token limits":** the decision to cache should be about **whether an answer is reusable**, not how expensive it was to produce. An expensive answer to a one-off question is worthless in a cache; a cheap answer to a question asked a thousand times a day is the whole point.

**On "cache last 2-3 messages of the customer":** that is conversation *history*, which already lives in Postgres (Phase 11) and is fetched per request. Caching it would save one small indexed query. The expensive thing worth caching is the **generated answer**. (Q10 covers why history makes caching *harder*, not easier.)

---

### Q2. Exact-match vs semantic cache, with a pair that separates them.

**Your answer:** *"exact match is very rare because if only a single character is missing we won't find it in redis and have to call llm while caching semantic can be effective because we can check if query and the cache has both semantically close than we will answer from cache"*

**Score: SOLID.** Exactly the distinction. Measured pair for it: "How do I get a refund?" vs "How do i get a refnd?" — an exact-match cache misses (different strings), a semantic cache hits (distance **0.136**).

One refinement worth having: exact match gets much less brittle with **normalisation** before hashing — lowercase, trim, collapse whitespace, strip trailing punctuation. "How do I get a refund?" and "how do i get a refund" then share a key. That is cheap, has zero risk of a wrong answer, and captures a real share of repeats. It does not catch typos or paraphrases.

---

### Q3. What goes wrong if the similarity bar is too loose?

**Your answer:** *"maybe when the user query include some keys in query for ex: if user is asking for an error message like err-200 than in next query he ask about err-201 so we may consider them both semantically close and can return same old response"*

**Score: SOLID — and the best answer in the set.** This is Phase 13's finding (embeddings compress rare exact tokens) carried into a new context without being prompted. It is also now **measured**: `E-4021` vs `E-4022` sit at **0.141** — closer than three of the four genuine paraphrases in the table above.

The measurements found an even worse case you would want to name in an interview: **negation**. "Refund *after* 30 days" vs "*within* 30 days" at **0.053** — nearly identical embeddings, opposite answers. Other members of the same family: *can* vs *can't*, *before* vs *after*, *enable* vs *disable*, *monthly* vs *annual*, *subscription* vs *order*. In all of them the question's **topic** is shared and its **answer** is not.

---

### Q4. Does a semantic hit skip the embedding call, the generation call, or both?

**Your answer:** *"just the generation call because after user query we just have to embed it to match against cached embedding"*

**Score: SOLID.** Exactly right, with the correct reason: you cannot look up "the nearest cached question" without first having this question's embedding.

The practical consequence worth stating: a semantic-cache hit saves about **2 s of ~2.5 s**, not all of it. An **exact-match** hit is the only kind that skips *both* calls — you can look up a hash of the normalised text without embedding anything.

---

### Q5. Can plain Redis do the similarity lookup? If not, where else in this project?

**Your answer:** *"yes redis can do but we have to take care of embedding normalization"*

**Score: UNKNOWN** — the core claim is incorrect for this project, and it is the kind of thing worth being precise about because it drives an infrastructure decision.

**Checked directly against this project's Redis:**
```
image:          redis:7-alpine
MODULE LIST:    (empty)
FT._LIST:       ERR unknown command 'FT._LIST'
```

Plain Redis is a **key → value** store. `GET key` is an exact lookup; there is no command meaning "find the stored vector nearest to this one". Vector similarity search exists in **Redis Stack** — the RediSearch module, commands `FT.CREATE` / `FT.SEARCH` with vector fields — which is a different image (`redis/redis-stack`). Using it would mean adding infrastructure to this project.

**Where else in this project:** **Postgres, via pgvector — already running, already indexed.** Phase 7 added the `vector` type, Phase 8 an HNSW index. A table of cached questions with an `embedding vector(768)` column and its own HNSW index gives nearest-cached-question lookup with the exact `<=>` query this codebase already uses. No new infrastructure.

**On normalisation** — a real, adjacent point worth keeping. Cosine distance on unit-length vectors equals a simple function of the dot product, and some vector stores only offer dot-product or L2 distance, so callers normalise vectors to length 1 first. pgvector's `<=>` computes true cosine distance directly, so it is not needed here — but it is exactly the thing to check when moving to a different vector store.

---

### Q6. A new document changes the refund policy. How do you avoid serving the stale cached answer?

**Your answer:** *"so when user will upload new doc we will invalidate all old cached data"*

**Score: SHAKY.** The strategy is correct, and it is the one this phase should use: when the knowledge base changes, everything cached for that workspace is suspect. Two things are missing.

**1. More than upload.** A cached answer goes stale whenever the set of chunks retrieval can see changes: a document finishing embedding (`status → ready`), a document being **deleted**, a document being **reprocessed**. The trigger is "the workspace's searchable content changed", not "someone uploaded".

**2. The mechanism.** "Invalidate all" is easy to say and awkward to do in Redis: there is no "delete every key belonging to workspace 7" command. `KEYS workspace:7:*` blocks the whole server while it scans (never use it in production); `SCAN` + `DEL` works but is slow and non-atomic.

**The standard technique is a version number in the key.** Keep one small counter per workspace — `kb_version:7 = 12` — and put it *in* every cache key: `answer:7:v12:<hash>`. When the knowledge base changes, increment the counter to 13. Every lookup now builds keys containing `v13`, so every old `v12` entry becomes **unreachable instantly**, in one atomic `INCR`, with no scan and no delete. The orphaned entries then disappear by themselves when their TTL expires. That is why TTL and versioning are used **together** (Q7).

---

### Q7. TTL vs explicit invalidation — what does each protect against, and fail to?

**Your answer:** *"ttl will remove the cached based on time we set while cache invalidation is the manual deletion that we have to do when something gets added or updated"*

**Score: SHAKY.** The definitions are right. The question asked for what each **protects against** and **fails to protect against**, which is the part that decides a design.

| | Protects against | Fails to protect against |
|---|---|---|
| **TTL** | unbounded growth; staleness from changes you **did not know to invalidate** for | serving stale data for the whole TTL window after a change you *did* know about |
| **Explicit invalidation** | staleness from known changes — fixed immediately | any change with no invalidation hook: a code path someone forgot, a prompt or model change, a manual DB edit |

**They are complements, not alternatives.** Explicit invalidation (the version bump) makes known changes take effect immediately. TTL is the safety net that bounds the damage from the changes nobody wired an invalidation for — and it also garbage-collects the orphaned keys the version bump leaves behind.

A worthwhile addition: **things other than documents also change answers.** The system prompt, the generation model, the temperature, the confidence threshold. Putting a **prompt/model version** in the key as well means deploying a prompt change cannot serve answers generated under the old one.

---

### Q8. What must be in the key so workspaces never share cached answers?

**Your answer:** *"workspace id"*

**Score: SOLID.** Correct, and the most important field in the key. Without it, Northwind's cached refund policy is served to Acme's customers — a cross-tenant data leak through the cache instead of through a query, the same class of bug `WorkspaceGuard` has guarded against since Phase 2.

The full key, once Q6, Q7 and Q10 are folded in, looks like:

```
answer : {workspaceId} : v{kbVersion} : p{promptVersion} : {sha256(normalisedQuestion)}
```

Every component is there because leaving it out causes a specific wrong answer.

---

### Q9. Which of `answered` / `refused` / `escalated` should be cached?

**Your answer:** *"only answered because refuse does not do any llm call and escalation will give same error all the time if we will cache it but that error can be temporary"*

**Score: SOLID.** Both reasons are right, and the escalation one is exactly the argument that matters.

- **`escalated`** happens only when generation *failed* (Phase 10). Caching it would turn a transient outage into a persistent one: Gemini recovers in 30 seconds, and the cache keeps telling customers "I'm having trouble" for the whole TTL. Never cache a failure as though it were an answer.
- **`refused`** skips the generation call already, so caching it saves only the embedding and retrieval. And it is the outcome most likely to become wrong: a refusal means "we have no document about this", which is exactly what uploading a new document fixes. The version bump would handle that — but there is little to gain from caching it in the first place.

---

### Q10. Is an answer produced with conversation history safe to cache for a different customer?

**Your answer:** *"we have to also include session key while caching"*

**Score: SHAKY.** That is **safe** — it guarantees no customer ever sees an answer shaped by someone else's conversation. But it quietly defeats the cache: session ids are unique per visitor, so a session-keyed entry can only ever be hit by the same visitor asking the same thing twice. The hit rate collapses to roughly zero.

**The underlying principle:** a cache key must capture **every input that affects the output**. With history, the answer is a function of *(question, prior turns, retrieved chunks)*. "What about the enterprise plan?" means something entirely different depending on what came before — and none of that is in the question's text or its embedding.

**The practical design:** cache only turns where **no history was used** — in this codebase, the turns where `fetchRecentHistory` returned nothing. That is also where caching pays off most: the first question of a session is the one most likely to be a common, standalone question ("how do I reset my password?"), while follow-ups are the most conversation-specific.

---

### Q11. 200 identical new questions arrive in the same second. What happens?

**Your answer:** *"this is cache stampede, but we have to call llm for every user query"*

**Score: SHAKY.** Named correctly. The second half is the problem, not the conclusion: without protection all 200 miss, and all 200 call Gemini. With a 20/day quota, one stampede can exhaust the whole day's generation budget in a second and put the product into permanent escalation.

**The fix is request coalescing ("single-flight").** Only the first miss for a given key does the work; the other 199 wait for its result.

- **Within one process:** keep a map of *key → in-flight Promise*. A second request for the same key awaits the existing promise instead of starting a new call.
- **Across processes:** a short-lived Redis lock — `SET lock:<key> 1 NX PX 10000` succeeds for exactly one caller. Others briefly poll the cache or wait on the lock. The TTL on the lock matters: if the lock-holder crashes, the lock must expire rather than block that question forever.

A related trick worth naming: **TTL jitter**. If 10,000 entries are written in the same minute with identical TTLs, they all expire in the same minute and cause a synchronised stampede. Randomising TTLs by ±10% spreads expiry out.

---

### Q12. How would you know the cache is helping — and how would you know it's hurting?

**Your answer:** *"maybe based on the latency"*

**Score: SHAKY.** Latency is one real signal. The question has two halves, and the second is where caches actually fail.

**Is it helping?**
- **Hit rate** — hits ÷ lookups. The single most important number; a cache at 3% is overhead, not an optimisation.
- **Latency split** — p50/p95 for hits vs misses. A hit should be dramatically faster.
- **Generation calls avoided** — directly in quota and money.

**Is it hurting?** — the harder half, and the one this phase's measurements show is a real risk here:
- **False-hit rate** — how often a cached answer is *wrong for the question actually asked*. Latency and hit rate cannot see this at all; a cache serving the wrong answer 20% of the time looks **better** on both.
- The way to measure it is to **sample hits and compare**: for a fraction of hits, also generate fresh, and compare the two answers. That is an evaluation problem — exactly what Phase 17 (Evaluations) is for.
- Proxy signals: escalation or "that didn't answer my question" rates after a cache hit vs after a miss.

**The general lesson:** *a cache is a correctness risk you accept in exchange for speed, so measure the correctness side too.* Most cache dashboards only measure the speed side.

---

## Topics you must know before moving on, ranked by how load-bearing they are

1. **Topical similarity ≠ answer equivalence** (Q3, the measurement table) — the reason a naive semantic cache is dangerous here. Everything in the design follows from it.
2. **A cache key must capture every input that changes the output** (Q8, Q10) — workspace, knowledge-base version, prompt version, and the absence of history.
3. **Versioned keys for invalidation, TTL as the safety net** (Q6, Q7) — O(1) invalidation without scanning, and why the two are used together.
4. **Never cache a failure as an answer** (Q9) — the escalation case.
5. **Stampede protection by request coalescing** (Q11).
6. **Measure false hits, not just hit rate** (Q12).
7. **Where vector similarity can actually run** (Q5) — plain Redis cannot; pgvector already can.

---

---

## Architecture and decisions

The measurement table decided the headline: **serve only what can be proven to be the same question, and learn about everything else without acting on it.** Four decisions, agreed before any code was written.

### Decision 1 — serve exact-normalised hits only; run the semantic tier in shadow mode

| Option | Serves | Risk | Hit rate |
|---|---|---|---|
| **A. Exact-normalised** *(chosen)* | same text after lowercase / whitespace / trailing punctuation | none from similarity | modest |
| B. Semantic, threshold ≈ 0.27 | paraphrases | serves the negation pair (0.053), `E-4022` (0.141), order-vs-subscription (0.190) | high |
| C. Semantic, threshold ≈ 0.03 | effectively exact | none | ≈ A, but pays an embedding first |

The semantic tier is **built, but never serves**. On every eligible miss it finds the nearest earlier answer and records it. That is how a risky cache is evaluated in production: gather real false-hit data before switching anything on. It is also exactly the dataset Phase 17 needs.

Two ways to make B safe were considered and rejected on paper. **Retrieval-fingerprint matching** fails on the negation pair, because both questions retrieve the same refund chunk. **An LLM judge** ("are these the same question?") costs a generation call — the very thing the cache exists to avoid.

### Decision 2 — the knowledge version lives in Postgres, not Redis

Under memory pressure an LRU eviction policy can evict the **counter** while keeping the **entries**. The counter would restart at 0, climb back to 12, and resurrect answers cached against a knowledge base that has since changed — silently. A column on `workspaces` cannot be evicted. The cost is one primary-key read per `/ask`.

### Decision 3 — shadow data lives on `conversations`

Every real answer is already persisted there (Phase 10), so "have we answered something like this before" becomes a query over the log that already exists. Proposed as three columns; **built as six**, because a candidate only counts if a real cache could legally have served it — which needs the knowledge version, the prompt version, and whether the prior row was an original history-free answer.

### Decision 4 — stampede protection is a Redis lock, not an in-process map

An in-process map is correct for exactly one API instance — the same limitation `AgentPresenceService` documents. A Redis `SET NX PX` lock is correct across many, and costs one extra round trip on a miss.

---

## Complete data flow

```
POST /ask { question, sessionId? }
   │
   ├─ identity = workspaces(public_key, knowledge_version)          one PK read
   ├─ key = answer:{ws}:{publicKey}:v{kb}:p{PROMPT_VERSION}:{sha256(normalise(q))}
   ├─ hasHistory = sessionId ? exists(prior turn in this session) : false
   │
   ├─ hasHistory ──yes──► pipeline, cache:'bypass'   (never read, never written, no shadow)
   │
   ├─ Redis GET key ──hit──► persist turn, return cache:'hit'
   │                          (NO embedding, NO generation, 0 tokens reported)
   │
   ├─ SET lock:{key} <token> NX PX 15000
   │     held ──► poll every 100ms ── entry appears ──► serve as hit
   │                               └─ lock vanishes / 10s budget ──► fall through
   │
   └─ pipeline   (try … finally: release lock by token)
        ├─ embed + hybrid retrieve                     (returns queryEmbedding)
        ├─ SHADOW: nearest eligible prior conversation → record id + distance
        ├─ confident?  no  ──► refused  (never cached)
        ├─ generate    fail ─► escalated (never cached)
        ├─ SET key EX 86400 ± 10%
        └─ persist turn: embedding, kb/prompt version, cache_outcome, shadow fields

Invalidation (UPDATE workspaces SET knowledge_version = knowledge_version + 1):
   chunks replaced ─┐
   document ready  ─┼─► every old key unreachable in one statement
   document deleted ┘
```

---

## Migrations: what each table and column actually stores

### `AddKnowledgeVersionToWorkspaces` — `workspaces`

**`knowledge_version` (`integer`, NOT NULL, default 0)** — how many times this workspace's searchable content has changed. Not a count of documents: it rises every time the set of chunks retrieval can see changes, which for one upload is **twice** (once when chunks are written, because keyword search sees them immediately through `content_tsv`; once at `ready`, when vector search catches up). It exists purely to be part of the cache key, so that incrementing it makes every earlier cached answer unreachable without scanning or deleting anything.

### `AddShadowCacheColumnsToConversations` — `conversations`

| Column | Stores |
|---|---|
| `question_embedding` `vector(768)` | The question's own embedding, reused from retrieval (no extra API call). NULL on a cache hit, which embeds nothing. Not selected by default in the entity — 768 floats should not ride along on every transcript query. |
| `knowledge_version` `integer` | The knowledge version the answer was produced under. An answer is only a valid shadow candidate at the **current** version. |
| `prompt_version` `integer` | `ANSWER_PROMPT_VERSION` at the time. Same reasoning — a changed prompt invalidates old answers. |
| `cache_outcome` `varchar(8)` | `hit` / `miss` / `bypass`. `miss` means "an original, history-free, generated answer" — the only kind a cache could ever legally serve. Also the cheapest possible source for hit-rate reporting. |
| `nearest_prior_conversation_id` `integer` | Self-referencing FK (`ON DELETE SET NULL`): the earlier conversation a semantic cache **would** have served. NULL when no eligible candidate existed. |
| `nearest_prior_distance` `double precision` | How far away that candidate was. The number that, across real traffic, answers "is a semantic tier ever safe here?" |

Plus **`IDX_conversations_question_embedding_hnsw`** — an HNSW index with `vector_cosine_ops`, identical in shape to the Phase 8 index on chunks.

---

## Code walkthrough

### `src/cache/answer-cache.service.ts` (new, top-level shared infra)

**`normalizeQuestion`** — lowercase, NFKC, collapse whitespace, strip trailing `?!.`. **Internal punctuation is kept on purpose**: `E-4021` ≠ `E4021`, `can't` ≠ `cant`. Every loosening of this function is a step toward serving wrong answers.

**`buildKey`** — each component exists because omitting it causes a specific wrong answer. `publicKey` is the non-obvious one: integer ids **can** be reused (a `RESTART IDENTITY`, a restored backup — and this project's own test harness, between every test, while Redis persists), so a new "workspace 1" would inherit the old one's cache. The test suite deliberately never cleans Redis, which makes every test an implicit proof of this.

**`get` / `set`** — fail **open** with a 250 ms timeout. The opposite of Phase 11's allowlist, which fails closed, because the costs differ: a security check that errors must deny; a cache that errors should simply not be used. The timeout matters because ioredis queues commands while disconnected — without it, a Redis outage becomes seconds added to every `/ask`. Failures are logged, not swallowed.

**`AnswerCacheLocks`** — `acquire` is `SET lock:{key} <token> PX 15000 NX`. `release` is a Lua compare-and-delete: only delete if the value is still *our* token, in one atomic step. `waitForEntry` polls every 100 ms and stops the moment the lock disappears, not only when the 10 s budget runs out.

**`findShadowCandidate`** — the `WHERE` clause is the substance: same workspace, knowledge version and prompt version; `status = 'answered'`; `cache_outcome = 'miss'`. Anything else would measure matches no real cache could ever serve.

### `answer.service.ts` — `answer()`

1. Read identity, build the key, check whether the turn has history. **This relaxes Phase 11's "fetch history only when it will be used" rule**, because a lock waiter has to know before it waits. Kept cheap: an id-only existence query that *replaces* the history fetch on first turns.
2. History → straight to the pipeline as `bypass`.
3. Cache read → hit served with 0 tokens.
4. Lock; if held, wait; if the entry never comes, do the work anyway.
5. `try { pipeline } finally { release }` — `finally` so an exception frees the lock too.

`runPipeline` runs the shadow lookup **before** the refuse/answer branch. A semantic cache serving a cached *answer* to a question fresh retrieval would *refuse* is one of the most important failure modes to measure, and it only appears if refused turns are recorded as well.

### Invalidation hooks
`DocumentProcessingProcessor` (after chunk replace), `DocumentEmbeddingProcessor` (at `ready`), `DocumentsService.remove`. Bumping too often costs misses; bumping too rarely serves answers grounded in content that no longer exists — so every path that changes searchable content bumps.

### Frontend
The Playground inspector's tiles are the prototype's exact four again — **Search mode / Top k / Cache / Model**. The Cache slot had shown the confidence threshold since Phase 12, because no cache existed and "Miss" would have described a system that didn't. A hit's meta line reads `· cached` rather than `· 0 tokens`.

Fixed in passing: the inspector footer said *"the closest match was outside the confidence threshold"* whenever `promptTokens` was null — which was also true for **escalations**, where the model was called and failed. It now branches on what actually happened.

---

## Failure cases actually tested

1. **Redis frozen mid-traffic (`docker pause`).** Chosen over stopping Redis because a paused container keeps the TCP connection open and never replies — the hang the timeout exists for, not a clean refusal.

   | Prediction | Result |
   |---|---|
   | `/ask` still answers | ✅ `201`, a real answer |
   | ~500 ms added, not a hang | ✅ 4.43 s vs a normal ~4.1 s miss |
   | `cache: miss` | ✅ |
   | a timed-out write might still land | ✅ **it did** — right after unpausing, the same question was a **hit** in 25 ms |
   | `/auth/login` would hang | ✅ **hung the full 12 s**, then the client gave up |

2. **The ghost lock — a real bug, found by #1, not predicted.** The lock request had also landed late. The request had already been told `unavailable`, so it never released it, and the lock sat ownerless for its 15 s TTL. Had that turn been a refusal (nothing to cache), every waiter on the same question would have sat out the full 10 s budget. **Fix:** `unavailable` now carries its token and is released too. Because commands on one connection execute in order, the compare-and-delete queues *behind* the late `SET` and removes it; the token check makes it harmless otherwise. Regression test added, and **proven to fail with the fix reverted** (`Expected: 0, Received: 1`).

   The transferable lesson: **a client-side timeout does not cancel an operation already sent to the server.** Anything you stop waiting for may still happen.

3. **A stampede, with its premise proven.** 20 concurrent identical questions → exactly **1** embedding and **1** generation call, 1 `miss` + 19 `hit`, 20 conversation rows. The premise test disables the lock and gets **20** generation calls — without it, the first test could pass on accidental serialisation and prove nothing.

4. **Waiters behind a refusal.** 10 concurrent refused questions finished in ~2 s, against a 10 s wait budget — the "lock gone, stop waiting" check working.

5. **Lock ownership.** A's lock replaced by B's (simulating expiry + reacquire); A releases with its stale token → returns `false`, B's lock survives.

6. **The negation pair, with real embeddings.** Shadow log recorded `nearest = #1, distance 0.0534` for "refund *after* 30 days" against "refund *within* 30 days" — and the customer received a freshly generated answer. The password paraphrase recorded `0.2314`. Both reproduce the diagnostic probe exactly, so the embeddings are deterministic and the data is trustworthy.

---

## The tests, and why each exists

**`test/answer-cache.e2e.spec.ts`** — 17 tests, counting substitute providers (the only way to prove a hit calls *nothing*), real retrieval SQL, real Redis.

| Test | Why |
|---|---|
| normalisation collapses only meaning-free differences | `E-4021` ≠ `E4021` and `can't` ≠ `cant` are asserted, so loosening normalisation fails a test |
| a normalised repeat calls **neither** provider | "fast" proves nothing; zero calls proves the short-circuit |
| a different question is not served | the negation pair, against the exact tier |
| another workspace never hits | tenant isolation through the cache |
| a reused integer workspace id does not inherit a cache | the `publicKey` decision |
| refusals never cached | "no document covers this" is the answer an upload invalidates |
| escalations never cached | a transient outage must not become a persistent one |
| history turns bypass, in both directions | never written, and never *served* into a conversation |
| 20 concurrent → 1 call / the same burst with no lock → 20 | the stampede, and its premise |
| waiters stop when the holder finishes without caching | the refused-question stall |
| a lock that landed late is cleaned up | the ghost lock from the break-it step |
| release never deletes someone else's lock / mutual exclusion + TTL | the lock's two safety properties |
| document delete invalidates / a bump makes old entries unreachable without deleting them / jittered 24 h TTL | invalidation and expiry |

**`test/answer-cache-shadow.e2e.spec.ts`** — 6 tests, **real Gemini embeddings** (fake vectors would put every question at distance 0), counting generation stub.

| Test | Why |
|---|---|
| the negation pair is recorded at < 0.1 and a fresh answer is served | the case the whole design rests on |
| a paraphrase is recorded in 0.1–0.4, still not served | what a semantic tier could gain |
| only legally-servable candidates are measured | follow-ups are neither looked up nor used as candidates |
| a knowledge-version bump removes every earlier candidate | shadow obeys the same rules as the cache |
| another workspace's conversations are never candidates | isolation |
| a hit stores no embedding and runs no lookup | a hit embeds nothing |

---

## Reverse-engineering guide

1. **Start with the measurement table at the top of this doc.** Every design choice follows from "no threshold separates paraphrases from opposite answers". Without it, an exact-only cache looks timid.
2. **Then `answer()` in `answer.service.ts`** — the whole flow is visible in about forty lines.
3. **Stale answer being served?** Check whether the change that should have invalidated it goes through one of the three `bumpKnowledgeVersion` call sites. A new code path that changes chunks without bumping is the most likely future bug.
4. **Changed the prompt, model or threshold?** Bump `ANSWER_PROMPT_VERSION`, or old answers stay live for up to 24 h.
5. **Want to know if a semantic tier is ever safe?** Query the shadow data:
   ```sql
   SELECT width_bucket(nearest_prior_distance, 0, 0.5, 10) AS bucket, count(*)
   FROM conversations WHERE nearest_prior_distance IS NOT NULL
   GROUP BY 1 ORDER BY 1;
   ```
   Then read, by hand, a sample of pairs from the low buckets and check whether their answers really match. That comparison is Phase 17's job.
6. **Requests slow during a Redis blip?** Look for leftover `lock:*` keys (`redis-cli --scan --pattern 'lock:*'`).

---

## Interview questions this phase generates

1. What is the difference between an exact-match and a semantic cache, and when is a semantic cache dangerous?
2. Why doesn't a semantic-cache hit skip the embedding call?
3. How would you invalidate every cached entry for one tenant in Redis without scanning keys?
4. TTL versus explicit invalidation — what does each protect against, and why use both?
5. What is a cache stampede, and how do you prevent one across multiple servers?
6. Why must a distributed lock's release check a token, and why must that check be atomic?
7. Why should a cache fail open while a security check fails closed?
8. A client-side timeout fires on a Redis `SET`. Did the write happen?
9. Why would you never cache an error response?
10. How do you measure whether a cache is *hurting* you, not just whether it is fast?
11. Why store a knowledge-version counter durably rather than next to the cache entries?

---

## What's still not understood / open items

- **Whether a semantic tier is ever safe here.** The shadow data now accumulates; it has not yet been evaluated. Phase 17.
- **Thundering herd against a failing provider.** When Gemini is down, the lock holder escalates and releases, and every waiter falls through and calls the failing provider too. The fix is a **circuit breaker** — a separate pattern from caching.
- ~~**`/auth/login` and the widget rate limiter hang when Redis hangs.**~~ **Resolved — see "Rate limiters: the fail-mode decision" below.**
- **Hit rate is modest by design.** Exact-normalised matching catches repeats, not paraphrases. That is the price of never serving the negation pair.
- **One extra query per request** (identity read) and, on every miss, one extra vector query plus a 768-dim write.
- **The `timestamptz` open item from Phase 13 still stands.**

---

## Rate limiters: the fail-mode decision (found by this phase's break-it step)

The Redis freeze showed `/auth/login` hanging for the full 12 seconds. Phase 2's `LoginThrottleGuard` and Phase 11's `WidgetRateLimitGuard` both called Redis with no timeout. Fixing it needed a product decision, which was put to the user rather than made silently: **when Redis is down, should a security rate limiter fail open or fail closed?**

**Decision (user, 2026-09-28): fail open — keep login available.** This matches industry practice: Envoy's global rate limiter, for example, defaults `failure_mode_deny` to false. A rate limiter protects the service; it must not become the thing that takes the service down, and failing closed turns a cache blip into a full login outage.

**The production-grade refinement: fail open to a *weaker* limit, not to none.** An attacker who notices — or causes — a Redis outage must not get unlimited guesses. So the shared `FixedWindowRateLimiter` (`src/common/rate-limit/`) does three things:
1. **Times out** the Redis call at 250 ms.
2. **Falls back to an in-process counter** per API instance. Weaker (N instances allow N × limit), but protection degrades rather than disappears.
3. **Warns**, throttled to once per 10 s so an outage cannot flood the logs.

For login there is a further independent layer regardless: bcrypt at 12 rounds costs ~250 ms per attempt.

**A second, older bug fixed on the way — never observed, found by reading the code.** Both guards issued `INCR` and then `EXPIRE` as two separate commands. A crash between them leaves a counter with no expiry — for the login throttle, that permanently locks one email+IP pair out. Both steps now run in one atomic Lua script, and a test asserts the first hit always carries its TTL.

**Verified live with Redis frozen (`docker pause`):**

```
attempts 1–5: 401 in 0.26–0.46 s    (before this fix: hung 12 s)
attempts 6–7: 429 in ~0.26 s        (still rate-limited, by the in-process fallback)
```

Tests: `src/common/rate-limit/fixed-window-rate-limiter.spec.ts` — real-Redis counting and limiting, the atomic TTL, and against a never-resolving client: answers within the timeout, still enforces the limit while degraded, and the local window resets rather than becoming a lockout. The existing Phase 2 (`6th attempt → 429`) and Phase 11 widget rate-limit tests pass unchanged.

The general lesson, worth having in an interview: **the right failure mode depends on what the component protects, and "open" versus "closed" is rarely binary.** A cache fails fully open. An allowlist that decides *who may connect* (Phase 11) fails closed. A rate limiter, which defends the service's availability, fails open to a degraded limit.

---

# Closing quiz (Step 7)

**Result: 0 SOLID · 5 SHAKY · 9 UNKNOWN** (opening diagnostic: 5 / 6 / 1).

This is the same shape as Phases 2 and 11: a strong opening and a much weaker close. It is not a regression in ability. The two quizzes measured different things:

- **The opening measured general caching intuition** — what a stampede is, why workspace id belongs in a key, why an escalation must not be cached. You had that cold.
- **The closing measured the specific mechanisms this phase built** — why `publicKey` is in the key, why a lock needs a token, what a timeout does *not* do. Every one of those was written by Claude, not by you.

Phase 13 showed the same thing from another angle: the topics that moved between quizzes were the ones you had to reason about yourself, while topics that were only read about did not. **For you, reading about a mechanism does not make it stick; building it does.** Each explanation below therefore walks through the actual code, line by line, with a concrete trace of what happens.

Two answers moved genuinely in the right direction compared with the opening, and are worth noticing:
- **Q2** — "we need Redis Stack" is correct and new. At the opening you said plain Redis could do it.
- **Q3** — "update the version" is the correct invalidation mechanism, and it was not in your opening answer at all.

---

### Q1. The two external calls, which dominates, and what does an exact hit skip?

**Your answer:** *"embed and generate, embed will run but not generate"*

**Score: SHAKY.** Both calls correctly named. But the part about the hit is the wrong way round for **this** cache, and which call dominates was not answered.

**What is right.** The two external calls in `/ask` really are `EmbeddingProvider.embed()` and `AnswerGenerationProvider.generate()`. Retrieval itself is a Postgres query on the local database — not external.

**What is wrong, and why it matters.** "Embed runs but generate doesn't" is exactly correct for a **semantic** cache — you answered the opening diagnostic's Q4 that way and scored SOLID for it, because you cannot find "the nearest cached question" without first embedding this one. But this project serves only from an **exact-match** cache, and an exact-match key needs no embedding at all — just a hash of the text:

```ts
// src/cache/answer-cache.service.ts
buildKey(identity: WorkspaceCacheIdentity, promptVersion: number, question: string): string {
  const hash = createHash('sha256').update(normalizeQuestion(question)).digest('hex');
  return `answer:${identity.workspaceId}:${identity.publicKey}:v${identity.knowledgeVersion}:p${promptVersion}:${hash}`;
}
```

`sha256` of a string is a local CPU operation taking microseconds. No API call. So the order inside `answer()` is:

```ts
// src/modules/answer/answer.service.ts — answer()
const cached = await this.answerCache.get(cacheKey);          // Redis GET, local, ~1 ms
if (cached) return this.serveHit(workspaceId, question, sessionId, cached, identity);

// only a MISS ever reaches this line:
const { chunks, queryEmbedding } = await this.retrievalService.retrieveRelevantChunks(workspaceId, question);
```

A hit returns **before** retrieval — and retrieval is where the embedding happens. So an exact hit skips **both** calls. The test proves it by counting calls rather than timing them:

```ts
// test/answer-cache.e2e.spec.ts
const second = await ask(token, workspaceId, '  how long do refunds TAKE ');
expect(second.body).toMatchObject({ status: 'answered', cache: 'hit' });
expect(calls).toEqual({ embed: 1, generate: 1 });   // unchanged from the FIRST request
```

**Which dominates** — measured from this machine:

| Call | Time |
|---|---|
| embed | 391–593 ms warm, 1280 ms cold |
| **generate** | **1748–2141 ms** |

Generation is ~75% of the external time, and it is also the scarce one: 20 calls/day on the free tier versus 1000 for embeddings. In the browser, the same question went **4.1 s → ~0 s** on a hit.

**Interview one-liner:** *An exact-match cache skips every downstream call because its key is a hash of the input; a semantic cache still has to pay for the embedding, because its key is the embedding.*

---

### Q2. Could this Redis find the nearest cached question? How was that checked, and where can the lookup run?

**Your answer:** *"we need redis stack for that because we cannot store embedding in plain redis, db"*

**Score: SHAKY — real improvement.** At the opening you said plain Redis could do it. Now you correctly name Redis Stack and a database. One detail in the reason is off, and "how I checked" was not answered.

**The imprecise part.** Plain Redis **can store** an embedding — 768 floats serialise happily into a string or a byte array, and `SET key <bytes>` works. What plain Redis cannot do is **search** those values by similarity. Its data model is key → value: `GET key` retrieves exactly one known key. There is no command meaning "give me the value nearest to this vector". That capability is RediSearch, which ships in Redis Stack, via `FT.CREATE` (define a vector index) and `FT.SEARCH` (KNN query).

**How it was checked**, rather than assumed:

```
$ cat docker-compose.yml                          → image: redis:7-alpine
$ docker exec anchor-redis-1 redis-cli MODULE LIST → (empty)
$ docker exec anchor-redis-1 redis-cli FT._LIST    → ERR unknown command 'FT._LIST'
```

Three independent facts: the image is plain Redis, no modules are loaded, and the RediSearch command family does not exist.

**Where the lookup actually runs — Postgres, via pgvector**, which this project already had from Phases 7–8. The shadow tier uses it:

```sql
-- src/cache/answer-cache.service.ts — findShadowCandidate()
SELECT id, question_embedding <=> $1::vector AS distance
FROM conversations
WHERE workspace_id = $2 AND knowledge_version = $3 AND prompt_version = $4
  AND status = 'answered' AND cache_outcome = 'miss' AND question_embedding IS NOT NULL
ORDER BY question_embedding <=> $1::vector
LIMIT 1
```

backed by the HNSW index created in this phase's migration:

```sql
CREATE INDEX "IDX_conversations_question_embedding_hnsw"
ON "conversations" USING hnsw ("question_embedding" vector_cosine_ops)
```

So the design splits the work between the two stores by what each does well: **Redis holds exact-match answers** (fast, native TTL, key → value), **Postgres holds embeddings** and answers "nearest". Neither needs a new image.

**Interview one-liner:** *Plain Redis is a key-value store — it can hold vectors but cannot search them; vector similarity needs RediSearch (Redis Stack) or a vector database such as pgvector.*

---

### Q3. How does a document upload invalidate every cached answer without scanning or deleting keys?

**Your answer:** *"we will update the caches content version and it will be invalidate itself after ttl"*

**Score: SHAKY.** "Update the version" is exactly the mechanism, and new since the opening. But "invalidate itself after TTL" merges two separate things. The version makes old entries unreachable **immediately**; TTL only cleans them up later.

**Step 1 — the version is part of every key.**

```ts
return `answer:${identity.workspaceId}:${identity.publicKey}:v${identity.knowledgeVersion}:p${promptVersion}:${hash}`;
//                                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**Step 2 — every request reads the current version first.**

```ts
// answer.service.ts
const identity = await this.answerCache.getIdentity(workspaceId);   // SELECT public_key, knowledge_version ...
const cacheKey = identity ? this.answerCache.buildKey(identity, ANSWER_PROMPT_VERSION, question) : null;
```

**Step 3 — a change increments it, in one statement.**

```ts
// answer-cache.service.ts
async bumpKnowledgeVersion(workspaceId: number): Promise<void> {
  await this.dataSource.query(
    `UPDATE workspaces SET knowledge_version = knowledge_version + 1 WHERE id = $1`,
    [workspaceId],
  );
}
```

**Trace it.** Workspace 7 is at version 12:

```
cached earlier : answer:7:ab12..:v12:p1:<hash of "how long do refunds take">
new document   : UPDATE ... knowledge_version = 13
next request   : builds   answer:7:ab12..:v13:p1:<same hash>
                 → Redis GET on the v13 key → nothing there → MISS → fresh answer
```

The `v12` entry was never deleted. It is still physically in Redis — but no request will ever build a key containing `v12` again, so it is **unreachable instantly**. A test asserts exactly that:

```ts
// test/answer-cache.e2e.spec.ts
await answerCache.bumpKnowledgeVersion(workspaceId);
expect(await redis.exists(oldKey)).toBe(1);                                          // still there...
expect((await ask(token, workspaceId, 'How long do refunds take?')).body.cache).toBe('miss'); // ...but unreachable
```

**So where does TTL come in?** Only as **garbage collection**. The orphaned `v12` entry would otherwise sit in Redis forever, consuming memory. Its 24-hour TTL deletes it eventually. TTL is not what invalidates it — the version bump did that the moment it ran. If there were no TTL, you would still never serve a stale answer; you would just slowly fill Redis with dead keys.

**Why not just delete the keys?** Redis has no "delete everything belonging to workspace 7" command. `KEYS answer:7:*` scans the entire keyspace and **blocks the whole server** while it runs — never used in production. `SCAN` + `DEL` does not block, but is slow and non-atomic, so answers can be served mid-invalidation. One `UPDATE` avoids all of it.

**Interview one-liner:** *Put a version counter in the cache key and increment it — every old entry becomes unreachable in O(1), with no scan and no delete; TTL then garbage-collects the orphans.*

---

### Q4. TTL and explicit invalidation — what does each protect against that the other doesn't?

**Your answer:** *"so we only invalidates when the document is deleted but on upload or update we update the version and it will be invalidate by itself after ttl"*

**Score: UNKNOWN.** Two misconceptions here, and the question itself (what each protects against) was not answered.

**Misconception 1 — delete is not handled differently.** All three events bump the version the same way. The three call sites, exactly:

```ts
// 1. src/modules/documents/documents.service.ts — remove()
await this.documents.remove(document);
await this.answerCache.bumpKnowledgeVersion(workspaceId);

// 2. src/modules/documents/processing/document-processing.processor.ts — after chunks are replaced
await this.answerCache.bumpKnowledgeVersion(document.workspaceId);

// 3. src/modules/documents/processing/embedding/document-embedding.processor.ts — at 'ready'
await this.documents.update(documentId, { status: DocumentStatus.READY, readyAt: () => 'now()' });
await this.answerCache.bumpKnowledgeVersion(document.workspaceId);
```

**Misconception 2 — TTL is not how uploads are invalidated.** See Q3: the bump invalidates immediately; TTL only cleans up.

**Why an upload bumps twice.** Look at *when* the searchable content actually changes during one upload:

| Moment | What retrieval can now see | Bump? |
|---|---|---|
| chunks written | keyword search sees them **immediately** — `content_tsv` is a generated column, filled on insert | ✅ #2 |
| embeddings finish (`ready`) | vector search sees them too | ✅ #3 |

An answer cached *between* those two moments was grounded in a half-indexed knowledge base. Bump #3 kills it. Bumping too often costs only cache misses; bumping too rarely serves wrong answers — so every path that changes searchable content bumps.

**The actual question — what each protects against:**

| | Protects against | Fails to protect against |
|---|---|---|
| **Explicit invalidation (version bump)** | known changes — takes effect **instantly** | any change nobody wired a bump into: a new code path that edits chunks, a manual `psql` fix, a prompt change someone forgot to version |
| **TTL (24 h ± 10%)** | the **unknown** changes above — the worst-case staleness is bounded to one day; also garbage-collects orphaned keys | known changes — on its own it would serve a stale answer for up to 24 hours after you *knew* it changed |

**They cover each other's blind spots.** The bump handles everything you remembered; TTL puts a ceiling on the damage from everything you didn't.

There is a third, related key component for changes that are not about documents at all:

```ts
// answer.service.ts
// Bump it whenever anything that shapes a generated answer changes — the system prompt, the model,
// the temperature, the confidence threshold — so a deploy can never serve answers produced under
// the previous behaviour.
export const ANSWER_PROMPT_VERSION = 1;
```

**Interview one-liner:** *Explicit invalidation handles the changes you know about, instantly; TTL bounds the staleness from the ones you don't. Production caches use both.*

---

### Q5. Why is a turn with history never served or written? Why isn't keying by session the fix?

**Your answer:** *"dont know"* — **UNKNOWN** (you scored SHAKY on this at the opening, where you proposed keying by session).

**The rule a cache key must follow:** the key must capture **every input that changes the output**. If two requests produce the same key but should get different answers, the cache serves one of them the wrong answer.

**What the answer depends on.** Look at how the prompt is built:

```ts
// answer.service.ts — runPipeline()
const history = hasHistory && sessionId ? await this.fetchRecentHistory(workspaceId, sessionId) : [];
const systemPrompt = buildSystemPrompt(chunks, history);
generated = await this.generationProvider.generate(systemPrompt, question);
```

The answer is a function of **(question, history, chunks)**. The cache key contains only the question. Once history is non-empty, the key is missing an input.

**A concrete trace of the bug this prevents.**

```
Visitor A:  "Do you have an enterprise plan?"            → "Yes, from $499/month."
Visitor A:  "What about refunds on it?"                  → answer about ENTERPRISE refunds (30 days)
                                                            — "it" means the enterprise plan
Visitor B:  "Do you have a starter plan?"                → "Yes, $19/month."
Visitor B:  "What about refunds on it?"                  → same words, same hash, same key!
```

If A's follow-up had been cached, B would be told the **enterprise** refund terms about the **starter** plan. Identical text, completely different meaning, and nothing in the question's characters can tell them apart.

**How the code prevents both directions:**

```ts
// answer.service.ts — answer()
const hasHistory = sessionId ? await this.hasPriorTurns(workspaceId, sessionId) : false;
const eligible = cacheKey !== null && !hasHistory;

if (!eligible) {
  // straight to the pipeline: no cache READ, so a follow-up is never SERVED a standalone answer;
  // cacheKey is passed as null, so the result is never WRITTEN either
  return this.runPipeline(workspaceId, question, sessionId, hasHistory, null, identity);
}
```

and in `runPipeline`, the outcome reported is:

```ts
const cacheOutcome: CacheOutcome = hasHistory ? 'bypass' : 'miss';
```

`'bypass'` exists because "not cached" has two very different causes. "Miss" means *eligible, just not cached yet*. "Bypass" means *never eligible*.

**Why keying by session id is the wrong fix.** It is **safe** — B can never see A's answer, because their session ids differ. But look at what the key becomes:

```
answer:7:ab12..:v13:p1:<sessionId>:<hash>
```

Session ids are random per visitor. The only request that could ever hit this entry is **the same visitor asking the exact same follow-up twice in one conversation** — which practically never happens. The hit rate drops to roughly zero, and you pay the Redis write on every turn for nothing. Correct but useless.

**The right fix** is to only cache the case where the key really does capture every input: **a turn with no history**, where the answer genuinely depends only on the question. That is also the case that pays off most — a visitor's *first* question is the one most likely to be a common, standalone question ("how do I reset my password?").

**Interview one-liner:** *A cache key must include every input that affects the output. If an input can't be put in the key — like conversation history — don't cache that request at all, rather than adding something to the key that destroys the hit rate.*

---

### Q6. 200 identical new questions at once — walk through what happens.

**Your answer:** *"we will use lock"*

**Score: SHAKY.** The right mechanism, but the question asked for the walk-through — and the details are where locks go wrong.

**Without protection:** all 200 check Redis at the same instant, all 200 see nothing (the first hasn't finished generating yet), all 200 call Gemini. At 20 generations/day, one burst can exhaust the whole day's quota in a second. That is a **cache stampede**.

**With the lock — the full path for all 200:**

```ts
// answer.service.ts — answer()
const cached = await this.answerCache.get(cacheKey);                 // all 200: miss
if (cached) return this.serveHit(...);

const lock = await this.answerCache.locks.acquire(cacheKey);         // exactly ONE gets 'acquired'

if (lock.state === 'held') {                                         // the other 199
  const waited = await this.answerCache.locks.waitForEntry(cacheKey, (key) => this.answerCache.get(key));
  if (waited) return this.serveHit(workspaceId, question, sessionId, waited, identity);
}

try {
  return await this.runPipeline(...);                                // only the lock holder gets here
} finally {
  if (lock.state === 'acquired' || lock.state === 'unavailable') {
    await this.answerCache.locks.release(cacheKey, lock.token);
  }
}
```

**Why exactly one wins** — `acquire`:

```ts
const token = randomUUID();
const reply = await withTimeout(
  this.redis.set(lockKey(cacheKey), token, 'PX', LOCK_TTL_MS, 'NX'),
  REDIS_TIMEOUT_MS,
);
return reply === 'OK' ? { state: 'acquired', token } : { state: 'held' };
```

`NX` means "only set if the key does **not** exist". Redis runs commands one at a time, so of 200 simultaneous `SET ... NX`, exactly one finds the key absent and gets `OK`; the other 199 get `null`. `PX 15000` gives the lock a 15 s expiry, so if the holder crashes, the lock frees itself rather than blocking that question forever.

**What the 199 do** — `waitForEntry`:

```ts
while (Date.now() < deadline) {                       // at most 10 s
  await sleep(POLL_INTERVAL_MS);                      // 100 ms
  const entry = await read(cacheKey);
  if (entry) return entry;                            // the holder wrote it → serve as a hit
  const stillHeld = await withTimeout(this.redis.exists(lockKey(cacheKey)), REDIS_TIMEOUT_MS);
  if (!stillHeld) return null;                        // holder finished WITHOUT writing → stop waiting
}
return null;
```

The `if (!stillHeld) return null` line matters. If the holder's question was **refused**, nothing is ever cached. Without that check, all 199 would sit the full 10 seconds waiting for an entry that is never coming. Measured: 10 concurrent refusals finished in ~2 s.

**Measured result:**

```ts
// test/answer-cache.e2e.spec.ts — 20 concurrent, generation slowed to 800 ms
expect(calls.generate).toBe(1);
expect(calls.embed).toBe(1);
expect(outcomes.filter((o) => o === 'miss')).toHaveLength(1);
expect(outcomes.filter((o) => o === 'hit')).toHaveLength(19);
```

**And the premise test** — the same burst with the lock disabled produces **20** generation calls. Without that test, the first one could pass because the requests happened to run one after another, and would prove nothing.

**Interview one-liner:** *A stampede is many simultaneous misses for the same key. Fix it with request coalescing: one caller takes a lock (`SET NX PX`) and computes; the rest wait for its result, with a bounded wait and a fallthrough so nobody waits forever.*

---

### Q7. Great hit rate, fast responses — how could the cache still be hurting customers?

**Your answer:** *"dont knwo"* — **UNKNOWN** (at the opening you said "maybe based on latency", scored SHAKY).

**The core idea:** a cache trades **correctness risk** for **speed**. Hit rate and latency only measure the speed side. A cache that serves the *wrong* answer quickly scores **better** on both — so the metrics you'd naturally put on a dashboard would tell you it is working beautifully.

**How it could hurt here, concretely:**
- **A false hit** — serving a cached answer to a question that should have had a different one. The exact tier makes this very unlikely (the text has to match after normalisation), which is precisely why a semantic tier was not switched on.
- **A stale hit** — serving an answer from before a knowledge-base change, if some code path changed chunks without bumping the version.
- **A cached answer where fresh retrieval would now refuse.**

**How to find out.** You cannot see false hits from logs of hits alone — you need to compare against what *should* have happened. That is exactly what the shadow data records:

```ts
// answer.service.ts — runPipeline(), on every eligible miss
const shadow =
  cacheKey && identity
    ? await this.answerCache.findShadowCandidate(identity, ANSWER_PROMPT_VERSION, queryEmbedding)
    : null;
```

Each conversation row now stores both the **fresh** answer and a pointer to the **earlier** answer a semantic cache would have served, plus how close they were:

```sql
SELECT c.question            AS asked,
       prior.question        AS would_have_matched,
       c.nearest_prior_distance,
       c.answer              AS fresh_answer,
       prior.answer          AS answer_a_cache_would_have_served
FROM conversations c
JOIN conversations prior ON prior.id = c.nearest_prior_conversation_id
ORDER BY c.nearest_prior_distance;
```

Read the low-distance rows. If "refund after 30 days" sits next to "refund within 30 days" with opposite answers — which it does, at 0.0534 — you have measured the cost of a semantic tier before paying it. Doing this systematically is Phase 17's job.

**The metrics a real dashboard needs:**

| Is it helping? | Is it hurting? |
|---|---|
| hit rate (from `cache_outcome`) | false-hit rate (sampled comparison, as above) |
| p50/p95 latency, hit vs miss | escalation / "that didn't help" rate after a hit vs after a miss |
| generation calls avoided | stale hits after a known change |

**Interview one-liner:** *Hit rate and latency can't detect a cache serving wrong answers — they reward it. Measure correctness separately by sampling hits and comparing them against freshly computed results.*

---

### Q8. What do the measured distances say about embeddings, and why shadow mode?

**Your answer:** *"dont knwo"* — **UNKNOWN**

**The numbers again:**

| Pair | Same answer? | Distance |
|---|---|---|
| "When are you open?" / "What are your opening hours?" | yes | 0.1946 |
| "I forgot my password…" / "How do I reset my password?" | yes | 0.2314 |
| "How can I get my money back?" / "How do I get a refund?" | yes | 0.2609 |
| **"refund after 30 days?" / "refund within 30 days?"** | **no — opposite** | **0.0534** |
| "error E-4021" / "error E-4022" | no | 0.1409 |
| "cancel my subscription" / "cancel my order" | no | 0.1895 |

**What it tells you about embeddings.** An embedding measures **topical similarity** — *what the text is about*. "After 30 days" and "within 30 days" are about exactly the same topic: refunds, a 30-day window. They differ in **one small word**, and a single word barely moves an average spread across 768 dimensions. What a cache needs is **answer equivalence** — *would the correct answer be the same*. Cosine distance cannot see that property at all, because it lives in the one word the embedding largely ignores.

**Why that rules out a semantic cache here.** A cache needs a threshold: "closer than X → serve the cached answer".

- To catch the money-back paraphrase, X must be above **0.26**. That also serves the negation pair (0.053), E-4022 (0.141) and order-vs-subscription (0.190). The customer asking about *after* 30 days is confidently told the answer for *within* — fast, with citations.
- To exclude the negation pair, X must be below **0.053**. That excludes even a typo (0.136). What is left is an exact-match cache with an embedding call bolted on.

There is **no value of X that works**. The two groups overlap.

**Why shadow mode, rather than just not building it.** "Semantic caching" is widely described as a standard pattern, and ten hand-picked pairs are not proof it can never work on this product's real traffic. Shadow mode lets the question be settled with data instead of an argument: build the semantic lookup, run it on every miss, **record what it would have served**, and never serve it. The customer always gets the fresh answer; the conversation row records the risk:

```
2 | miss | Can I get a refund after 30 days? | nearest = #1 | 0.0534
```

That is how production teams evaluate risky caching or ranking changes: dark launch, measure, then decide.

**Interview one-liner:** *Embeddings capture topical similarity, not answer equivalence, so negations and near-identical identifiers sit closer together than genuine paraphrases — which is why a similarity threshold can't safely decide cache hits.*

---

### Q9. Why is `publicKey` in the key when `workspaceId` already is?

**Your answer:** *"because external customer and llm chat does not know about workspace"* — **UNKNOWN.** This confuses the key's purpose with the widget's authentication. The cache key never leaves the server; customers never see it.

**The actual reason: integer ids can be reused, and the cache would then leak across workspaces.**

Integer primary keys come from a sequence. Normally a sequence never repeats — but there are real ways it does:
- `TRUNCATE ... RESTART IDENTITY`
- restoring a database backup into a fresh instance
- this project's own test suite, which does exactly that **between every test**

Meanwhile **Redis is not reset** — it has no idea the database was.

**Trace it with a key built from `workspaceId` alone:**

```
Test 1:  workspace 1 = "Northwind"   caches   answer:1:v0:p1:<refund hash> → "Refunds take 5-7 days"
         TRUNCATE ... RESTART IDENTITY          (Redis untouched)
Test 2:  workspace 1 = "Acme" (new!)  asks the same question
         key                           answer:1:v0:p1:<refund hash>   ← identical
         → HIT → Acme's customer is told Northwind's refund policy
```

A brand-new workspace inherits a stranger's cache.

**With `publicKey`:** every workspace gets a fresh random UUID at creation —

```ts
// src/modules/auth/auth.service.ts — register()
const workspace = await this.workspaces.save({ name: dto.workspaceName, publicKey: randomUUID() });
```

— so the new "workspace 1" builds a key containing a different UUID and can never collide:

```
Northwind:  answer:1:3f9a…c2:v0:p1:<hash>
Acme:       answer:1:b71e…04:v0:p1:<hash>     ← different key, clean miss
```

The test that proves it, with its premise asserted:

```ts
// test/answer-cache.e2e.spec.ts
await dataSource.query('TRUNCATE ... workspaces RESTART IDENTITY');
const second = await register('someone@else.com', 'A Different Company');
expect(second.workspaceId).toBe(first.workspaceId);           // premise: the id really was reused
const res = await ask(second.token, second.workspaceId, 'How long do refunds take?');
expect(res.body.cache).toBe('miss');                           // ...and it inherited nothing
```

The suite also deliberately **never cleans Redis between tests**, so every test in the file is an implicit proof of the same property.

**Interview one-liner:** *A cache key must contain an identity that can never be reused. Integer ids can be — through a sequence reset or a restored backup — so add a random, never-repeated token.*

---

### Q10. Why does `knowledge_version` live in Postgres, not next to the entries in Redis?

**Your answer:** *"because we have to keep track of it"* — **UNKNOWN.** True of any counter, wherever it lives; it does not say why *Postgres*.

**The failure it prevents: eviction resurrecting stale answers.**

Redis is an in-memory store. When it runs out of memory, an eviction policy such as `allkeys-lru` deletes the **least recently used** keys to make room. It does not know which keys matter.

Imagine the counter lived in Redis as `kb_version:7`. Workspace 7 has had its knowledge base change twelve times, so the counter is `12`. Redis is under memory pressure:

```
1. The counter kb_version:7 hasn't been touched for a while → LRU evicts it.
2. Several old entries answer:7:…:v3:… were read recently → they SURVIVE.
3. The next request reads kb_version:7 → missing → treated as 0.
4. Over the next few document changes it climbs 0 → 1 → 2 → 3.
5. At 3, requests build keys containing v3 again — and the surviving v3 entries match.
   → answers from a knowledge base that changed nine times ago, served as current.
```

No error, no log. The cache would quietly resurrect answers that were deliberately invalidated.

**A Postgres column cannot be evicted.** It is durable, transactional, and survives restarts:

```sql
-- migration AddKnowledgeVersionToWorkspaces
ALTER TABLE "workspaces" ADD "knowledge_version" integer NOT NULL DEFAULT 0
```

The principle: **the thing that guards the cache must be at least as durable as the cache.** If the guard can disappear while the entries survive, the guard is useless.

The cost is one indexed primary-key read per `/ask`:

```ts
// answer-cache.service.ts — getIdentity()
SELECT public_key AS "publicKey", knowledge_version AS "knowledgeVersion" FROM workspaces WHERE id = $1
```

**Interview one-liner:** *Keep an invalidation counter in durable storage, not in the cache itself — an evicting cache can drop the counter but keep the entries, silently resurrecting data you invalidated.*

---

### Q11. Why compare a token before deleting the lock, and why in one step?

**Your answer:** *"to prevent race condition"* — **SHAKY.** Right category, but it names the problem without describing the race — and in an interview the race *is* the answer.

**What a plain `DEL` gets wrong.** A lock has a TTL (15 s) so a crashed holder can't block forever. But a holder can also just be **slow**. Trace it:

```
t=0s    Request A: SET lock NX PX 15000   → acquired
        A starts generating... Gemini is slow today
t=15s   A's lock EXPIRES (A is still working)
t=15.1s Request B: SET lock NX PX 15000   → acquired (the key was free)
        B starts generating
t=18s   A finishes, runs: DEL lock        ← deletes B's lock!
t=18.1s Request C: SET lock NX PX 15000   → acquired — B and C now both generating
```

A deleted a lock it no longer owned, and the stampede reopened. Nothing errored.

**The fix: each lock holds a random token, and you only delete it if it still holds yours.**

```ts
// acquire — each caller writes its own random value
const token = randomUUID();
this.redis.set(lockKey(cacheKey), token, 'PX', LOCK_TTL_MS, 'NX');
```

```lua
-- release — only delete if the value is still MY token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

At t=18s, A's release now reads the lock, sees **B's** token, and deletes nothing.

**Why it must be one step.** Suppose you did it in TypeScript as two commands:

```ts
const current = await redis.get(lock);   // step 1: it's MY token
                                          //   ← A's lock expires right here, B acquires
if (current === myToken) await redis.del(lock);   // step 2: deletes B's lock anyway
```

Between the `GET` and the `DEL`, another client can act. A **Lua script** runs inside Redis as one uninterruptible unit — nothing else executes between its `GET` and its `DEL`. That is what atomic means here.

The test simulates exactly the t=15s interleaving:

```ts
// test/answer-cache.e2e.spec.ts
const first = await answerCache.locks.acquire(key);                     // A acquires
await redis.set(`lock:${key}`, 'token-belonging-to-B', 'PX', 15000);    // A expires, B acquires
const released = await answerCache.locks.release(key, first.token);    // A releases, stale token
expect(released).toBe(false);
expect(await redis.get(`lock:${key}`)).toBe('token-belonging-to-B');   // B's lock survives
```

**Interview one-liner:** *A lock release must verify ownership, because the lock may have expired and been taken by someone else; and the check-and-delete must be atomic (a Lua script), or the lock can change hands between the check and the delete.*

---

### Q12. A "timed-out" write still landed after Redis unfroze. What does that say, and what bug did it cause?

**Your answer:** *"dont know"* — **UNKNOWN**

**What happened, measured.** Redis was frozen with `docker pause`. A paused container keeps its TCP connection open but never replies — a *hang*, not a refusal. During the freeze:

```
/ask            → 201, a real answer, cache:'miss'   (the cache failed open)
[unpause]
same question   → cache:'hit' in 25 ms               ← the write that "timed out" happened after all
```

**What that tells you: a timeout stops you *waiting*. It does not *cancel* the operation.**

```ts
// src/common/utils/with-timeout.ts
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(...)
  });
}
```

This only races a timer against the promise. The `SET` command had **already been sent** down the socket. It sat in Redis's input buffer while Redis was frozen, and the moment Redis woke up, it executed it. Our code had long since given up and moved on. This is true of almost every networked system: an HTTP request that timed out on the client may still complete on the server; a payment that "timed out" may still have been charged.

**The bug it caused — a ghost lock.** The lock request suffered the same fate:

```
t=0      acquire: SET lock <tokenA> NX PX 15000  → sent, but Redis is frozen
t=250ms  our timeout fires → acquire returns { state: 'unavailable' }
         → the request proceeds WITHOUT a lock and, believing it holds none, never releases one
[unpause]
         Redis executes the queued SET → lock now EXISTS, holding tokenA
         → an ownerless lock that lives for its full 15 s TTL
```

Any visitor asking the same question in those 15 s would see `held` and wait — and if the question was a refusal (nothing ever cached), wait the full 10 s budget. Observed after the pause: one stray `lock:*` key.

**The fix — release anyway, using the token.**

```ts
// answer-cache.service.ts — acquire(), on timeout
return { state: 'unavailable', token };           // keep the token that was sent

// answer.service.ts — answer(), finally
if (lock.state === 'acquired' || lock.state === 'unavailable') {
  await this.answerCache.locks.release(cacheKey, lock.token);
}
```

Why this works: **commands on a single Redis connection execute in the order they were sent.** The late `SET` was sent first; the `release` (compare-and-delete) is sent afterwards, so Redis runs it **after** the `SET` — and deletes that lock, because it holds our token. If the `SET` never landed at all, the compare finds nothing and does nothing. If someone else legitimately holds the lock, the token doesn't match and it does nothing. Safe in every case.

The regression test reproduces the state directly, and was **proven to fail with the fix reverted** (`Expected: 0, Received: 1`).

**Interview one-liner:** *A client timeout doesn't cancel a request already sent — the server may still complete it later. Design cleanup around the operation possibly succeeding late, not around the timeout.*

---

### Q13. Cache fails open, allowlist fails closed, rate limiter fails open to a weaker limit. Why each?

**Your answer:** *"dont know"* — **UNKNOWN**

**The deciding question for any component: when it breaks, which is worse — letting something through that shouldn't, or blocking something that should get through?**

**1. The answer cache — fails fully open.**

```ts
// answer-cache.service.ts — get()
try {
  const raw = await withTimeout(this.redis.get(key), REDIS_TIMEOUT_MS);
  return raw ? (JSON.parse(raw) as CachedAnswer) : null;
} catch (err) {
  this.logger.warn(`Answer cache read failed, treating as a miss: ...`);
  return null;                          // → just generate the answer normally
}
```

If the cache is down, the only cost of skipping it is speed — every request is a normal miss. There is **no safety property** a cache provides. So it should simply be ignored when broken.

**2. Phase 11's origin allowlist — fails closed.** It decides **who may connect** to the widget. If a workspace has no allowlist configured, the gateway rejects every connection. Failing open here would mean "an unconfigured workspace accepts connections from any website on the internet" — the failure *is* the security breach. When a security check can't decide, it must deny.

**3. The login rate limiter — fails open, *to a weaker limit*.** It protects **availability** (the service shouldn't be flooded) *and* **security** (no unlimited password guessing). Both pure options are bad:

- **Fully closed:** while Redis is down, *nobody* can log in. Observed before the fix: login **hung for 12 s**. A cache blip becomes a total outage.
- **Fully open:** an attacker who notices — or causes — a Redis outage gets unlimited guesses.

So it fails open to a local limit:

```ts
// src/common/rate-limit/fixed-window-rate-limiter.ts
async hit(key: string): Promise<RateLimitResult> {
  try {
    const count = await withTimeout(this.redis.eval(INCR_WITH_EXPIRY, 1, key, this.options.windowSeconds), REDIS_TIMEOUT_MS);
    return { count, limited: count > this.options.limit, degraded: false };
  } catch (err) {
    this.warnThrottled(err as Error);
    const count = this.hitLocal(key);                  // in-memory Map, per API process
    return { count, limited: count > this.options.limit, degraded: true };
  }
}
```

With N API instances each counting separately, an attacker gets N × 5 attempts per minute instead of 5 — weaker, but still bounded. Verified with Redis frozen:

```
attempts 1–5: 401 in 0.26–0.46 s     (before the fix: hung 12 s)
attempts 6–7: 429                    (still limited, by the fallback)
```

This was **your decision** — you chose availability, which matches the industry default (Envoy's global rate limiter defaults `failure_mode_deny` to false).

**Interview one-liner:** *Fail-open vs fail-closed is decided by what the component protects: optimisations fail open, authorisation fails closed, and availability-critical security controls like rate limiters fail open to a degraded local limit.*

---

### Q14. `INCR` then `EXPIRE` as two commands — what goes wrong, and what's the fix?

**Your answer:** *"dont know"* — **UNKNOWN**

**The old code (Phase 2):**

```ts
const attempts = await this.redis.incr(key);        // command 1
if (attempts === 1) {
  await this.redis.expire(key, WINDOW_SECONDS);     // command 2
}
```

**The failure: something happens between command 1 and command 2.** The Node process crashes, the deploy restarts it, the network drops — on the first attempt, after `INCR` succeeded but before `EXPIRE` ran.

```
INCR login-attempts:anas@x.com:1.2.3.4   → 1     ✅ key created, NO expiry yet
💥 process dies here
EXPIRE ...                                         never runs
```

The key now exists **with no expiry, forever**. Every later attempt increments it: 2, 3, 4, 5, 6 → `429 Too many login attempts`. The window never resets because there is no TTL. **That email from that IP can never log in again**, until someone manually deletes the key. The user sees "try again in a minute", and a minute never comes.

It is rare — it needs a crash in a window of about a millisecond — but at scale, rare things happen daily, and the consequence (a permanent lockout with a misleading message) is severe.

**The fix: one atomic operation.**

```ts
// src/common/rate-limit/fixed-window-rate-limiter.ts
const INCR_WITH_EXPIRY = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;
```

Redis runs a Lua script as a single unit. Either both steps happen or neither does — there is no moment where the key exists without its expiry. Same reason as Q11's release script: **anything that must be true together must be done together.**

The test asserts the first hit always has a TTL:

```ts
await limiter.hit(key);
const ttl = await redis.ttl(key);
expect(ttl).toBeGreaterThan(0);          // -1 would mean "exists with no expiry" — the bug
```

This bug was found by **reading** the old code while replacing it, not by observing it — the kind of latent defect that only a careful review catches.

**Interview one-liner:** *`INCR` followed by `EXPIRE` isn't atomic — a crash between them leaves a key with no expiry and a permanent lockout. Do both in one Lua script (or `SET ... EX ... NX` then `INCR`).*

---

# Topics to master (Step 8)

Ranked by transferable leverage, from both quizzes.

### 1. Cache key design: every input that changes the output
**Search:** "cache key design best practices", "cache poisoning wrong key", "what to include in a cache key"
**Exposed by:** opening Q8, Q10; closing Q5, Q9

The single most important caching skill, and the source of most cache bugs in production. A key that omits an input serves one request another request's answer — history, tenant, prompt version, a reused integer id. The discipline is to list every input to the computation and justify each one's presence or absence in the key. It applies identically to HTTP caching (`Vary` headers), CDN keys, memoisation and build caches.

### 2. Distributed locks: `SET NX PX`, ownership tokens and atomic release
**Search:** "redis distributed lock token", "redlock single instance", "redis lock release lua compare and delete"
**Exposed by:** opening Q11; closing Q6, Q11

Locks look trivial and fail in subtle ways: expiry mid-work, releasing someone else's lock, check-then-act races. The token-plus-atomic-release pattern is the standard answer and comes up in interviews for any backend role involving queues, scheduling or payments.

### 3. Timeouts do not cancel operations
**Search:** "timeout does not cancel request", "idempotency timeouts retries", "at least once delivery timeout"
**Exposed by:** closing Q12

Once a request is sent, a client timeout only means *you stopped waiting*. The server may still complete it. This single fact underlies idempotency keys for payments, the need for deduplication in queues (Phase 4's at-least-once lesson, from a new angle), and why "retry on timeout" can double-charge a customer.

### 4. Fail-open vs fail-closed, and degraded modes
**Search:** "fail open vs fail closed", "graceful degradation rate limiter", "circuit breaker pattern"
**Exposed by:** closing Q13

Every dependency eventually fails, and the choice of what happens next is a design decision, not an accident. Being able to reason per component — optimisation, authorisation, availability control — and to propose a degraded middle ground is a senior-level skill.

### 5. Atomicity of multi-step operations
**Search:** "redis lua script atomicity", "race condition check then act", "INCR EXPIRE race condition"
**Exposed by:** closing Q11, Q14

Two separate commands are two separate moments in which the world can change. Whether it's Redis (Lua / `MULTI`), SQL (a transaction or a single conditional `UPDATE`, as Phase 12's claim used) or files, anything that must be true together must be done in one indivisible step.

### 6. Cache invalidation by versioned keys
**Search:** "cache invalidation versioned keys", "namespace versioning cache", "cache busting strategies"
**Exposed by:** opening Q6, Q7; closing Q3, Q4, Q10

Scanning and deleting doesn't scale; bumping a version does, in O(1). Pair it with TTL for garbage collection and a bounded-staleness safety net, and store the version durably.

### 7. Measuring what a cache costs, not just what it saves
**Search:** "cache correctness monitoring", "shadow mode dark launch", "measure false positive rate cache"
**Exposed by:** opening Q12; closing Q7, Q8

Speed metrics reward a cache that serves wrong answers. Shadow mode — computing a decision without acting on it, and comparing — is how teams safely evaluate caches, ranking changes and new models.

---

## What's still not understood, after both quizzes

- **Every mechanism this phase built from scratch** (Q9–Q14) came back UNKNOWN. None of it was written by the user. See the suggestion below.
- **Q5 and Q7 regressed** from SHAKY at the opening to UNKNOWN at the close — history-dependent caching and measuring cache harm.
- **Exact vs semantic hits (Q1)** — the diagnostic's correct semantic-cache answer was re-applied to the exact cache.

### A suggestion for Phase 15, made once

Across Phases 2, 11, 13 and 14, the same thing keeps happening: the topics you reasoned about yourself are the ones that stick, and the mechanisms I built are the ones that don't. The protocol has you reading code walkthroughs but never writing the code. For Phase 15, it may be worth **you writing one increment yourself** — the rate limiter's per-plan limits, say — with me reviewing rather than writing. Slower per phase, but it targets exactly the gap these quizzes keep showing. Your call; the current protocol is fine to continue as-is.
