# Phase 6 — Chunking Strategies

## Objective

Take the plain, whole-document text Phase 5 extracted into `document_contents.extracted_text` and split it into smaller, individually-retrievable pieces — "chunks" — stored in a new table, ready for Phase 7 (embeddings) and Phase 8 (retrieval) to build on. Nothing in this phase talks to an external API or costs money to run; it's pure, deterministic text-splitting logic.

## Why the system needs this

Anchor's whole product depends on retrieving the *specific* piece of a business's documentation that actually answers a customer's question, then having the AI cite exactly where that answer came from. A single embedding for an entire 40-page document can't do either of those things well — it would blur every topic in the document into one vague vector, and there'd be no way to point at "this paragraph" as the source of an answer. Chunking is the step that turns "we have a document's worth of text" into "we have addressable, individually-retrievable pieces of that text" — the actual unit Phase 8's search will operate on.

---

## The diagnostic

10 questions, answered in one batch. Scored honestly, without correcting in place — real explanations follow each one.

### Q1 — Why can't `document_contents.extracted_text` just be embedded and stored as-is, without splitting it up first?
**Answer:** "so basically we will retrive ony those cheuncs with whom use prompt matches"

**Score: SHAKY.** This is reaching for a real and relevant idea — that retrieval matches *specific* pieces of text against a query — but it doesn't actually answer *why* the whole document has to be split before embedding in the first place. Two concrete reasons were missing:

1. **Embedding models have a maximum input size.** Every embedding model (including the Gemini embedding model this project will use in Phase 7) accepts at most some fixed number of tokens per call — a full multi-page document can simply exceed that limit outright, causing either a hard error or silent truncation (the tail of the document just never gets embedded at all).
2. **A single embedding for a whole document is a blurry average, not a precise fingerprint.** An embedding vector is meant to represent "what this text is about" as a point in a high-dimensional space. Feed it an entire document covering pricing, refunds, shipping, and support hours, and the resulting vector ends up being a vague blend of all four topics — genuinely similar to *none* of them specifically. A customer asking "what's your refund window" needs a vector that's precisely, strongly about refunds — which only a *chunk specifically about refunds* can produce.

The retrieval-matching intuition in the answer is real and becomes fully correct once paired with these two reasons — it's *why* splitting has to happen before that matching can work at all.

### Q2 — What is a "token," and how is a token count different from a word count?
**Answer:** "token is a word in a prompt, like: I am anas, so it has three tokens, becuase token also includes symbol speacheal chracterter too."

**Score: UNKNOWN.** The example's number (3) happens to be plausible for that specific short phrase, but the underlying model — "a token is a word" — is the actual misconception, and it's a load-bearing one for this phase.

**The real mechanism.** A token is *not* a word. It's a piece of text produced by a model-specific **tokenizer** (an algorithm like Byte-Pair Encoding or SentencePiece) that was built by statistically analyzing huge amounts of training text and deciding which recurring chunks of characters are worth their own single "unit." The practical result:

- Common short words ("the," "is," "am") are usually their own single token.
- Longer, rarer, or made-up words often get split into multiple sub-word tokens — e.g., "tokenization" might become two tokens, roughly `token` + `ization`, because the whole word wasn't common enough in training data to earn its own single token.
- A name like "anas" — not a common English dictionary word — is exactly the kind of token that's *more* likely to get split into pieces (something like `an` + `as`) than to be one clean token, purely because of how rare that exact character sequence was in whatever text the tokenizer was built from. So "I am anas" landing at 3 tokens in the answer isn't wrong because the *number* is implausible — it's wrong because the *reasoning* ("each word is one token") doesn't hold in general, and would give a wildly incorrect estimate on longer or less common text.
- Punctuation and whitespace consume tokens too, sometimes merged with an adjacent word's token and sometimes not, again purely based on what the tokenizer saw during training.

A useful rough rule of thumb for English text: **~4 characters per token on average**, or roughly 0.75 tokens per word — a *heuristic estimate*, not a rule, and one that breaks down noticeably for code, non-English text, and unusual vocabulary (all of which tend to use *more* tokens per character than plain English prose).

**Why this matters concretely for this phase:** a chunk size needs to respect the embedding model's token limit (Q1). Measuring "how big is this chunk" in *words* or *characters* as a stand-in for tokens is an approximation — usually a workable one, given the rule of thumb above, but understanding that it *is* an approximation (not an exact count) matters for not being surprised when actual token counts come in higher or lower than expected, especially on text with unusual vocabulary (product names, jargon — exactly the kind of content real customer documentation is full of).

### Q3 — Fixed-size chunking vs. structure-based (heading/paragraph) chunking — what's the actual tradeoff?
**Answer:** "dont know"

**Score: UNKNOWN.**

**Fixed-size (or fixed-token) chunking** splits the text every *N* tokens (or characters, as an approximation), regardless of where sentences or paragraphs naturally end.
- *Pros:* simple, predictable — every chunk is roughly the same size, which makes staying under the embedding model's token limit trivial, and works on *any* text, even a document with no discernible structure at all (a wall of unformatted prose).
- *Cons:* can slice straight through the middle of a sentence, or split one coherent idea awkwardly across two chunks — hurting both the embedding's quality (each half loses context the other half had) and the readability of whatever gets shown to a human as a citation later.

**Structure-based chunking** splits along the document's own natural boundaries — headings, paragraph breaks, sometimes sentence-level semantic similarity.
- *Pros:* chunks tend to be coherent, self-contained ideas (a whole subsection under one heading, say), which usually embeds and retrieves noticeably better, since each chunk represents one complete thought rather than an arbitrary slice.
- *Cons:* genuinely harder to implement well, and chunk sizes become unpredictable — one section might be 50 tokens, another 5,000 — which reintroduces the token-limit problem from Q1/Q2 and usually requires falling back to fixed-size splitting *within* an oversized section anyway.

**A concrete wrinkle specific to this project:** Phase 5's extraction produces *plain text* — `pdf-parse` and `mammoth` don't reliably preserve heading markup as distinguishable structure once text is pulled out. That makes a purely heading-based approach genuinely harder to do well right now, which is a real design tension worth resolving explicitly in the Design step below, not glossed over.

### Q4 — What is chunk "overlap," and what problem does it solve?
**Answer:** "dont know"

**Score: UNKNOWN.**

**Overlap** means adjacent chunks deliberately share some text — chunk 2 might start by repeating the last 50 tokens of chunk 1, then continue with genuinely new content.

**The problem it solves:** without overlap, any sentence or idea that happens to land right at a chunk boundary gets split across two chunks, and each half — read in isolation, which is exactly how retrieval will read it — can lose critical context. Concrete example: chunk 1 ends with *"Refunds are available within 30 days, except for..."* and chunk 2 begins with *"...enterprise annual contracts, which are non-refundable."* If a customer's question matches chunk 2 strongly, the AI could retrieve *only* chunk 2 and see a flat, context-free statement — "enterprise annual contracts are non-refundable" — without ever seeing the "except for" that explains *why* that's called out as an exception to the general 30-day policy. Overlap doesn't eliminate this risk, but it meaningfully reduces how often an important transition gets orphaned at a hard boundary, since neighboring chunks each carry a bit of what's on the other side of the cut.

### Q5 — If a chunk is too small, what breaks downstream? If it's too large, what breaks downstream?
**Answer:** "dont know"

**Score: UNKNOWN.**

**Too small:** (a) loses surrounding context — a fact stated with no qualifying sentence nearby can be ambiguous or even misleading when it's the *only* thing retrieved; (b) multiplies the number of chunks per document, which multiplies Phase 7's embedding API calls (real cost, real latency) and grows the index Phase 8 has to search; (c) if an answer genuinely needs several nearby facts together, and retrieval only pulls back a fixed number of top matches, tiny chunks make it easier to end up with an incomplete picture spread across more pieces than got retrieved.

**Too large:** (a) risks exceeding the embedding model's token limit outright (Q1/Q2) — a hard failure, or a silent truncation that quietly drops the end of the chunk; (b) dilutes the chunk's own embedding the same way a whole-document embedding does (Q1) — a chunk covering three sub-topics produces a vector that's a blurry average of all three, matching *none* of them precisely; (c) when retrieved, stuffs a lot of probably-irrelevant text into the LLM's limited context window alongside the actually-relevant part, wasting tokens (cost) and diluting the model's attention on the part that matters.

### Q6 — Where should chunks actually live, and what would you need to store per chunk besides the text itself?
**Answer:** "a new table"

**Score: SHAKY.** The storage location is right, and matches this project's own established pattern (Phase 5 kept `extracted_text` in its own table rather than bolting it onto `Document`, for exactly the reasons that also apply here — a chunks table will be queried very differently, and far more often per document, than `documents` itself). The second half of the question — what a chunk row actually needs to store — wasn't addressed.

**What a chunk row needs, beyond the text:** a foreign key back to the document it came from; the chunk's own text; a **sequence number** recording its position among that document's other chunks (this is exactly Q8 below — order has to be stored, not just implied by insertion order); and, worth flagging as a real current limitation rather than solving it now, a **page number** *would* be a natural thing to store per chunk for citation purposes, but Phase 5's extraction currently returns one whole-document string with only a document-level `page_count` — it doesn't track which page any given piece of text came from. Precise per-chunk page attribution isn't available for free from what Phase 5 built; that's a real gap worth naming, not pretending is already solved. Deliberately **not** in this phase's table: an `embedding` column — that's Phase 7's entire job, and adding it now would be building ahead of what this phase actually needs.

### Q7 — A document gets re-processed. What should happen to that document's *old* chunks?
**Answer:** "the old checnks will remian there too becuase if user upload same docy after sometime with some updated content both will have different content hash so we dont know is it th esae doc or new"

**Score: UNKNOWN — and worth untangling, because the scenario itself got swapped for a different one.** The answer describes what happens when a customer uploads a *new file* with different content — Phase 3's design already handles that correctly and unambiguously: a different `content_hash` means a genuinely new `Document` row (a new `id`), so of course its chunks are entirely separate from any other document's. That part isn't actually in question.

**The scenario this question meant:** the *same* `Document` row — same `id` — has its chunking re-run. Two realistic ways that happens: (a) a redelivered/retried job (the exact idempotency territory from Phases 4 and 5) where a previous attempt already inserted *some* chunks before crashing partway through; or (b) a deliberate re-chunk later on — say, the chunking strategy gets improved and existing documents need to be re-split without re-uploading their files.

**Why "just insert the new chunks" is wrong in both cases:** if old chunks for that same `document_id` are left in place while new ones are added, retrieval (Phase 8) would end up searching over *both* the old and new chunk sets for that document — duplicate or outdated content sitting alongside the correct current version, corrupting search results with redundant or contradictory matches. Phase 5's fix for its own idempotency problem was `upsert` on a single, always-exactly-one-row relationship (`document_id` is `UNIQUE` in `document_contents`). Chunking is different: a document can have *many* chunks, and a new chunking run might produce a different *number* of chunks than the old run did — a per-row upsert alone wouldn't clean up leftover rows from a previous run that don't correspond to anything in the new run. The correct shape is closer to **delete all existing chunks for this `document_id`, then insert the new set** — a "replace," not an "append" — worth designing explicitly rather than defaulting into by accident.

### Q8 — Why does chunk order matter, tied to what Anchor's citations feature needs?
**Answer:** "dont know"

**Score: UNKNOWN.**

Chunks need a stored, explicit order (not just "whatever order they happened to be inserted in") for reasons specific to what Anchor actually does with them later:

1. **Coherent context for the LLM.** When multiple chunks from the *same* document get retrieved for one answer, presenting them to the LLM in their original reading order — not the order retrieval happened to rank them in, which has nothing to do with document position — lets the model follow a natural "this comes before that" narrative instead of a scrambled one.
2. **Citations are Anchor's whole value proposition.** Telling a customer "this answer is based on this specific part of this document" requires actually knowing *where* in the document a chunk sits. Without a stored order, there's no way to describe "the third paragraph" or reconstruct a chunk's position relative to its neighbors — undermining the trust-building citation feature this entire product is built around.
3. **Future features** — showing a human agent "the rest of this document" starting from a cited chunk, for instance — depend on knowing what comes immediately before/after any given chunk.

### Q9 — Why build chunking as a fully separate phase from embedding, rather than doing both at once?
**Answer:** "dont know"

**Score: UNKNOWN.**

Several real reasons, all echoing patterns already established earlier in this project:

- **Chunking is free; embedding costs real money and makes a real network call.** Chunking is pure, local, deterministic CPU work — no API, no cost, no network failure mode. Embedding (Phase 7) means a real call to Gemini's embedding API, with real latency, real cost per call, and real rate-limit/retry concerns. Keeping them as separate steps means chunking logic can be tested exhaustively, instantly, and for free — exactly like Phase 5 kept parsing (free, local) conceptually separate from the paid stages that will eventually follow it.
- **Chunking strategy will get iterated on.** Chunk size, overlap amount, fixed-vs-structural splitting — these are the kinds of decisions that get tuned repeatedly once real retrieval quality can actually be observed (Phase 17, Evaluations, exists specifically for that). If chunking and embedding were one fused step, every experiment with chunk boundaries would force paying for embedding calls all over again. Separated, chunks can be regenerated cheaply and re-embedded only once a change is actually worth paying for.
- **It matches this project's established pipeline-stage pattern.** Each stage (upload → parse/extract → chunk → embed → index) does one job, has its own clear success/failure boundary, and can retry independently — fusing two conceptually different concerns (free CPU work vs. paid external API calls) into one job muddies what "retry this step" even means when only one half of it actually failed.

### Q10 — Where should chunking actually run: inside Phase 5's existing job, or as a new, separate job?
**Answer:** "dont know"

**Score: UNKNOWN — though this one is a genuine, two-sided design question, not pure trivia, which is exactly why it's being asked here rather than settled already.** Both real options, with real tradeoffs, are laid out properly in the Design section below rather than being pre-decided in this diagnostic — but at minimum, engaging with *some* tradeoff (even informally) would have been the sign this was recognized as a decision rather than a fact to recall.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for actually building this phase's code:

1. **Tokens vs. words vs. characters** (Q2) — every other sizing decision in this phase (chunk size, overlap size, the token-limit concern in Q1/Q5) is stated in terms of tokens; treating a token as "a word" will produce systematically wrong size estimates the moment real customer documentation (jargon, product names, non-English text) is involved.
2. **Why a whole document can't be one embedding, and why a chunk can't be arbitrarily large either** (Q1, Q5) — the single idea underlying almost every other design choice in this phase: embeddings lose precision the more topics they're forced to blend together.
3. **The replace-not-append shape re-processing needs** (Q7) — a direct, generalized continuation of Phases 4-5's idempotency theme, now for a one-to-many relationship instead of one-to-one, which changes the shape of the fix (delete-then-insert, not a per-row upsert).
4. **Fixed-size vs. structure-based chunking, and why this project's plain-text extraction output makes that tradeoff sharper** (Q3) — a real architectural decision to make explicitly in the Design step, not a settled fact.
5. **Chunk overlap as a concrete mitigation, not a vague "more context is better" instinct** (Q4) — tied to a specific, nameable failure mode (information orphaned at a chunk boundary).
6. **Ordering as a citation-feature requirement, not a nice-to-have** (Q8) — ties this phase's design directly back to why Anchor exists at all (trustworthy, attributable answers).

---

## Architecture & decisions

Design proposed after the diagnostic, agreed to as-is (no changes requested):

**1. Chunking strategy: fixed-size with boundary-snapping (Q3 resolved).** Split at a target of ~1000 characters (a rough token-count proxy — see Q2's ~4-chars/token rule of thumb — without adding a real tokenizer dependency this phase), but rather than cutting at exactly that position, search backward up to 200 characters for a nicer place to cut: a paragraph break first, then a sentence-ending punctuation mark followed by whitespace, then plain whitespace, falling back to a hard cut only if none of those exist nearby. Pure heading-based chunking was rejected for now because Phase 5's extraction returns plain text with no reliably preserved heading markup — there's no structure signal to split on yet.

**2. Overlap: ~150 characters (Q4).** Each chunk after the first starts 150 characters before where the previous one ended, so a sentence or idea that happens to fall near a cut point still shows up, at least partially, in both neighboring chunks.

**3. Storage: a new `document_chunks` table (Q6).** One row per chunk, `document_id` as a (non-unique, indexed) FK to `documents` with `CASCADE` delete, plus a `UNIQUE(document_id, chunk_index)` constraint — deliberately *not* unique on `document_id` alone, since a document now has *many* chunks (contrast with Phase 5's `document_contents`, which is genuinely one-to-one). No `embedding` column — that's Phase 7, not built ahead of when it's needed.

**4. Re-processing: delete-then-insert in one transaction (Q7).** Rather than a per-row upsert (which can't clean up stale extra rows if a re-run produces fewer chunks than before), the processor deletes every existing chunk for the document, then inserts the freshly-computed set, both inside a single `dataSource.transaction(...)` — proven for real in the Failure Cases section below to roll back atomically if the insert half fails, so a crash mid-write can never leave a document with zero chunks.

**5. Ordering: an explicit `chunk_index` column (Q8).** Assigned by the array position `chunkText()` returns chunks in, not left implicit in insertion order or row `id` — a stored, queryable fact (`ORDER BY chunk_index`) rather than an accident of how Postgres happens to store rows.

**6. Where it runs: extended into Phase 5's existing `DocumentProcessingProcessor`, not a new job (Q10 resolved).** Chunking runs immediately after a successful extraction and `document_contents` write, in the same job, before the status flips to `ready`. Chosen because chunking is free, local, deterministic CPU work with none of the paid-API/rate-limit concerns that will genuinely justify Phase 7 (embeddings) being a separate stage — fusing two *conceptually different* concerns (a real external API call vs. pure text-splitting) would have been the wrong call, but chunking and extraction are both "cheap, local, synchronous-ish work," and keeping them in one job avoids an extra queue hop for no real isolation benefit.

---

## Data flow

```
DocumentProcessingProcessor.process(job)   (unchanged entry point from Phase 5)
        │
        ▼
  ... idempotency guard, storage read, extraction (Phase 5, unchanged) ...
        │
        ▼
  documentContents.upsert(...)              (Phase 5, unchanged)
        │
        ▼
  chunkText(extractedText) → Chunk[]         (NEW — pure, no I/O)
        │
        ▼
  dataSource.transaction(async manager => {
    manager.delete(DocumentChunk, { documentId })     ┐
    manager.insert(DocumentChunk, chunks.map(...))    ┘  one atomic unit
  })
        │
        ▼
  status: 'ready'
```

---

## Migrations: what each table and column actually stores

**`document_chunks`** (`CreateDocumentChunks` migration) — one row per chunk, many rows per document.

| Column | Stores | Why |
|---|---|---|
| `id` | Auto-increment integer PK. | Consistent with every other table's PK style in this project. |
| `document_id` | FK to `documents.id`, indexed, `ON DELETE CASCADE`. | *Not* unique on its own — a document has many chunks, unlike Phase 5's `document_contents`. Indexed because "get all chunks for a document, in order" is the primary query this table exists to serve. `CASCADE` because a chunk has no meaning once its document is gone. |
| `chunk_index` | Integer — this chunk's position among its document's other chunks, starting at 0. | Makes ordering (Q8) an explicit, stored, queryable fact rather than an assumption about row insertion order. |
| *(composite)* `UNIQUE(document_id, chunk_index)` | — | The real backstop against two chunks silently claiming the same position for the same document — proven to actually reject a duplicate insert in the Failure Cases section below, not just assumed. |
| `content` | The chunk's actual text — a `text` column. | TOASTed like `document_contents.extracted_text`, same reasoning. |
| `char_start` / `char_end` | Offsets into the original `document_contents.extracted_text` string that this chunk was sliced from. | Not used by anything yet this phase, but cheap to capture now and exactly the kind of fact ("where in the source did this text come from") that citation-related UI work later will want, without needing to re-derive it by re-searching the original text. |
| `created_at` | Timestamp, defaulted by the DB. | Matches every other table's audit-timestamp pattern in this project. |

---

## Code walkthrough

**`chunking.ts`** — pure logic, zero I/O, zero dependencies beyond the standard library. `chunkText(text)` trims the input once up front (computing `start`/`end` offsets into the *original*, untrimmed string, so returned offsets stay meaningful), short-circuits to a single chunk if the trimmed text already fits under `TARGET_CHUNK_SIZE`, and otherwise walks forward through the text producing overlapping, boundary-snapped chunks. `snapToBoundary()` is a separate, individually-reasoned-about function: it only ever looks *backward* from a tentative cut point, within a bounded window, trying three boundary types in order of preference (paragraph break → sentence end → plain whitespace) before giving up and accepting a hard cut. The one subtlety worth calling out: `cursor = Math.max(nextCursor, cursor + 1)` after each chunk — this guarantees the loop always makes forward progress by at least one character, regardless of how `OVERLAP_SIZE` and `TARGET_CHUNK_SIZE` are tuned relative to each other, which is what makes the function provably termination-safe rather than just "safe in practice for the constants currently chosen."

**`document-processing.processor.ts`** — the only change from Phase 5's version is what happens after the `document_contents` upsert: `chunkText()` runs (fast, synchronous-feeling even though it's not literally sync, since there's no `await` inside it), then a single `dataSource.transaction(...)` deletes any existing chunks for this document and inserts the fresh set. Using the injected `DataSource` directly (via `@InjectDataSource()`) rather than a `Repository<DocumentChunk>` is deliberate here — `EntityManager.delete`/`.insert` inside a transaction callback are what let both statements share one atomic unit of work; a plain repository call wouldn't participate in the same transaction automatically.

---

## Failure cases actually tested

**1. The `UNIQUE(document_id, chunk_index)` constraint is a real backstop, not just documentation.** Directly inserting two `DocumentChunk` rows with the same `(documentId, chunkIndex)` pair — bypassing the processor's own careful chunk-index assignment entirely — was proven to throw a real Postgres constraint-violation error. Test: `document-processing.e2e.spec.ts` → *"rejects a raw duplicate (document_id, chunk_index) pair at the database level"*.

**2. The delete-then-insert transaction genuinely rolls back atomically.** A document was seeded with one existing chunk, then a transaction mirroring the processor's own logic was run with a deliberately malformed second insert row (a repeated `chunk_index`, forcing a real constraint violation partway through the `insert` call, *after* the `delete` had already executed). Confirmed the original chunk was still present afterward, completely unchanged — proving Postgres genuinely undid the `delete` when the later `insert` failed, rather than leaving the document with zero chunks. Test: `document-processing.e2e.spec.ts` → *"rolls back the whole delete-then-insert transaction if the insert half fails partway through"*. This is the concrete, tested answer to "what happens if the process crashes between the delete and the insert" — the honest answer being: nothing, from the database's point of view, because it isn't two separate operations as far as Postgres is concerned.

**3. Re-chunking an already-processed document doesn't create duplicates.** A document was fully processed once (one chunk, matching the small fixture), then forced back to `uploaded` and reprocessed a second time through the real processor. Confirmed exactly one chunk row exists afterward, not two — the delete-then-insert design doing its actual job, not just existing in theory. Test: `document-processing.e2e.spec.ts` → *"re-chunks a document on redelivery without leaving stale duplicate chunks behind"*.

**4. `chunkText()` terminates and covers the full input even with zero natural boundaries.** A 3,000-character string with no whitespace at all (nothing for `snapToBoundary()` to find) was chunked successfully — multiple chunks produced, the full range covered, no hang. This is the direct test of the `Math.max(nextCursor, cursor + 1)` forward-progress guarantee actually holding under the worst realistic input shape.

---

## Tests and why each exists

| Test file | What it proves |
|---|---|
| `chunking.spec.ts` | The pure chunking function's own contract: empty input → no chunks; short input → one chunk; every returned `content` matches what its own `charStart`/`charEnd` slice out of the original text; chunks overlap with no gaps; a paragraph break near the target size gets snapped to instead of a mid-word cut; pathological (whitespace-free) input still terminates and covers the full range |
| `document-processing.e2e.spec.ts` (new/updated tests) | The whole pipeline wired together for real: a genuine PDF produces a real chunk row with the expected content; re-processing doesn't duplicate chunks; the `UNIQUE` constraint and the transaction's atomicity are both true facts about the real database, not just intentions in code |

---

## Reverse-engineering guide (if reopened in six months)

1. Start at `chunking.ts` — `chunkText()` is the entire contract: one pure function, `text in → Chunk[] out`, with `TARGET_CHUNK_SIZE`/`OVERLAP_SIZE`/`BOUNDARY_SEARCH_WINDOW` as the three constants that shape every chunk's boundaries.
2. Then `document-processing.processor.ts` — the only consumer, and the place where "an array of chunks" turns into "the correct set of rows in `document_chunks`," via the delete-then-insert transaction.
3. If chunk boundaries ever look wrong for a specific document, reproduce it directly against `chunkText()` in isolation (it's pure — no DB, no app bootstrap needed) before assuming the bug is anywhere in the processor or database layer.
4. If a document ever seems to have duplicate or stale chunks, check whether some code path wrote to `document_chunks` *outside* the processor's transaction (a manual script, a one-off migration) — the delete-then-insert design assumes it's the only writer.

---

## Closing quiz (round 1) — answered and scored (2026-09-17)

Same batching format, scored honestly. The user explicitly asked for this section to be unusually thorough — "keep every small detail... so that i can become fully confident about it and can crack any interview" — so every answer below, including the correct one, gets a full explanation, not just a correction.

### Q1 — Why does `document_chunks` have `UNIQUE(document_id, chunk_index)` rather than `UNIQUE(document_id)` the way `document_contents` does?
**Answer:** "becuase there will be moltiple chunks in one document so chunk index is pointinto to one chenk not one complete doc"

**Score: SOLID.** This is the real, correct reasoning, typos aside — genuine understanding, not a guess. Worth stating precisely for interview purposes: `document_contents` models a **one-to-one** relationship (exactly one content row per document, ever), so `UNIQUE(document_id)` alone is the right constraint — it says "at most one row can exist for this document_id, period." `document_chunks` models a **one-to-many** relationship (many chunk rows per document), so `UNIQUE(document_id)` alone would be actively wrong — it would make it *impossible* to insert a second chunk for any document at all, since the second insert would collide with the first purely on `document_id`. The constraint has to be on the **combination** of `document_id` *and* `chunk_index` — which says "at most one row can exist for this specific *position* within this specific document," correctly allowing many rows per document while still forbidding two different rows from claiming the *same* position. This is a general SQL pattern worth having cold: a composite unique constraint is what you reach for whenever uniqueness needs to be scoped *within* a parent, not *across* the whole table.

### Q2 — Walk through what actually happens, step by step, if the server crashes right between the `DELETE` and the `INSERT` inside the processor's transaction.
**Answer:** "them we will not have the updated document and old also has been gone so user has to again upload"

**Score: UNKNOWN — and this is the most important correction in this whole quiz**, because it describes the exact failure mode this phase's code was specifically built to *prevent*, as if the prevention doesn't exist. Walking through it fully, since this is worth being airtight on:

**What a "transaction" actually is, first.** Everything inside `dataSource.transaction(async (manager) => { ... })` is sent to Postgres as one indivisible unit. Postgres doesn't actually apply the `DELETE`'s effects permanently the instant that line of JavaScript finishes running — it holds the changes provisionally, only making them real and visible to anyone else the moment the *entire* transaction block finishes successfully and Postgres executes a `COMMIT`. If anything goes wrong before that `COMMIT` happens — an exception thrown inside the callback, a lost database connection, or yes, the whole Node process crashing outright — Postgres's own crash-recovery guarantees mean **none** of the provisional changes ever become permanent. The `DELETE` is undone right along with everything else, as if none of it had ever run.

**So, concretely, if the process crashes between the `DELETE` and the `INSERT`:** the connection to Postgres drops mid-transaction. Postgres notices the connection is gone, and — this is the crucial part — treats the *entire open transaction* as failed and rolls it back automatically. The row(s) the `DELETE` removed are put back exactly as they were. Nothing was ever actually lost. When the server process restarts (or, in this project's real setup, when BullMQ redelivers the job to a fresh worker after the crashed job's lock expires — this is Phase 4's stalled-job mechanism doing exactly its job here), the idempotency guard at the top of `process()` sees the document's status is still `'processing'` (never reached `'ready'`), so it reprocesses the document from scratch — re-extracts, re-chunks, and this time the delete-then-insert transaction runs to completion and commits cleanly. **No user action is ever required.** This is precisely the scenario Failure Case #2 in this doc proves happened for real, not hypothetically — go re-read it, since the described failure mode (data permanently gone, forcing a re-upload) is exactly what that test disproves.

**Why this matters as a general interview-ready fact:** "wrap related writes in a transaction" is advice everyone repeats, but the actual *guarantee* it buys you — that a crash at any point inside the block leaves the database exactly as if none of the block had run at all — is the specific, nameable property (this is the "Atomicity" in ACID) that makes it safe to reason about partial failure without having to manually account for every possible crash point.

### Q3 — In `chunkText()`, what does `snapToBoundary()` actually search for, and in what priority order?
**Answer:** "dont know"

**Score: UNKNOWN.** Real answer, with the actual code reasoning: `snapToBoundary()` is only ever called when a chunk's *tentative* cut point (`cursor + TARGET_CHUNK_SIZE`) lands before the very end of the text — meaning there's more content after it, so *where exactly* the cut happens is worth being careful about. It looks backward from that tentative point, across a window of up to 200 characters (`BOUNDARY_SEARCH_WINDOW`), for three kinds of boundary, tried strictly in this order, stopping at the first one found:

1. **A paragraph break** (`'\n\n'`) — two consecutive newlines, the strongest signal that one *complete idea* just ended and a genuinely new one is about to begin. Checked first because it's the best possible place to cut, when one exists.
2. **A sentence ending** — a `.`, `!`, or `?` followed by whitespace, found via the regex `/[.!?]\s+(?!.*[.!?]\s+)/`, which deliberately matches the *last* such occurrence in the search window (the `(?!.*[.!?]\s+)` part is a negative lookahead meaning "and there is no other sentence-ending further along in this window" — i.e., find the *closest* one to the tentative cut point, not the first one in the window).
3. **Plain whitespace** — a single space, as a last resort before giving up entirely. At minimum, this still avoids slicing a chunk in the middle of a single word.

If *none* of the three are found anywhere in that 200-character window, `snapToBoundary()` gives up and returns the raw `tentativeEnd` unchanged — a hard cut. This is exactly what happens in the "no whitespace at all" test (Failure Case #4): with nothing to snap to, the function falls back to cutting at a fixed position, and the surrounding loop logic still guarantees it terminates and covers the whole input regardless.

### Q4 — What's the one line in `chunking.ts` that guarantees the chunking loop can never hang, and why would it hang without it?
**Answer:** "dont nknow"

**Score: UNKNOWN.** The line: `cursor = Math.max(nextCursor, cursor + 1)`, at the end of each loop iteration in `chunkText()`.

**Why it's needed, worked through concretely.** After producing a chunk ending at `chunkEnd`, the *next* chunk is supposed to start `OVERLAP_SIZE` (150) characters *before* `chunkEnd`, to create the overlap — that's `nextCursor = chunkEnd - OVERLAP_SIZE`. Normally `chunkEnd` is close to `cursor + TARGET_CHUNK_SIZE` (1000), so `nextCursor` ends up comfortably ahead of the current `cursor` (roughly `cursor + 850`), and everything moves forward fine.

But consider what `snapToBoundary()` can do to that math: it's allowed to move the cut point *backward*, sometimes by nearly the entire 200-character search window, if a boundary happens to sit right at the edge of that window. In a genuinely pathological case — imagine `TARGET_CHUNK_SIZE` and `OVERLAP_SIZE` set close enough together, combined with a boundary landing right at the start of the search window — `chunkEnd` could come back small enough that `chunkEnd - OVERLAP_SIZE` (`nextCursor`) is *less than or equal to* the current `cursor`. Without the `Math.max(..., cursor + 1)` guard, the loop's `cursor` variable would then not move forward at all (or could even move backward), and the `while (cursor < end)` loop would spin forever, re-producing the same (or an even-more-backward) chunk on every iteration — a genuine infinite loop, freezing whatever job is running this code (in production, the BullMQ worker processing that document, and every other job sharing that worker's event loop, since Node is single-threaded).

The fix guarantees the *opposite* is impossible: `cursor` is always set to *at least* one more than its previous value, no matter what overlap math or boundary-snapping produced. That single line is the entire reason this function is provably safe to run on arbitrary, adversarial-shaped input without a separate timeout or iteration-count safety valve.

### Q5 — Why does chunking run inside Phase 5's existing job instead of a new, separate queue?
**Answer:** "because it is alo a time taken process so we do chunking in same process and than mark it ready"

**Score: SHAKY.** The *conclusion* — chunking runs in the same job — is correct, and matches the real design decision made in this phase. But the *reasoning given is inverted from the truth*, which is worth being precise about since it's the kind of thing that sounds plausible but is backwards: chunking is fused into the same job **because it's fast/cheap/local**, not because it's slow. Stated fully: `chunkText()` makes zero network calls, has no external rate limits, costs nothing per invocation, and runs to completion in milliseconds even on a large document — there's no meaningful isolation benefit to giving it its own queue. Phase 7 (embeddings), by contrast, genuinely *is* slow and costly in the way this answer describes — it makes a real network call to Gemini's embedding API, with real per-call latency, real per-call cost, and real rate-limit/retry concerns — and *that's* the phase that will actually deserve to be a separate job, for reasons directly tied to this project's established pattern of giving each conceptually distinct kind of work (free local computation vs. paid external API calls) its own retry/failure boundary. Getting the conclusion right while inverting the reasoning is a real, specific gap worth closing before Phase 7, since Phase 7's own design will directly hinge on correctly identifying which category *it* falls into.

### Q6 — What do `char_start` and `char_end` actually store, and what are they for — given nothing in this phase's code reads them yet?
**Answer:** "fir and last word, the basicallly used to check if the document is updated when user will tyry it again (maybe)"

**Score: UNKNOWN.** Two separate, unrelated concepts got merged together here, worth untangling explicitly:

**What `char_start`/`char_end` actually are:** plain integer **character offsets** into the original `document_contents.extracted_text` string — *not* words, first or last. If a chunk's `content` is exactly the substring `extractedText.slice(charStart, charEnd)`, then `charStart` is the index of the chunk's first character and `charEnd` is the index one past its last character, in the *original, unchunked* text. This is directly testable and tested: `pdf-extractor.spec.ts`'s sibling test in `chunking.spec.ts` — *"every chunk's content is exactly what its charStart/charEnd slice out of the original text"* — asserts precisely this relationship holds for every chunk produced.

**What they're actually for:** locating exactly *where in the source document* a given chunk's text came from — useful later for things like highlighting the cited passage in a document viewer, or reconstructing surrounding context around a chunk without re-running the chunking algorithm. They have **nothing to do with detecting whether a document was updated** — that's an entirely different, already-solved problem from Phase 3: `Document.contentHash` (a SHA-256 hash of the file's raw bytes) is what determines whether an upload is "the same document again" or genuinely new content, and it's computed once, at upload time, completely independent of chunking. Worth being crisp about this distinction for an interview: "where did this specific piece of text come from within its source" (what `char_start`/`char_end` solve) and "is this the same file as one we've already seen" (what `content_hash` solves) are two genuinely different questions, solved by two genuinely different mechanisms, in two different phases of this project.

### Q7 — If a re-processing run produces *fewer* chunks than the old one, what would go wrong with a per-row upsert (keyed on `chunk_index`) instead of delete-then-insert?
**Answer:** "dont know"

**Score: UNKNOWN.** Concrete walkthrough: suppose a document was chunked once into 5 chunks (`chunk_index` 0 through 4), and later — say, after a chunking-algorithm improvement — gets re-chunked, and the new run produces only 3 chunks (0, 1, 2), because the new logic happens to produce larger, more efficient chunks for this particular document.

**With a per-row upsert** (something like "for each new chunk, `upsert` a row matching `(document_id, chunk_index)`"): the upsert would correctly overwrite rows 0, 1, and 2 with the new content. But rows 3 and 4 — leftover from the *old* run — were never touched by anything in the new run, so they'd simply **remain in the table, unchanged, forever**, now containing stale text from a chunking pass that's supposed to no longer exist. Retrieval (Phase 8) would then search over 5 chunks for this document — 3 correct, current ones, and 2 stale, orphaned ones — potentially surfacing outdated or duplicate-feeling content in a customer-facing answer, with no error, no warning, and nothing in the system flagging that anything is wrong.

**Delete-then-insert avoids this entirely** by construction: `DELETE FROM document_chunks WHERE document_id = X` removes *every* row for that document — however many there were, 5 or 500 — before a single new row goes in. There's no leftover-row problem to reason about, because nothing from the old run survives the delete regardless of how many chunks it produced. This is the general lesson worth having cold: **upsert is the right idempotency tool for a fixed-shape, one-to-one relationship** (exactly Phase 5's `document_contents` case, where there's always exactly one row to reconcile) **but the wrong tool the moment the "correct" number of rows can change between runs** — which is exactly what a one-to-many relationship like chunks introduces.

### Q8 — Name one concrete thing that could go wrong for Anchor's actual retrieval quality if chunk overlap were set to zero.
**Answer:** "dont know"

**Score: UNKNOWN.** A concrete, Anchor-specific scenario, building on Q4's example from the diagnostic teaching: imagine a chunk boundary happens to fall — purely by coincidence of where the 1000-character mark lands — right in the middle of a policy statement like *"Refunds are available within 30 days of purchase, except for enterprise annual contracts, which are non-refundable."* With zero overlap, chunk N might end with *"...except for enterprise annual contracts,"* and chunk N+1 begins with *"which are non-refundable. [continues with unrelated next paragraph]."*

Now a customer asks "are annual contracts refundable?" — a query that's going to match chunk N+1 very strongly (it directly contains "non-refundable" and "annual contracts"). If only chunk N+1 gets retrieved (a realistic outcome — retrieval picks the *most relevant* chunks, and chunk N+1 looks extremely relevant on its own), the AI receives *"which are non-refundable"* with **no idea what "which" refers to** — the antecedent (what specifically is non-refundable, and the fact that this is stated as an *exception* to an otherwise-refund-friendly policy) is sitting in chunk N, which may not have been retrieved at all if its own content matched the query less strongly. The AI could then generate a confusing, incomplete, or even flatly wrong answer — not because the extraction or chunking "failed" in any way an error would surface, but because a real, single, meaningful sentence got silently severed exactly at the one point where losing context matters most. Overlap doesn't eliminate this risk (an unlucky enough boundary can still land badly even with 150 characters of overlap), but it substantially reduces how often it happens, precisely by making it likely that the "except for..." clause shows up in *both* neighboring chunks rather than being stranded in only one.

### Closing quiz (round 1) result: **1 SOLID / 1 SHAKY / 6 UNKNOWN**

A modest but real improvement over the opening diagnostic's 0/2/8 — Q1 (the composite-unique-constraint reasoning) landed as genuinely SOLID this time, and Q5 got the right conclusion even with inverted reasoning. The most important correction in this round is Q2: the described failure mode (a crash mid-transaction permanently losing data, forcing a re-upload) is the *opposite* of what this phase's code and tests actually prove — worth re-reading Failure Case #2 above until the transaction-atomicity guarantee feels solid, since "wrap it in a transaction" is advice that's easy to repeat without having internalized what it actually buys you.

---

## Topics to master

Combining the opening diagnostic (0 SOLID / 2 SHAKY / 8 UNKNOWN) and the closing quiz (1 SOLID / 1 SHAKY / 6 UNKNOWN), ranked by transferable, interview-relevant weight — written with extra detail per the user's explicit request to make this phase doc interview-ready on its own.

### 1. Database transaction atomicity — what "rolled back" actually guarantees
**Search:** "database transaction ACID atomicity", "what happens if a transaction fails partway", "postgres transaction rollback on crash"
**Exposed by:** Q2 (closing quiz) — the single most important correction in this phase.
This is one of the highest-leverage facts in all of backend engineering: understanding that a transaction's failure-anywhere-inside-it guarantee is "as if none of it ran," not "whatever completed before the crash stays," is the difference between confidently reasoning about partial-failure scenarios and being genuinely afraid of them. Nearly every "our data got corrupted after a crash" incident in a real production system traces back to code that *assumed* multi-step writes were safe without ever actually wrapping them in a transaction — or, just as commonly, someone *thinking* something was transactional when it wasn't.

### 2. Composite unique constraints, and matching a constraint's shape to the relationship it protects
**Search:** "composite unique constraint SQL", "one-to-one vs one-to-many database design", "unique constraint on multiple columns"
**Exposed by:** Q1 (closing quiz) — the one genuinely SOLID answer this round, worth reinforcing rather than just moving past.
The general skill: recognizing whether uniqueness needs to be scoped to a whole table, to a single column, or to a *combination* of columns depends entirely on the shape of the relationship being modeled (one-to-one vs. one-to-many vs. many-to-many) — getting this wrong in either direction either silently allows real duplicates or actively prevents legitimate data from being inserted at all.

### 3. Tokens vs. words vs. characters (carried over from the opening diagnostic, still genuinely load-bearing)
**Search:** "LLM tokenization subword units", "tokens vs words count", "byte pair encoding tokenizer"
**Exposed by:** Diagnostic Q2.
Every sizing decision touching an embedding or LLM call — chunk size, overlap size, cost estimation, context-window budgeting — is denominated in tokens, and treating a token as a word produces systematically wrong estimates the moment real, non-trivial vocabulary (product names, jargon, non-English text) is involved. This will matter *immediately* in Phase 7, once real token counts start determining real API costs.

### 4. Idempotency shape must match cardinality: upsert (one-to-one) vs. delete-then-replace (one-to-many)
**Search:** "idempotent batch write pattern", "upsert vs delete and reinsert", "handling variable-length result sets on retry"
**Exposed by:** Q7 (closing quiz), and directly contrasts with Phase 5's `document_contents` upsert.
A genuinely transferable pattern-recognition skill: the *specific technique* that makes a write idempotent depends on whether the thing being written has a fixed shape (exactly one row, always — upsert works cleanly) or a variable shape (however many rows this particular run happens to produce — upsert alone can't clean up what a shorter run leaves behind; a replace-the-whole-set operation is required instead).

### 5. Chunk overlap as a concrete mitigation for boundary-severed meaning
**Search:** "text chunking overlap RAG", "chunk boundary context loss retrieval", "sliding window text splitting"
**Exposed by:** Q4 (opening diagnostic) and Q8 (closing quiz) — both still UNKNOWN, both circling the same underlying idea.
Ties directly to why Anchor exists: a retrieval system that silently returns a sentence stripped of the exception or qualifier that gave it its real meaning isn't "slightly less accurate" — it can produce a confidently wrong answer with no visible error anywhere in the pipeline, which is precisely the failure mode a citation-driven, trust-focused product like this one can least afford.

### 6. Separating "why does this happen at all" from "in what order does the code check for it" — reading code for its actual reasoning, not just its shape
**Search:** *(not a single searchable topic — a study habit)*
**Exposed by:** Q5, where the conclusion (chunking runs in the same job) was recalled correctly but the underlying reason was inverted.
Worth naming directly: getting the same *answer* a codebase actually implements, while holding a backwards explanation for *why*, is a specific and common failure mode that's easy to miss because the surface-level fact still checks out. The fix is deliberately not just "what does the code do" but "what would have to be true about this code for a *different* answer to have been chosen instead" — for this question, specifically: what would make chunking a *bad* fit for sharing Phase 5's job? (Answer: if it were slow or paid-API-bound — which is exactly what Phase 7 will be.)

---

## Interview questions this phase generates

- "You need a database constraint that prevents two rows from claiming the same *position within a group*, but allows unlimited rows across different groups. How do you model that in SQL, and why wouldn't a single-column unique constraint work?" (Q1)
- "Explain exactly what a database transaction rolling back means, in terms of what state the database ends up in versus what state it was in before the transaction started." (Q2)
- "You're processing a batch of related rows (e.g. chunks, line items, search-index entries) and need the operation to be safely retryable. When is `upsert` the right tool, and when does it fall short?" (Q7)
- "Two pipeline stages both need to run for every document. How do you decide whether they belong in the same job/transaction or should be split into separate stages?" (Q5)
- "Why would a text-chunking system deliberately make adjacent chunks overlap, instead of chunking as tightly as possible with zero waste?" (Q4/Q8)
- "Write a loop that splits a string into fixed-size pieces with a 'nicer' cut point when possible. What's the one thing you have to guarantee to avoid an infinite loop?" (Q4, diagnostic)

---

## What's still not understood

Genuine progress from the opening diagnostic (0/2/8 → 1/1/6), but six of ten questions remain UNKNOWN after one teaching pass, and one (Q2, transaction rollback) surfaced a real, actively-wrong mental model rather than just a gap — worth re-verifying this one has actually landed before it matters in a real incident, not just in this phase's tests. Also still open: `snapToBoundary()`'s exact search mechanics (Q3), the infinite-loop-prevention line and why it's needed (Q4), and the precise purpose of `char_start`/`char_end` versus `content_hash` (Q6) — all fairly mechanical, code-reading-level gaps that a careful pass through `chunking.ts` and `document-processing.processor.ts` alongside this doc's Code Walkthrough section should close faster than the more conceptual gaps above.

Phase 7 (embeddings) will make Q5's inverted reasoning matter immediately and concretely — the moment a real, paid, rate-limited API call enters the pipeline, the "why is this a separate stage" question stops being abstract.

