# Phase 13 — Hybrid search (vector + keyword)

**Depends on:** Phase 8 (vector similarity search) · **Introduces:** Postgres full-text search, rank fusion

---

## Objective, and why the system actually needs it

Phase 8 gave this project one way to find relevant chunks: embed the question, compare it to every chunk's embedding by cosine distance, take the closest `k`. That is *semantic* search — it matches on meaning.

It has a specific, well-known blind spot, and this phase exists to close it. An embedding compresses a whole chunk of text into 768 floating-point numbers. That compression is what lets it understand that "how do I get my money back" and "refunds are available" are about the same thing. But compression loses detail, and the detail it loses first is **rare, exact strings that carry no semantic meaning on their own**: product SKUs, error codes, version numbers, invoice IDs, acronyms, surnames.

`E-4021` does not *mean* anything. There is no region of embedding space where "error codes about firmware" lives. Ask a vector search for `E-4021` and you get chunks that are vaguely about errors, or vaguely about firmware, ranked by a similarity that never had the information needed to distinguish `E-4021` from `E-4022`.

Keyword search has the exact opposite profile. It is perfect at `E-4021` and useless at "money back" when the document says "refund".

**Hybrid search runs both and merges the results.** Neither is a replacement for the other; the whole point is that their failure modes do not overlap.

### The measured version of that claim, from this project's own database

Every number below was produced by running the query against this repo's Postgres, not recalled from documentation.

Vocabulary mismatch — keyword search failing where vector search succeeds:

```sql
SELECT ts_rank(to_tsvector('english','Refunds are available within 30 days of purchase.'),
               plainto_tsquery('english','money back'));
-- 1e-20     (i.e. no match at all)
```

Phase 7's own test proves the other side of this: "Refunds are available within 30 days of purchase" and "How do I get my money back?" share **zero words**, and embedding them puts them closer together than either is to a sentence about shipping. Earlier in this project, the real measured cosine distance for "How do I get a refund?" against the refund chunk was **0.311**, versus **0.549** for "What is the capital of France?".

Exact-token matching — keyword search succeeding where vector search is weak:

```sql
-- content: 'Error code E-4021 means the device firmware is out of date.'
SELECT ts_rank(content_tsv, plainto_tsquery('english','E-4021'));
-- 0.09910322   — found precisely, on the exact token
```

---

## The diagnostic (Step 0)

Asked before any teaching. Answers recorded verbatim, scored SOLID / SHAKY / UNKNOWN, then explained.

**Result: 0 SOLID · 3 SHAKY · 9 UNKNOWN.**

For context rather than judgement, that is the same shape as this project's other RAG-internals phases on first exposure — Phase 5 opened 0/0/10, Phase 6 opened 0/2/8, Phase 7 opened 1/4/7. The phases that touch pre-existing full-stack strength (Phase 11's 6/3/2) open far higher. This is a consistent, expected pattern, and the phases where it happened have still produced real improvement by the closing quiz.

---

### Q1. Give a concrete question where vector search fails to find a chunk that is right there. What's the general category?

**Your answer:** *"i tested this 'tell me about your company what you do?' and it is a valid question but AI refused to answer due to distance was high"*

**Score: SHAKY** — and worth reading carefully, because you reported a *real, observed* failure from your own system, which is more valuable than a textbook answer. But it is a different failure from the one this phase fixes, and conflating them would send you looking in the wrong place.

**What you found is real.** "Tell me about your company, what do you do?" is a **broad, diffuse query**. There is no single chunk that is specifically about it; the answer is spread thinly across many chunks, or is genuinely absent (a refund policy PDF says nothing about what the company does). Every chunk is moderately far away, `minDistance` lands above 0.45, and Phase 10 refuses.

**Hybrid search will not fix that.** Keyword search on "company", "do" will not rescue it either — those are common words that match weakly everywhere, and `plainto_tsquery` ANDs terms together, so it may match nothing at all. The real fixes for broad queries are different tools: query expansion, a summary-level chunk per document, or simply having a document that answers the question. Worth knowing that distinction — it is exactly the kind of thing that separates "I've read about RAG" from "I've operated one."

**The category this phase targets** is the opposite: **narrow, exact-token queries**. A customer typing `E-4021`, `SKU-88231`, `v2.14.3`, or an invoice number. These are high-information strings with no semantic content. Embeddings smear them; keyword search nails them.

A useful way to hold both:

| Query shape | Vector | Keyword |
|---|---|---|
| "how do I get my money back" (paraphrase) | ✅ strong | ❌ fails |
| "E-4021" (rare exact token) | ❌ weak | ✅ exact |
| "tell me about your company" (broad/diffuse) | ❌ weak | ❌ weak |

The third row is why hybrid search is an improvement, not a cure.

---

### Q2. Give a question where keyword fails but vector succeeds.

**Your answer:** *"dont know"*

**Score: UNKNOWN** — noting that your own codebase already contains the canonical demonstration, in Phase 7's test suite.

**The answer: any paraphrase.** The document says "Refunds are available within 30 days of purchase." The customer asks "How do I get my money back?" Those share **not one word**. Keyword search scores it `1e-20` — measured above, effectively zero. Vector search scored the same pair at **0.311** cosine distance, comfortably inside Phase 10's 0.45 confidence threshold.

This is called the **vocabulary mismatch problem**, and it is the entire reason embeddings got adopted for retrieval. Humans describe the same concept with different words — "cancel my plan" / "end my subscription" / "stop being charged" — and a system that matches on characters cannot connect them.

**Interview framing:** vector search solves vocabulary mismatch; keyword search solves exact-token precision. Naming both, and knowing which is which, is the whole conceptual content of hybrid retrieval.

---

### Q3. What does `to_tsvector('english', …)` produce, and how does it differ from storing the string?

**Your answer:** *"dont know"*

**Score: UNKNOWN**

Run on this project's own database:

```sql
SELECT to_tsvector('english', 'Refunds are available within 30 days of purchase, provided the item is unused.');
```
```
'30':5 'avail':3 'day':6 'item':11 'provid':9 'purchas':8 'refund':1 'unus':13 'within':4
```

A `tsvector` is **not a string**. It is a sorted set of **lexemes** with their positions. Three transformations happened:

1. **Tokenisation** — the sentence was split into words, and punctuation discarded.
2. **Stop-word removal** — `are`, `of`, `the`, `is` are *gone entirely*. They appear in nearly every English sentence, so they carry almost no signal about which document you want, and indexing them would bloat the index for nothing.
3. **Stemming** — words were reduced to root forms: `Refunds → refund`, `available → avail`, `purchase → purchas`, `unused → unus`, `provided → provid`. Note `purchas` and `avail` are not real English words; a stemmer does not produce dictionary words, it produces a *normalised key* that different inflections of the same word collapse onto.

The numbers (`'refund':1`) are **positions** in the original text, which is what lets Postgres support phrase search and lets `ts_rank` reward terms appearing near each other.

**Why it matters:** because of stemming, a search for `refunded` matches a document containing `Refunds` — verified:

```sql
SELECT to_tsvector('english','Refunds are available within 30 days of purchase.')
       @@ plainto_tsquery('english','refunded');
-- t   (true)
```

Storing the raw string would give you `LIKE '%refund%'`, which cannot do that, cannot rank, and cannot use a normal index.

**Analogy:** a `tsvector` is to a paragraph what a book's index is to the book. You do not store the sentences in the index; you store *the words that matter, normalised, with page numbers*.

---

### Q4. Why does `'english'` matter — what changes with `'simple'`?

**Your answer:** *"dont knoe"*

**Score: UNKNOWN**

The first argument is the **text search configuration**: it selects the stop-word list and the stemmer. Same sentence, `'simple'`:

```
'30':5 'are':2 'available':3 'days':6 'is':12 'item':11 'of':7 'provided':9
'purchase':8 'refunds':1 'the':10 'unused':13 'within':4
```

Compare to the `'english'` output above. With `'simple'`:
- **Nothing was stemmed** — `refunds` stayed `refunds`, `available` stayed `available`.
- **Nothing was removed** — `are`, `of`, `the`, `is` are all still there.

`'simple'` just lowercases and splits. The consequence is concrete and bad for a support bot: a customer searching "refund" would **not** match a document saying "Refunds", because `refund ≠ refunds` as exact lexemes.

**The trap that bites people in production:** the configuration used at *write* time and at *query* time must match. Index with `'english'` and query with `'simple'` and you are comparing `refund` against `refunds` — silently zero results, no error. This is why the configuration is written explicitly in both places in this codebase rather than relying on the database's `default_text_search_config`, which is a server setting someone can change underneath you.

Use `'simple'` deliberately when you *want* exact forms — product codes, usernames, tags.

---

### Q5. What index type makes full-text search fast, and why is it different from HNSW?

**Your answer:** *"it is simple btree index"*

**Score: UNKNOWN** — this is the one answer that is specifically incorrect rather than absent, so it is worth understanding *why* B-tree cannot do this job. That reasoning transfers to every index-selection decision you will ever make.

**The answer is GIN** (Generalized Inverted Index).

**Why not B-tree.** A B-tree indexes **one value per row**, kept in sorted order. That makes it excellent for `WHERE id = 5`, `WHERE created_at > …`, `ORDER BY email` — questions about *whole values* and their ordering. But a `tsvector` is not one value, it is a *set* of lexemes, and the question being asked is the inverse: "which rows contain the lexeme `refund`?" A B-tree on a `tsvector` column could only find rows whose *entire lexeme set* equals some other entire lexeme set, which is useless.

**What GIN does instead.** "Inverted" means the mapping runs backwards from what you would naively store. Instead of `row → its words`, GIN stores `word → the rows containing it`:

```
'refund'  → [chunk 7, chunk 12, chunk 88]
'purchas' → [chunk 7, chunk 41]
'firmwar' → [chunk 23]
```

Searching for `refund` becomes a direct lookup of one key, returning a posting list. That is exactly the structure a book index uses, and exactly what every search engine is built on.

**Why HNSW is a third thing entirely.** Phase 7 added HNSW for the `embedding` column. HNSW answers a completely different question — not "which rows contain this key" (an exact set-membership question) but **"which rows are *nearest* to this point in 768-dimensional space"** — a question with no exact answer, only closer and further. It builds a navigable graph of vectors and walks it greedily toward the query point, trading a small chance of missing the true nearest neighbour for an enormous speedup.

The unifying idea, which is the genuinely transferable lesson: **an index is a data structure shaped like the question you intend to ask.** Three different questions, three different structures:

| Question | Structure |
|---|---|
| "equal to / greater than / in order" | B-tree |
| "contains this term" | GIN (inverted index) |
| "nearest in vector space" | HNSW (ANN graph) |

---

### Q6. What's wrong with averaging a cosine distance and a `ts_rank` score?

**Your answer:** *"we will first try to go with semantic search distance if it refusing than we will check vector search if it is according to defined threshold than we will go with it, we cant do avg because both can return different results"*

**Score: SHAKY** — you correctly rejected averaging, and you proposed a concrete alternative design, which is more than a blank. What is missing is the specific reason.

**What you got right:** averaging is wrong, and a fallback strategy ("try one, and if it refuses, try the other") is a genuinely real design that some systems use. It is simpler than fusion and worth knowing as an option.

**What was missing — the actual mechanism.** "Both can return different results" describes the *sets* being different. The fatal problem is that the two **numbers are not the same kind of number**:

| | Cosine distance | `ts_rank` |
|---|---|---|
| Direction | **Lower is better** (0 = identical) | **Higher is better** (0 = no match) |
| Range | 0 to 2, bounded | ~0 to ~1 in practice, but unbounded in principle |
| Meaning | An angle between two vectors | A term-frequency weighting |

Averaging `0.21` and `0.89` produces `0.55`, a number that means *nothing*. You have added a quantity where small is good to a quantity where large is good. A chunk could be the best semantic match and the best keyword match and score mid-range; a mediocre result could score identically. The units are incompatible in the same way that averaging a temperature in Celsius with a distance in miles is incompatible.

There is a second, subtler problem even after fixing polarity: **`ts_rank` values are not comparable across different queries.** A rank of 0.09 might be the best possible result for one query and mediocre for another, because the value depends on term frequency and document length. So you cannot pick a fixed number as "good enough" the way Phase 10 did for cosine distance.

**Your fallback idea, assessed honestly:** it works, and it avoids the units problem entirely by never combining the numbers. Its weakness is that it cannot use *agreement* as a signal — a chunk that both methods rank highly is very likely the right answer, and a fallback design throws that information away. That is precisely what fusion exploits.

---

### Q7. How else could you combine two ranked lists?

**Your answer:** *"dont know"*

**Score: UNKNOWN**

**The key move: stop using the scores, and use the *ranks*.** Position in a list — 1st, 2nd, 3rd — is the one thing both searches produce that means the same thing in both. "Best result this method found" is comparable across methods in a way that 0.21 and 0.89 are not.

The standard technique is **Reciprocal Rank Fusion (RRF)**. For each chunk, sum a contribution from every list it appears in:

```
score(chunk) = Σ  1 / (k + rank_in_that_list)
```

`k` is a constant, conventionally **60**. Working the diagnostic's own example (`k=60`):

| Chunk | Vector rank | Keyword rank | RRF score |
|---|---|---|---|
| A | 1 | 3 | 1/61 + 1/63 = **0.0323** |
| C | 3 | 1 | 1/63 + 1/61 = **0.0323** |
| B | 2 | — | 1/62 = **0.0161** |
| D | — | 2 | 1/62 = **0.0161** |

A and C tie at the top — correct, since each is 1st in one list and 3rd in the other. B and D tie below them, each appearing in only one list.

**Why reciprocal, and why `k`:** `1/rank` makes the gap between 1st and 2nd much larger than between 9th and 10th, which matches how relevance actually behaves. The `+k` damps that curve so a single 1st place cannot automatically beat strong agreement further down; with `k=60`, ranks 1 and 2 differ by only ~2%, so appearing in *both* lists matters more than winning one narrowly.

**Why this is genuinely elegant:** RRF needs no score normalisation, no tuning per corpus, and no knowledge of what the underlying scores even mean. It works for two lists or ten. It is the default in Elasticsearch and OpenSearch hybrid search for exactly that reason.

---

### Q8. Should a chunk in only one list be able to outrank one in both?

**Your answer:** *"dont know"*

**Score: UNKNOWN**

**Both positions are defensible, which is why the question is worth asking:**

- *It should be able to.* A customer searching `E-4021` has one correct chunk. Vector search will not surface it. If appearing in both lists were required, exact-token lookup — the entire reason for adding keyword search — would break.
- *It should not be able to.* Agreement between two independent methods is strong evidence. A chunk both rank highly is very likely genuinely relevant.

**What RRF actually does** is the compromise, and it falls out of the arithmetic rather than being bolted on. From the table above: a chunk ranked 1st in one list only scores `1/61 = 0.0164`. A chunk ranked 3rd in *both* scores `1/63 + 1/63 = 0.0317` — nearly double. So **consistent moderate agreement beats a single strong showing**, but a first-place-in-one-list result still lands well above things that appeared nowhere.

You tune this with `k`. A small `k` (say 1) makes rank 1 dominate hugely and favours single-list winners; a large `k` flattens the curve and favours agreement. `k=60` is the widely used middle.

---

### Q9. Phase 10's `CONFIDENT_DISTANCE_THRESHOLD = 0.45` — what breaks?

**Your answer:** *"dont know"*

**Score: UNKNOWN** — and this is the most important question in the set, because it is about *your own code breaking*, not about hybrid search in the abstract.

Phase 10's `AnswerService` does this:

```ts
const minDistance = chunks.length > 0 ? chunks[0].distance : null;
if (minDistance === null || minDistance >= CONFIDENT_DISTANCE_THRESHOLD) {
  // refuse — never call the LLM
}
```

That threshold is not arbitrary. It was **measured**: a genuinely related question scored ~0.22, an unrelated one ~0.56, so 0.45 sits between the observed populations. It is meaningful *because it is a cosine distance*.

**What breaks.** After fusion, `chunks[0]` is the top result by **RRF score**, and an RRF score is not a distance:
- It runs the **wrong direction** — higher is better.
- Its **scale is unrelated** to 0.45; the worked example above tops out at 0.0323. Every single result would be `< 0.45`, so the refusal check would **never fire**. The system would stop refusing entirely and confidently answer from irrelevant chunks — a silent, dangerous regression, not a crash.
- Its value **depends on how many lists a chunk appeared in**, not on how similar it is to anything.

**How this phase must handle it** (a design decision, decided in the design step, not assumed here): the cosine distance has to be *carried through* fusion rather than replaced by it. The fused ranking decides the **order**; the top chunk's real cosine distance still decides **confidence**. Those are two separate jobs that Phase 8 and 10 happened to serve with one number, and hybrid search is what forces them apart.

This is a good instinct to generalise: **when you change how something is ranked, go and find every consumer that was reading meaning into the old ranking's numbers.**

---

### Q10. What would you add to `document_chunks`, and would you compute it on write or on query?

**Your answer:** *"vector search result maybe"*

**Score: UNKNOWN**

**What to add: a `tsvector` column**, derived from `content`.

**Compute on write, not on query**, and the reasoning is the same reasoning behind the `embedding` column already in that table. Computing `to_tsvector(content)` inside the query means:
- Postgres must compute it for **every row in the workspace** on **every search**, before it can filter — the definition of a sequential scan.
- **You cannot index it.** An index stores precomputed values; if the value is computed at query time, there is nothing to have indexed.

Postgres has a purpose-built feature here, verified working on this project's PG18:

```sql
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```

A **stored generated column**: Postgres maintains it automatically on every insert and update, it cannot drift from `content`, and no application code has to remember to populate it. Then a GIN index on it makes lookups fast.

The general principle, which is the reusable part: **precompute anything derived and immutable at write time; query time is for filtering and ranking, not for transformation.** The `embedding` column is the identical pattern — this project already pays an expensive Gemini call once per chunk at write time rather than embedding documents during a customer's request.

---

### Q11. One query or two?

**Your answer:** *"more latency and cpu computation"*

**Score: SHAKY** — you correctly identified the real cost of the two-query approach. What is missing is the other side of the trade and which way to go.

**Two round trips** means two network hops to Postgres and two result sets assembled in Node. Your "more latency" is right, and it matters more than it looks: Phase 8 made retrieval **synchronous** — a live customer is waiting, unlike every background job in Phases 4-7.

**One query** does both rankings in a single statement using CTEs:

```sql
WITH vector_hits AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank ...
), keyword_hits AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, query) DESC) AS rank ...
)
SELECT ... FROM vector_hits FULL OUTER JOIN keyword_hits USING (id) ...
```

Cost: one denser, harder-to-read piece of SQL. Benefit: one round trip, and Postgres fuses the two lists with `ROW_NUMBER()` — exactly the rank-not-score input RRF needs — without shipping both lists to Node.

**Important subtlety neither option escapes:** the vector side still needs the **query embedding**, which is a real Gemini API call that must happen in Node *before* any SQL runs. So "one query" means one *database* round trip, not one network call overall. That embedding call already dominates the latency budget.

---

### Q12. No keyword overlap and no close chunk — what should happen, and whose code decides?

**Your answer:** *"dont know"*

**Score: UNKNOWN**

**What should happen: the system refuses, and never calls the LLM.**

**Whose code decides: `AnswerService` (Phase 10).** Not the retrieval layer. This split already exists in your codebase and is worth seeing clearly:

- `RetrievalService` (Phase 8) answers *"what are the closest chunks?"* — and always returns up to `k` rows, **regardless of quality**. It has no opinion about whether they are good.
- `AnswerService` (Phase 10) answers *"is the best of those good enough to ground an answer?"* — and refuses if not, short-circuiting before any generation call.

Concretely, for a question matching nothing, retrieval returns 5 mediocre chunks, `minDistance` lands around 0.55+, the threshold check fires, and `AnswerService` returns `status: 'refused'` with the configured fallback phrase — **without spending a Gemini call**, which is both the cheap and the safe outcome.

That is also exactly what you observed in Q1. Your "tell me about your company" case ran this path correctly. The behaviour was right; whether the *threshold* is right for broad queries is a separate, real question.

---

## Topics you must know before moving on, ranked by how load-bearing they are

1. **Vocabulary mismatch vs exact-token matching** (Q1, Q2) — the entire justification for this phase. If only one idea survives, make it this one.
2. **Score incomparability, and rank fusion as the fix** (Q6, Q7, Q8) — the central technique, and the reason RRF exists at all.
3. **Ranking changes break downstream consumers of the old numbers** (Q9) — the one that will actually bite this codebase, in `AnswerService`.
4. **Inverted index vs B-tree vs ANN — an index is shaped like its question** (Q5) — transfers to every database you ever touch.
5. **`tsvector`: lexemes, stemming, stop words, and matching configs at write and query time** (Q3, Q4) — the mechanics.
6. **Precompute derived values at write time** (Q10) — a general engineering principle this codebase already applies to `embedding`.
7. **Retrieval ranks; the answer layer judges** (Q11, Q12) — the separation of concerns already present in Phases 8 and 10.

---

---

## What the measurements actually showed — and why it changed the design

This is the most valuable part of the phase, and it contradicts the justification written at the top of this document.

**The plan was:** add keyword search, fuse with RRF, and add a second "lexical confidence" path so that a chunk found only by its exact token could still clear Phase 10's threshold — since the textbook claim is that embeddings smear rare exact tokens, such a chunk's cosine distance would be bad.

**Before writing the test to prove it, the premise was measured.** A throwaway probe embedded a query, a target chunk containing the rare token, and a semantically-plausible decoy that did not, then compared real cosine distances:

| scenario | target | decoy | outcome |
|---|---|---|---|
| bare code query (`E-4021`) | **0.250** | 0.479 | vector wins |
| code in a long chunk, natural question | **0.319** | 0.440 | vector wins |
| SKU in a long chunk | **0.263** | 0.416 | vector wins |
| version number (`v2.14.3`) | **0.291** | 0.403 | vector wins |
| adversarial: code buried in off-topic chunk, decoy on-topic | 0.430 | **0.400** | **vector fails** |
| adversarial: SKU buried, decoy on-topic | **0.359** | 0.417 | vector wins |

**Gemini's embedding model handles rare exact tokens well.** Five of six scenarios ranked the right chunk first, every one of them comfortably inside Phase 10's 0.45 threshold. Even the single failure scored the right chunk at 0.430 — still below the threshold, so semantic confidence would have covered it anyway.

**Consequence 1: the lexical confidence path was deleted before it shipped.** It would have been a guessed constant gating a failure mode that could not be demonstrated. That is exactly what Phase 10 refused to do when it declined to invent a confidence middle-zone without data, and the project's own guidance against building for scenarios that cannot happen. `SELECTIVE_KEYWORD_MATCH_LIMIT` and the extra selectivity query it required were both removed — the latter also saving a database round trip on a synchronous, customer-facing path.

**Consequence 2: a test was caught passing for the wrong reason.** The original test asserted "answers from a rare exact-token match whose cosine distance is NOT semantically confident". It passed. Adding an assertion of its own premise — `expect(minDistance).toBeGreaterThanOrEqual(0.45)` — made it fail immediately, revealing the real distance was **0.250**. The test had been exercising the semantic path the whole time while claiming to prove the lexical one. **A test that does not assert its own premise can pass for reasons that have nothing to do with what it claims.**

**Consequence 3 — the genuinely surprising technical finding: `ts_rank` has no IDF.** Three attempts were made to build a corpus where fusion demonstrably rescues the right chunk. The instructive failure:

```
decoy   vectorRank=1 keywordRank=1 rrf=0.03279 distance=0.338
buried  vectorRank=2 keywordRank=2 rrf=0.03226 distance=0.438
```

The decoy won **both** searches. Keyword search preferred it because the query (`what should I do about error E-4021 on my device?`) contributes several common lexemes — `error`, `devic` — which the decoy contains repeatedly, while the target contains only the single rare `-4021`. Postgres's `ts_rank` scores by weighted term frequency and **has no inverse-document-frequency component**: it does not know that `-4021` is rare and `error` is common. BM25, which does, is not available in core Postgres (it needs an extension such as ParadeDB's `pg_search`).

This is a real, production-relevant limitation and the single most useful thing learned in this phase: **OR-semantics keyword search ranked by `ts_rank` rewards matching many common terms over matching the one distinctive term**, which is the opposite of what a rare-token lookup needs. It is why the implementation keeps OR semantics (needed for recall — see below) but does not lean on `ts_rank` for confidence.

**What is still genuinely true, and is what the tests now assert:**
- Keyword search pins an exact token with **perfect precision** — exactly one chunk contains `E-4021`, and the lexical side ranks precisely it first with zero near-misses.
- Fusion correctly rewards agreement: a chunk both searches rank well outscores one found by a single search.
- Hybrid search does not regress the vocabulary-mismatch case that motivated embeddings in the first place.
- One test now **encodes the surprising measurement itself**, asserting that the current model ranks the rare token inside the top k unaided — so the day a model swap, a dimension change, or a much larger corpus makes hybrid search's contribution real, it becomes visible rather than silently assumed.

**Honest summary of this phase's value:** the implementation is correct, tested, and standard production practice, and it adds a genuinely precise lexical path plus real rank transparency. But on this corpus with this embedding model, **it was not possible to demonstrate an end-to-end answer that hybrid search improved.** Its value should be expected to appear with a much larger corpus, a weaker or smaller embedding model, or a language where the model is less strong — and Phase 17 (Evaluations) is the phase equipped to prove or disprove that with real outcome data rather than constructed examples.

## A correction to the plan, caught by measurement

The architecture proposal specified `plainto_tsquery`. Run against real data, that turned out to be wrong:

```sql
SELECT plainto_tsquery('english','How do I fix error E-4021 on my device?');
-- 'fix' & 'error' & 'e' & '-4021' & 'devic'
```

Every term is **ANDed**. The chunk that actually contains `E-4021` does not match, purely because it lacks the word "fix". Shipping that would have meant a keyword path contributing essentially nothing to real conversational questions. The implementation instead builds an **OR** query from the question's own stemmed lexemes:

```sql
to_tsquery('english', (SELECT string_agg(lexeme, ' | ') FROM unnest(to_tsvector('english', $1))))
```

A question made only of stop words yields an empty `tsvector`, so `string_agg` returns `NULL`, `to_tsquery(NULL)` is `NULL`, and `tsv @@ NULL` is never true — the keyword side contributes nothing and retrieval degrades cleanly to pure vector search rather than erroring. That degenerate case has its own test.

---

## Migrations: what each table and column actually stores

### `AddContentTsvToDocumentChunks` — one new column, one new index on `document_chunks`

**`content_tsv` (`tsvector`, nullable, `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`)**

Stores the **searchable form** of the same text already in `content` — not a copy of it. Where `content` holds `'Refunds are available within 30 days of purchase.'`, this column holds:

```
'30':5 'avail':3 'day':6 'purchas':8 'refund':1 'within':4
```

Three things happened to produce that, and each matters:
- **Stop words removed** — `are`, `of`, `the` are gone. They appear in nearly every sentence, so they cannot help pick one chunk over another, and indexing them would bloat the index for no discrimination.
- **Words stemmed** — `Refunds → refund`, `available → avail`, `purchase → purchas`. These are not dictionary words; they are normalisation keys, so that a search for `refunded` finds a chunk saying `Refunds`.
- **Positions kept** — the `:5` in `'30':5` is the word's position in the original text, which is what allows phrase search and lets `ts_rank` reward terms appearing near one another.

**`GENERATED ALWAYS ... STORED` is the important part of the column definition.** Postgres computes and re-computes this itself on every `INSERT` and every `UPDATE` of `content`. No application code writes it — in fact Postgres *rejects* any attempt to (there is a test asserting exactly that). This makes it structurally impossible for the search index to drift out of sync with the text it indexes, which is the failure mode a manually-maintained column would eventually hit.

Nullable only because the column was added to a table that already had rows; every row has a value in practice.

**`IDX_document_chunks_content_tsv` — a GIN index on that column**

GIN stands for Generalized **Inverted** Index. "Inverted" means the mapping runs the opposite way from how the table stores it:

```
table:  chunk 7  → {refund, avail, day, purchas}
index:  'refund' → [chunk 7, chunk 12, chunk 88]
```

Searching for `refund` becomes one key lookup returning a list of chunk ids, instead of reading every chunk. This is the same structure as a book's index, and the reason it cannot be a B-tree is that a B-tree sorts **whole values** — it can answer "which row equals this entire lexeme set", which is useless, but not "which rows contain this one lexeme".

`document_chunks` now carries **three** indexes serving three different questions, which is the clearest illustration in this codebase of index-as-shaped-like-its-question:

| Index | Type | Answers |
|---|---|---|
| `IDX_b371ff8bc1e4f65fc3d01420be` | btree (`document_id`) | "which chunks belong to this document" |
| `IDX_document_chunks_embedding_hnsw` | HNSW (`embedding`) | "which chunks are nearest in meaning" |
| `IDX_document_chunks_content_tsv` | GIN (`content_tsv`) | "which chunks contain this word" |

---

## Complete data flow

```
POST /workspaces/:id/ask   { question }
        │
        ▼
AnswerService.answer()
        │
        ▼
RetrievalService.retrieveRelevantChunks()
        │
        ├─► EmbeddingProvider.embed(question)      ← real Gemini call, the latency floor
        │        └─► 768 floats → "[0.1,0.2,…]" literal
        │
        └─► ONE SQL statement:
              q              build an OR tsquery from the question's own stemmed lexemes,
                             each one single-quoted so operator characters stay literal
              candidates     every chunk in THIS workspace (the tenant filter, applied once,
                             before either search — so neither can reach another tenant)
              vector_hits    ORDER BY embedding <=> query  → ROW_NUMBER() = vectorRank, LIMIT 20
              keyword_hits   ORDER BY ts_rank(content_tsv, q) DESC → keywordRank, LIMIT 20
              fused          FULL OUTER JOIN on chunk id
                             rrf = 1/(60+vectorRank) + 1/(60+keywordRank), missing side = 0
              final SELECT   ORDER BY rrf DESC, LIMIT k — and compute the real cosine
                             distance for every surviving row, whichever search found it
        │
        ▼
AnswerService: minDistance = MIN(distance) across the returned chunks
        │                    (NOT chunks[0] any more — the list is RRF-ordered, so the
        │                     closest chunk can sit anywhere in it)
        ▼
   minDistance >= 0.45 ? ──yes──► refused, LLM never called
        │
        no
        ▼
   fetch session history → build prompt → Gemini → parse [n] citations → persist Conversation
```

---

## Code walkthrough

### `retrieval.service.ts` — the one statement

**`q` CTE.** Builds the keyword query from the question. Two decisions live here, both forced by real measurements:

1. **OR, not AND.** `plainto_tsquery` ANDs every term; measured against real data, `'How do I fix error E-4021 on my device?'` became `'fix' & 'error' & 'e' & '-4021' & 'devic'`, and the chunk containing the code did not match because it lacked the word "fix".
2. **Each lexeme single-quoted.** Lexemes can contain tsquery's own operator characters, and unquoted those get reinterpreted rather than matched. See Failure Cases below — this one silently returned wrong results rather than erroring.

Both degrade safely: a question of only stop words yields an empty `tsvector`, so `string_agg` returns `NULL`, `to_tsquery(NULL)` is `NULL`, and `tsv @@ NULL` is never true. The keyword side contributes nothing and retrieval falls back to pure vector search.

**`candidates` CTE.** The workspace filter, applied **once, before either search runs**. Every chunk both searches can see has already been scoped to the caller's tenant — the isolation cannot be forgotten in one branch and remembered in the other.

**`vector_hits` / `keyword_hits`.** Each produces a `ROW_NUMBER()`, which is the whole trick: RRF consumes **ranks**, not scores, and ranks are the one output both searches produce that means the same thing. `LIMIT 20` (`CANDIDATE_POOL`) rather than `LIMIT k` — if each side returned only 5, the cases hybrid search exists for (ranked 8th by one search, 1st by the other) would be discarded before fusion ever saw them.

**`fused`.** `FULL OUTER JOIN`, because the entire point is that a chunk may appear in only one list. `COALESCE` is applied to the **score contribution**, not to the rank — a missing side contributes `0`, while the rank itself stays `NULL` and is returned as real information about which search found what.

**Final `SELECT`.** Orders by the fused score, and separately computes `embedding <=> $3::vector` for every surviving row, including chunks only keyword search found. That is what keeps Phase 10's confidence check meaningful: ranking and confidence are now two jobs, and only the first one changed.

### `answer.service.ts` — the line that had to change

```ts
// before: chunks were distance-ordered, so chunks[0] WAS the minimum
const minDistance = chunks.length > 0 ? chunks[0].distance : null;

// after: the list is RRF-ordered, so the closest chunk can be anywhere in it
const distances = chunks.map((c) => c.distance).filter((d) => Number.isFinite(d));
const minDistance = distances.length > 0 ? Math.min(...distances) : null;
```

This is the concrete answer to diagnostic Q9. The old line would not have crashed or errored after this phase — it would have kept running and quietly read the wrong number, handing Phase 10's threshold a distance that was merely *first by fused rank* rather than *closest*. **A ranking change silently invalidates every downstream consumer that was reading meaning into the old ordering.**

---

## Failure cases actually tested

1. **Stop-words-only question.** Predicted: `to_tsquery(NULL)`, no keyword hits, clean fallback to vector search. Triggered with `'the and of it'` — confirmed: `keywordRank` null on every chunk, results still returned, no error.

2. **A word that matches every chunk.** Predicted: the keyword side returns everything and the final `LIMIT k` is what prevents it dominating. Triggered with a corpus where all six chunks contain "available" — confirmed: exactly `k` rows returned, all with a non-null `keywordRank`.

3. **Writing to the generated column.** Predicted: Postgres rejects it outright. Triggered with a direct `UPDATE document_chunks SET content_tsv = …` — confirmed it throws, which is what makes the column's sync guarantee structural rather than conventional.

4. **Updating `content` behind the index's back.** Predicted: `content_tsv` follows automatically. Triggered by updating a chunk's text from a refund sentence to a shipping sentence — confirmed the vector now contains `'ship'` and no longer contains `'refund'`, with no application code involved.

5. **Cross-tenant leakage via the new search path.** Phase 13 opened a second route into `document_chunks`, so isolation had to be re-proven rather than assumed. An exact-token query from a workspace that does not own the matching chunk returns nothing.

6. **A URL containing a colon — the real bug this step found.** This one was *not* predicted from the code; it came from deliberately probing what a lexeme is allowed to contain. `to_tsvector('english', 'https://example.com/a:b')` produces a lexeme ending in a colon. Pasted unquoted into a tsquery, `to_tsquery` reads that colon as a **weight filter** and produces `'/a':B`. Because plain `to_tsvector` assigns weight **D** to everything in `content_tsv`, that term then matches **nothing** — and critically, **it does not error**. The query succeeds, returns fewer results than it should, and nothing anywhere reports a problem. Fixed by single-quoting each lexeme; the test asserts the keyword side actually matches a chunk containing such a URL.

   The transferable lesson is not about Postgres: **the dangerous class of bug is the one that degrades a result instead of raising an error.** A crash gets found in minutes. A silently narrowed search gets found in months, by a customer.

7. **A five-hour timezone skew between JS-written and Postgres-written timestamps — found by a full-suite failure, and the most consequential bug in this session.** It has nothing to do with hybrid search; the full run simply happened to execute just after local midnight, which is the only window in which it is visible.

   **Measured, not inferred:**

   ```
   stored:        via_js = 2026-09-27 04:21:28.404      (JS `new Date()`)
                  via_pg = 2026-09-26 23:21:28.409      (Postgres now())
                  skew   = 18000 seconds   ← exactly 5 hours
   computed wait: from the JS-written value  = -18000 seconds
                  from the PG-written value  =      0 seconds
   ```

   **Mechanism.** Every timestamp column in this schema is `timestamp without time zone`. node-postgres serialises a JS `Date` into the **host's local wall clock**, so on this UTC+5 machine `new Date()` stored `04:21` while `now()` stored `23:21` the previous day. Two different clocks were writing into the same column type, and nothing anywhere complained.

   **What it actually broke.** `ConversationSession.escalatedAt` was written with `new Date()`, but every wait time is computed in SQL as `now() - escalated_at`. That yields **minus five hours** — and `GREATEST(..., 0)` in `listQueue` then flattened it to zero. So **every real escalation in the agent console displayed "0m 00s" forever and could never reach High priority.** The defensive clamp I had written to keep the UI tidy was the very thing hiding the bug. `Document.readyAt` had the same cause with cosmetic effect: the "Last indexed" column showed a time five hours in the future, which had been visible in real data all along (`createdAt 01:31Z` vs `readyAt 06:31Z` for the same document) without anyone reading it as a defect.

   **Fix.** Both writes now use Postgres' own `now()`, matching what `createdAt`/`updatedAt` already did — one clock for every server-set timestamp. The test suite's own seeding had the identical flaw and was rewritten to build timestamps from `date_trunc('day', now())` rather than JS Dates, which is also why the failure only appeared at certain times of day. A regression test asserts `ABS(now() - escalated_at) < 60` after a real `recordEscalation()`; the old code scored 18000 there.

   **Not changed, and worth knowing:** the auth module's `expiresAt`/`revokedAt` are also JS-written, but they are only ever *compared in JS* against other JS Dates, so they are internally consistent and not broken today. They are fragile for the same underlying reason.

   **The deeper fix this phase did not take:** these columns should be `timestamptz`, which stores an absolute instant and converts on input, making it impossible for the writing clock to matter. That is a migration across every timestamp column in the schema and was judged out of scope here — logged as an open item rather than done quietly.

   **Two transferable lessons:**
   - **A defensive clamp can convert a loud bug into a silent one.** `GREATEST(x, 0)` looked like good hygiene and was actively concealing a five-hour error. When adding a clamp, ask what it would hide.
   - **Time-dependent bugs hide behind the clock.** This suite had passed many times; it only failed because a run happened to land between UTC midnight and local midnight. Tests that construct timestamps should build them on the same clock the system under test uses.

---

## The tests, and why each one exists

`test/hybrid-search.e2e.spec.ts` — 11 tests. Real Gemini embeddings throughout, because the entire phase is about where semantic and lexical search *disagree*, and a fake embedding provider would make that disagreement fictional. Only the generation call is substituted (the quota-limited one, and no assertion here is about what the model writes).

| Test | Why it exists |
|---|---|
| keyword search pins the exact token with perfect precision | The property keyword search genuinely contributes: exactly one chunk contains `E-4021`, it ranks first, and no other chunk is a keyword hit at all. |
| documents that the current model handles rare tokens unaided | **Encodes a surprising measurement as a regression test.** Asserts what is true today so the day a model swap or larger corpus changes it, that becomes visible instead of silently assumed. |
| still answers a pure paraphrase | The vocabulary-mismatch case that justified embeddings in the first place must not regress now that a second ranking exists. |
| refuses when nothing matches either way | Phase 10's refusal path still fires; hybrid search widened retrieval without weakening the guard. |
| never leaks another workspace via the keyword path | A new route into the data is a new way to leak. Re-proven, not inherited. |
| a chunk in both lists outranks one in a single list | Fusion's core property — RRF rewards agreement. |
| a URL with a colon is literal, not a weight filter | Locks in the silent-wrong-results bug found in the break-it step. |
| degrades to pure vector search on a stop-words-only question | The `NULL` tsquery path, which must be a clean no-op rather than an error. |
| caps the candidate pool | An unselective term matching everything still cannot flood the response. |
| generated column maintained on insert and update | The sync guarantee is structural; this proves Postgres, not application code, maintains it. |
| generated column rejects direct writes | The other half of that guarantee. |

`test/retrieval.e2e.spec.ts` was updated rather than replaced: the response shape changed from a bare array to `{ chunks }`, and ordering changed from cosine distance to fused RRF score, so its assertions now state which search produced the ranking rather than assuming distance order.

---

## Reverse-engineering guide — where to start if you reopen this in six months

1. **Read `retrieval.service.ts` first, top to bottom.** The whole phase is essentially one SQL statement, and the comments in it carry the reasoning for every non-obvious choice.
2. **Then read "What the measurements actually showed" in this doc.** It explains why the code is *smaller* than the plan — a lexical confidence path was designed, measured, and deleted before shipping. Without that section the absence looks like an oversight.
3. **If keyword search seems to be doing nothing:** check whether the question's distinctive term survived stemming, with `SELECT to_tsvector('english', '<the question>')`. Then check the built query. Most "keyword search is broken" moments are really "the term was a stop word" or "the lexemes did not match what is stored".
4. **If results seem narrower than they should be:** suspect the tsquery, not the data. That is the shape the colon bug took — a valid query that matches less than it should, with no error anywhere.
5. **Do not re-derive the ranking from scores.** `ts_rank` has no IDF and is not comparable across queries; the fusion deliberately consumes ranks only. If you are tempted to threshold on a `ts_rank` value, re-read diagnostic Q6.
6. **The one thing most likely to be wrong later:** `CANDIDATE_POOL = 20` and `RRF_K = 60` are conventional defaults, not measured for this corpus. Phase 17 (Evaluations) is the phase equipped to tune them against real outcomes.

---

## Interview questions this phase generates

1. Why can't you average a cosine distance and a BM25/`ts_rank` score to combine two rankings? What do you do instead?
2. Explain Reciprocal Rank Fusion. Why reciprocal, and what does the constant `k` control?
3. What is a `tsvector`, and how does it differ from the text it came from? What is stemming, and what does it buy you?
4. Why is a GIN index right for full-text search and a B-tree wrong? How does an HNSW index differ from both?
5. You add a second ranking signal to an existing search system. What downstream code is now silently wrong?
6. What is a stored generated column, and what class of bug does it eliminate?
7. Your keyword search ranks a chunk matching three common query words above the one chunk matching the single rare term the user actually cares about. Why, and what would fix it?
8. A query with no keyword matches and no close vector match — where should the "we don't know" decision live, and why not in the retrieval layer?

---

## What's still not understood / open items

- **Whether hybrid search earns its place in this system at all.** Its value could not be demonstrated end-to-end on this corpus with this embedding model. The implementation is correct and standard, but "standard practice" is not evidence. Phase 17 should settle it.
- **`CANDIDATE_POOL` and `RRF_K` are unmeasured.** Both are conventional defaults carried over from the literature.
- **No IDF anywhere.** `ts_rank` weights by term frequency only, which is the direct cause of the ranking failure documented above. Real BM25 needs a Postgres extension outside this project's stack.
- **The HNSW-planner risk from Phase 8 is untouched and now applies inside a CTE**, where the planner's choices are, if anything, harder to reason about. Not re-measured this phase.
- **Broad, diffuse queries** (the user's own "tell me about your company" case) remain unsolved and are explicitly out of scope — they need query expansion or summary-level chunks, not lexical matching.
- **Every timestamp column in this schema is `timestamp without time zone`.** The immediate bug is fixed by writing all of them from Postgres' clock, but the type itself is the real weakness: it stores a wall-clock reading with no record of which clock produced it. `timestamptz` stores an absolute instant and makes the writer's timezone irrelevant. Migrating is a schema-wide change and is deliberately still open.

---

# Closing quiz (Step 7)

**Result: 0 SOLID · 5 SHAKY · 8 UNKNOWN** (opening diagnostic was 0 / 3 / 9).

Modest but real movement, and it is concentrated in one place worth naming: **Q2 and Q3 — the actual mechanics of `tsvector` and of index selection — went from flat UNKNOWN to substantially correct.** Those were taught between the two quizzes and they stuck. What did not move is everything about *fusion* and everything about *the consequences of a ranking change*, which is consistent: those were taught in the same doc but never exercised by writing code.

---

### Q1. A question where keyword wins, and one where vector wins. Name both categories.

**Your answer:** *"in those cases where user query contains some keywords or paths that needs exact searching not semantic meaning searching"*

**Score: SHAKY** — the keyword-wins half is right and correctly generalised. The vector-wins half is missing entirely, and the question asked for both.

**Keyword wins** on rare, exact, high-information strings: `E-4021`, `SKU-88231`, `v2.14.3`, an invoice number, a file path. You named this correctly. These have no semantic content — there is no region of embedding space meaning "firmware error codes beginning with E-4".

**Vector wins** on **paraphrase**, and the category name is the **vocabulary mismatch problem**. Document: "Refunds are available within 30 days." Customer: "How do I get my money back?" Zero shared words. Measured in this project: keyword search scores that pair `1e-20` (nothing), while the embedding distance is `0.311` — comfortably relevant.

This is the whole reason embeddings were adopted for retrieval: humans describe the same concept with different words — "cancel my plan" / "end my subscription" / "stop being charged" — and character matching cannot connect them.

---

### Q2. What does `to_tsvector('english', …)` produce? Name two transformations.

**Your answer:** *"it produces the searchable vectors by doing stemming like 'refund:1' 'are:2' 'avail:3' something like this through which we can do keyword searching"*

**Score: SHAKY, and this is the best answer in the set** — genuinely up from UNKNOWN. You named **stemming** and you correctly showed **positions** (`refund:1`). Both right.

What is missing, and your own example contradicts it: **stop-word removal**. Real output:

```sql
SELECT to_tsvector('english', 'Refunds are available within 30 days of purchase, provided the item is unused.');
```
```
'30':5 'avail':3 'day':6 'item':11 'provid':9 'purchas':8 'refund':1 'unus':13 'within':4
```

`are`, `of`, `the`, `is` are **gone**. Your example kept `'are:2'` — that lexeme never exists in an `'english'` vector. Words appearing in nearly every sentence cannot discriminate between documents, so indexing them costs space and buys nothing.

Note also that positions survive the removal: `'refund':1 ... 'avail':3` — position 2 (`are`) is simply absent, which is how phrase search still works after stop words are dropped.

So the three transformations are: **tokenise → remove stop words → stem**, with positions retained throughout.

---

### Q3. Three indexes on one table — what does each answer, and why can't one serve all?

**Your answer:** *"in all three searching is different in first we want exact searching in second we want semantic searching based on distance and in third we want the keyword search"*

**Score: SHAKY** — the mapping is **entirely correct**, which is real progress from answering "btree" to the opening version of this question. The missing half is the *why*, which is the transferable part.

| Index | Question | Structure |
|---|---|---|
| btree (`document_id`) | "equals / greater than / in sorted order" | sorted tree of **whole values** |
| HNSW (`embedding`) | "nearest in 768-dim space" | navigable graph, walked greedily |
| GIN (`content_tsv`) | "contains this lexeme" | **inverted** index: term → list of rows |

**Why one cannot serve all three.** A btree stores **one value per row, in sorted order**. That is perfect for ordering and equality on whole values. But a `tsvector` is a *set*, and the question is "which rows contain this one element of the set" — a btree could only find rows whose entire lexeme set equals another entire lexeme set, which nobody ever asks. GIN inverts the mapping so one key lookup returns a posting list.

HNSW answers a question with **no exact answer at all** — "nearest" is a ranking, not a match. It trades a small chance of missing the true nearest neighbour for an enormous speedup, which is a trade the other two never make because their answers are exact.

**The one sentence to keep:** *an index is a data structure shaped like the question you intend to ask.*

---

### Q4. Why is averaging `0.21` (distance) and `0.89` (`ts_rank`) meaningless?

**Your answer:** *"because both represent different results min distance shows the relativeness while more scores shows high matching"*

**Score: SHAKY** — you have the core insight and stated it imprecisely. "min distance… while more scores…" is you noticing that **the two run in opposite directions**, which is the primary reason.

Said precisely:

| | Cosine distance | `ts_rank` |
|---|---|---|
| Direction | **lower is better** (0 = identical) | **higher is better** (0 = no match) |
| Range | 0 to 2, bounded | ~0 to ~1 typically, unbounded in principle |
| Meaning | an angle between vectors | a term-frequency weighting |

Averaging `0.21` and `0.89` gives `0.55`, a number with no meaning: you have added a quantity where small is good to one where large is good. Like averaging a temperature in Celsius with a distance in miles.

**The second reason, which you did not have and which matters more in practice:** `ts_rank` values **are not comparable across queries**. Measured here — the same one-word query against two chunks:

```
'refund refund refund' → 0.0827
'refund'               → 0.0608
```

The value depends on term frequency and query shape, so `0.08` might be excellent for one query and mediocre for another. **There is no fixed `ts_rank` number that means "good"** — which is exactly why this phase never thresholds on one.

---

### Q5. Describe Reciprocal Rank Fusion. What does it consume, and why not the scores?

**Your answer:** *"dont know"* — **UNKNOWN**

**It consumes ranks — positions — not scores.** That is the entire trick. "Best result this search found" means the same thing in both lists, whereas `0.21` and `0.89` do not.

```
score(chunk) = Σ over each list:  1 / (k + rank_in_that_list)          k = 60
```

Worked on the example from the opening diagnostic:

| Chunk | Vector rank | Keyword rank | RRF |
|---|---|---|---|
| A | 1 | 3 | 1/61 + 1/63 = **0.0323** |
| C | 3 | 1 | 1/63 + 1/61 = **0.0323** |
| B | 2 | — | 1/62 = **0.0161** |
| D | — | 2 | 1/62 = **0.0161** |

A and C tie — correct, each is 1st in one list and 3rd in the other.

**Why reciprocal:** `1/rank` makes the gap between 1st and 2nd much larger than between 9th and 10th, matching how relevance actually falls off.

**Why `+k`:** it damps that curve. With `k=60`, ranks 1 and 2 differ by ~2%, so **agreement across both lists outweighs winning one narrowly**. A small `k` (say 1) would let a single first place dominate.

**Why it is genuinely elegant:** no score normalisation, no per-corpus tuning, no need to know what the underlying scores even mean. Works for two lists or ten. It is the default in Elasticsearch and OpenSearch hybrid search for that reason.

In this codebase it is the `fused` CTE: `COALESCE(1.0/(60 + v.rank), 0) + COALESCE(1.0/(60 + kw.rank), 0)`.

---

### Q6. Which line in `AnswerService` had to change, and what would the wrong behaviour have been?

**Your answer:** *"dont know"* — **UNKNOWN**, and this is the most important question in the set, because it is about *your own code silently breaking*.

**Before:**
```ts
const minDistance = chunks.length > 0 ? chunks[0].distance : null;
```
That was correct **only because the list was ordered by distance** — so `chunks[0]` genuinely was the closest.

**After Phase 13** the list is ordered by **fused RRF score**. `chunks[0]` is now merely "highest fused rank", and the closest chunk can be anywhere in the list.

**After:**
```ts
const distances = chunks.map((c) => c.distance).filter((d) => Number.isFinite(d));
const minDistance = distances.length > 0 ? Math.min(...distances) : null;
```

**What the wrong behaviour would have been — and note it is not a crash.** The old line keeps compiling, keeps running, and hands Phase 10's threshold a distance that is *first by fused rank* rather than *closest*. Since that value is ≥ the true minimum, the system would **refuse questions it should have answered** — intermittently, with no error, no log, and no failing test.

**Generalise this:** when you change how something is ordered, go find every consumer that was reading meaning into the old order. Ranking changes do not announce themselves.

---

### Q7. What is `GENERATED ALWAYS ... STORED`, what maintains it, what bug does it prevent?

**Your answer:** *"dont know"* — **UNKNOWN**

```sql
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```

**What it is:** a column whose value is *derived by Postgres from other columns in the same row*, computed on write and physically stored (hence `STORED`) so it can be indexed.

**What maintains it:** Postgres, on every `INSERT` and every `UPDATE` of `content`. No application code is involved — and Postgres **rejects** any attempt to write it directly. Both halves are asserted by tests here.

**The bug class it makes impossible: index/content drift.** The alternative is an ordinary column the application fills in. That works until *one* code path updates `content` without updating `content_tsv` — a migration, a bulk fix, a `psql` session, a second service. Then the search index silently describes text that no longer exists. No error, just wrong results forever.

**Why not compute it at query time instead?** Two fatal problems: Postgres would have to compute `to_tsvector(content)` for **every row** before it could filter (a sequential scan by definition), and **you cannot index a value that does not exist until query time**. This is the same reasoning behind the `embedding` column — derived, immutable values belong to write time.

---

### Q8. Nothing matches semantically or lexically. What is returned, and which layer decides?

**Your answer:** *"refused"* — **SHAKY.** The outcome is exactly right. The question also asked *which layer decides and why*, which is the part that matters architecturally.

**`AnswerService` decides (Phase 10) — not the retrieval layer.** The split already exists in your code:

- **`RetrievalService`** answers *"what are the closest chunks?"* and returns up to `k` rows **regardless of quality**. It has no opinion about whether they are good enough.
- **`AnswerService`** answers *"is the best of these good enough to ground an answer?"* and refuses if not, short-circuiting **before** any Gemini call.

**Why that layer.** Retrieval's job is ranking; "good enough" is a *product* decision with a threshold that was measured, and it may change with the model, the corpus, or the customer's risk appetite. Putting it in retrieval would mean the search layer silently withholding results the caller never learns existed — and would make `/retrieve` (a debugging endpoint) lie about what the index contains.

Concretely: 5 mediocre chunks come back, `minDistance` lands ~0.55, the threshold fires, and the response is `status: 'refused'` with the fallback phrase — **no Gemini call spent**, which is both the cheap and the safe outcome.

---

### Q9. What was wrong with `plainto_tsquery`, and what replaced it?

**Your answer:** *"dont know"* — **UNKNOWN**

**`plainto_tsquery` ANDs every term.** Measured:

```sql
SELECT plainto_tsquery('english','How do I fix error E-4021 on my device?');
-- 'fix' & 'error' & 'e' & '-4021' & 'devic'
```

Every one of those must be present. The chunk that actually contains `E-4021` **did not match**, purely because it lacks the word "fix". For conversational questions — which is all a support bot ever receives — that makes the keyword path contribute almost nothing.

**Replaced with an OR query built from the question's own stemmed lexemes:**

```sql
to_tsquery('english',
  (SELECT string_agg('''' || replace(lexeme,'''','''''') || '''', ' | ')
   FROM unnest(to_tsvector('english', $1))))
```

`unnest(tsvector)` yields `(lexeme, positions, weights)` rows — verified: `refund|{1,3}` for "refund the refund policy". Joining the lexemes with `|` gives OR. Now any distinctive shared term surfaces the chunk, and ranking sorts out which is best, which is what ranking is for.

**Free degradation:** a question of only stop words yields an empty vector → `string_agg` returns `NULL` → `to_tsquery(NULL)` is `NULL` → `tsv @@ NULL` is never true. The keyword side contributes nothing and retrieval falls back to pure vector search, with no error.

---

### Q10. A URL with a colon — what did Postgres do, and why worse than a crash?

**Your answer:** *"so it will search it based on meaning which is incorrect"* — **UNKNOWN.** This is about tsquery *syntax*, not semantics; embeddings are not involved at all.

**What happened.** `to_tsvector` on a URL keeps a lexeme containing the colon:

```sql
SELECT to_tsvector('english','see https://example.com/a:b page');
-- '/a:b' ... 'example.com/a:b' ... 'page' 'see'
```

Pasted unquoted into a tsquery, **`:` is tsquery's weight-filter operator**, so `/a:b` parses as "lexeme `/a` restricted to weight **B**":

```
'/a':B | 'example.com' | 'example.com/a':B <-> ... | 'page' | 'see'
```

**Why that matches nothing.** Every lexeme in `content_tsv` has the default weight **D**, because plain `to_tsvector` assigns D and nothing calls `setweight`. Verified directly:

```sql
SELECT to_tsvector('english','refund') @@ to_tsquery('english','refund:A');   -- false
SELECT setweight(to_tsvector('english','refund'),'A') @@ to_tsquery('english','refund:A'); -- true
```

So the term became permanently unmatchable.

**Why worse than a crash.** A crash is a 500 you find in minutes. This **succeeded**: HTTP 200, results returned, just *fewer* than there should have been. No error, no log, no failing test. A user would experience it as "search is a bit rubbish" — the kind of defect that survives for months.

**The fix** is to single-quote each lexeme so it is literal (with `''` escaping any embedded quote). Locked in by a test.

**The lesson worth carrying past Postgres:** *the dangerous class of bug is the one that degrades a result instead of raising an error.* When building a query, command, or path out of string fragments, ask what happens if a fragment contains that language's own operators — and prefer the API that treats input as data (bound parameters, quoting) over the one that treats it as syntax.

---

### Q11. `escalatedAt` written with `new Date()` — what went wrong, and what did `GREATEST(...,0)` do?

**Your answer:** *"dont know"* — **UNKNOWN**

**Measured on this machine:**
```
via_js = 2026-09-27 04:21:28      (JS new Date())
via_pg = 2026-09-26 23:21:28      (Postgres now())
skew   = 18000 seconds  ← exactly 5 hours
wait computed from the JS value = -18000 seconds
```

**Mechanism.** Every timestamp column here is `timestamp without time zone` — it stores a wall-clock reading with **no record of which clock produced it**. node-postgres serialises a JS `Date` into the **host's local** wall clock (UTC+5 here); Postgres' `now()` writes UTC. Two clocks, one column type, no complaint from anyone.

**What broke.** Wait times are computed in SQL as `now() - escalated_at`. JS-written value → **minus five hours**.

**And here is the part worth remembering.** `listQueue` wrapped that in `GREATEST(..., 0)` — which I had added so a negative duration could never reach the UI. It worked exactly as intended, and in doing so **flattened −18000 to 0**. Every real escalation displayed **"0m 00s" forever** and could never reach High priority. The defensive clamp converted a screamingly obvious bug into a silent one.

`Document.readyAt` had the same cause with cosmetic effect: "Last indexed" showed a time five hours in the future — visible in real data all along (`createdAt 01:31Z` vs `readyAt 06:31Z` on one document) and never read as a defect.

**Fix:** both now write Postgres `now()`, matching what `createdAt`/`updatedAt` always did. Test seeding had the identical flaw (which is why the suite only failed on runs between UTC midnight and local midnight) and now builds from `date_trunc('day', now())`. Regression test asserts `ABS(now() - escalated_at) < 60`; the old code scored 18000.

**Two transferable lessons:**
1. **A defensive clamp can hide a real bug.** Before adding `GREATEST`, `?? fallback`, or `catch {}`, ask what it would conceal.
2. **Prefer one clock.** Better still, use `timestamptz`, which stores an absolute instant so the writing clock cannot matter. Logged as an open item here.

---

### Q12. Why was the lexical-confidence path deleted before shipping?

**Your answer:** *"dont know"* — **UNKNOWN**

**The plan** was: since embeddings supposedly smear rare exact tokens, a keyword-only hit would have a bad cosine distance, so it needs its own way to clear Phase 10's 0.45 threshold. A `SELECTIVE_KEYWORD_MATCH_LIMIT` constant was designed for it.

**The premise was measured before the code was trusted:**

| scenario | target | decoy | outcome |
|---|---|---|---|
| bare code (`E-4021`) | **0.250** | 0.479 | vector wins |
| code in a long chunk | **0.319** | 0.440 | vector wins |
| SKU in a long chunk | **0.263** | 0.416 | vector wins |
| version number | **0.291** | 0.403 | vector wins |
| code buried, on-topic decoy | 0.430 | **0.400** | vector loses ranking |
| SKU buried, on-topic decoy | **0.359** | 0.417 | vector wins |

Gemini's model handles rare exact tokens well. Every target landed **inside** the 0.45 threshold — including the one case where vector *ranking* lost. So the gate would have been a guessed constant protecting against a failure that **could not be reproduced**.

**The principle:** do not build for scenarios you cannot demonstrate. Phase 10 made the identical call when it refused to invent a confidence middle-zone without data. Deleting it also removed an extra database round trip from a synchronous, customer-facing path.

**The related finding, worth as much as the deletion:** a test claimed to prove this gate was needed, and it passed. Adding an assertion of its own *premise* (`expect(minDistance).toBeGreaterThanOrEqual(0.45)`) failed instantly — the real distance was `0.250`. **The test had been exercising the semantic path the whole time while claiming to prove the lexical one.** A test that does not assert its premise can pass for reasons unrelated to its claim.

---

### Q13. What property is `ts_rank` missing, and what would fix it?

**Your answer:** *"dont knwo"* — **UNKNOWN**

**It is missing IDF — inverse document frequency.** `ts_rank` scores by weighted **term frequency** within the document. It has no idea that `-4021` is rare and `error` is common, so it cannot reward the distinctive term.

**What that caused here.** Query: *"what should I do about error E-4021 on my device?"*

```
decoy   v=1 k=1 rrf=0.03279 d=0.338   "If your device shows an error code, restart it..."
buried  v=2 k=2 rrf=0.03226 d=0.438   "Appendix C: warranty postage... Note: E-4021..."
```

The decoy won **both** rankings. Under OR semantics the query contributes several common lexemes (`error`, `devic`) which the decoy contains repeatedly, versus the single rare `-4021` in the target. Fusion cannot rescue what both inputs rank second.

**Confirmed by measurement** — `ts_rank` rewards repetition, and by default does **not** penalise length:

```
'refund refund refund'            → 0.0827
'refund'                          → 0.0608
'refund' + 50 filler words        → 0.0608   ← no length penalty at all
same, with normalisation flag 2   → 0.0012
```

**What would fix it:**
1. **BM25**, which has IDF built in. Not in core Postgres — needs an extension such as ParadeDB's `pg_search`. Outside this project's stack.
2. **`ts_rank`'s normalisation flags** — passing `2` divides by document length, which would at least have penalised the long buried chunk. A real lever this phase did not pull; noted as an open item.
3. **Weighting via `setweight`** — put titles/headings at weight A and body at D, so a match in a heading outranks one in a paragraph. Requires structure this project's chunks do not carry.

**This is the honest reason hybrid search could not be shown to win here**, and it is written into the code and the open items rather than glossed over.

---

# Postgres full-text search: the complete reference

Everything below was run against this project's own database. This section exists because the closing quiz showed the mechanics are the weak area, and because the request was for interview-readiness, not just enough to maintain this phase.

## 1. The two types

Full-text search in Postgres is two data types and one operator.

| | Purpose |
|---|---|
| `tsvector` | the **document**, preprocessed: a sorted set of lexemes with positions |
| `tsquery`  | the **question**: lexemes combined with boolean/proximity operators |
| `@@`       | "does this document match this query" → boolean |

```sql
SELECT to_tsvector('english','Refunds are available') @@ to_tsquery('english','refund');  -- true
```

Note it returns **true** — `Refunds` matched `refund` because both stem to `refund`. Matching happens between *normalised* forms, never raw strings.

## 2. What `to_tsvector` really does

Three stages: **tokenise → drop stop words → stem**, keeping positions.

```
input : 'Refunds are available within 30 days of purchase, provided the item is unused.'
output: '30':5 'avail':3 'day':6 'item':11 'provid':9 'purchas':8 'refund':1 'unus':13 'within':4
```

- **Lexemes are not words.** `avail`, `purchas`, `unus`, `provid` are not English. A stemmer produces a *normalisation key*, so all inflections collapse together.
- **Positions are kept** (`'refund':1`). Gaps exist where stop words were removed. Positions power phrase search and proximity ranking.
- **Sorted and deduplicated.** `'refund the refund policy'` → `refund|{1,3}` — one entry, two positions.

Inspect a vector with `unnest`, which returns `(lexeme, positions, weights)`:

```sql
SELECT lexeme, positions FROM unnest(to_tsvector('english','refund the refund policy'));
--  polici | {4}
--  refund | {1,3}
```

This project uses exactly that to build its OR query.

## 3. Configurations: `'english'` vs `'simple'`

The first argument selects the **text search configuration** — the stop-word list and the stemmer.

```
'english': '30':5 'avail':3 'day':6 ... 'refund':1 'within':4
'simple' : '30':5 'are':2 'available':3 'days':6 'is':12 ... 'refunds':1 'the':10 'within':4
```

`'simple'` only lowercases and splits — nothing stemmed, nothing removed. A customer searching "refund" would then **not** match a document saying "Refunds".

**The production trap:** the configuration must be identical at write time and query time. Index with `'english'`, query with `'simple'`, and you compare `refund` against `refunds` — **zero results, no error**. This is why this project writes `'english'` explicitly in both places rather than relying on the server's `default_text_search_config`, which is a runtime setting someone can change.

Use `'simple'` deliberately when exact forms matter: usernames, tags, product codes.

## 4. Building a `tsquery` — four functions, different semantics

| Function | Semantics | Use when |
|---|---|---|
| `to_tsquery` | you write the operators yourself | full control (what this project uses) |
| `plainto_tsquery` | **ANDs** all terms | you require every term |
| `phraseto_tsquery` | terms adjacent, in order | exact phrase |
| `websearch_to_tsquery` | Google-ish: quotes, `or`, `-` | user-typed search boxes |

```sql
plainto_tsquery('english','How do I fix error E-4021 on my device?')
-- 'fix' & 'error' & 'e' & '-4021' & 'devic'      ← ANDed; too strict for questions
```

**Operators inside a `tsquery`:**

| Op | Meaning | Verified |
|---|---|---|
| `&` | AND | |
| `\|` | OR | |
| `!` | NOT | `'refund policy' @@ 'refund & !shipping'` → true |
| `<->` | immediately followed by | `'the quick brown fox' @@ phraseto_tsquery('quick brown')` → true |
| `<N>` | N positions apart | |
| `:*` | prefix match | `'refunding' @@ 'refund:*'` → true |
| `:A`/`:B`/`:C`/`:D` | **weight filter** | see below — this caused a real bug here |

## 5. Weights — the mechanism behind this phase's silent bug

Every lexeme carries a weight `A`, `B`, `C` or `D`. Plain `to_tsvector` assigns **D** to everything; `setweight` changes it.

```sql
setweight(to_tsvector('english','refund policy'),'A')  -- 'polici':2A 'refund':1A
to_tsvector('english','refund policy')                 -- 'polici':2  'refund':1     (D, shown blank)
```

A `:X` in a query **filters** by weight:

```sql
SELECT to_tsvector('english','refund') @@ to_tsquery('english','refund:A');                 -- false
SELECT setweight(to_tsvector('english','refund'),'A') @@ to_tsquery('english','refund:A');  -- true
```

The intended use is relevance structure: title at `A`, body at `D`, then `ts_rank` with custom weights ranks a title match above a body match.

**The trap this project hit:** because `:` is an operator, any lexeme *containing* a colon (URLs, `host:port`, `key:value`) is reinterpreted as a weight filter when concatenated unquoted into a query string. Since nothing here has weight A/B/C, those terms match nothing — silently. Quote the lexeme to make it literal.

## 6. Ranking: `ts_rank` and `ts_rank_cd`

`@@` is boolean. Ordering needs a rank.

- **`ts_rank`** — weighted term frequency.
- **`ts_rank_cd`** — "cover density": also rewards query terms appearing *close together*. Needs positions.

Both take an optional **normalisation** bitmask, and the default (`0`) applies **none**:

```
'refund refund refund'         → 0.0827     ← frequency rewarded
'refund'                       → 0.0608
'refund' + 50 filler words     → 0.0608     ← length NOT penalised by default
same, normalisation flag 2     → 0.0012     ← now divided by length
```

| Flag | Effect |
|---|---|
| 0 | none (default) |
| 1 | divide by `1 + log(document length)` |
| 2 | divide by document length |
| 4 | mean harmonic distance between terms (`ts_rank_cd` only) |
| 8 | divide by number of unique words |
| 16 | divide by `1 + log(unique words)` |
| 32 | `rank / (rank + 1)`, squashing into 0–1 |

**Two things to say in an interview:**
1. **`ts_rank` has no IDF.** It cannot know a term is rare. BM25 (the standard IR ranking) does, and needs an extension.
2. **`ts_rank` values are not comparable across queries.** There is no fixed "good" score, which is why thresholding on one is a mistake and why rank fusion consumes *ranks*.

## 7. Indexing: GIN vs GiST

| | GIN | GiST |
|---|---|---|
| Structure | inverted index (term → rows) | lossy signature tree |
| Lookups | faster | slower (rechecks candidates) |
| Build/update | slower, larger | faster, smaller |
| Best for | mostly-read data | write-heavy, or smaller sets |

For a document search corpus — written once, read constantly — **GIN** is the default choice, which is what this project uses.

```sql
CREATE INDEX idx ON document_chunks USING GIN (content_tsv);
```

`CREATE INDEX CONCURRENTLY` avoids locking writes but **cannot run inside a transaction** — and TypeORM wraps migrations in one. For a large table that is a real operational constraint; noted in this project's migration.

## 8. Where to keep the `tsvector`

Three options, in increasing order of correctness:

1. **Compute at query time** — `WHERE to_tsvector('english', content) @@ …`. Correct but unindexable; a sequential scan forever.
2. **An ordinary column the app maintains** — indexable, but drifts the first time any code path updates the text without updating the vector.
3. **A stored generated column** — Postgres maintains it, cannot drift, and rejects direct writes.

```sql
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```

Option 3 is what this project uses. Before generated columns existed (pre-PG12), the standard approach was a trigger, which is the same idea with more moving parts.

## 9. What full-text search is *not* good at

Worth knowing so you can say it out loud in an interview:

- **Synonyms and paraphrase** — "money back" will never match "refund" without a configured thesaurus dictionary. This is what embeddings solve.
- **Typos** — `refnud` matches nothing. Trigram similarity (`pg_trgm`) handles fuzzy matching; FTS does not.
- **Ranking quality** — no IDF, no length normalisation by default. Real search engines use BM25.
- **Cross-language** — one configuration per column; mixed-language corpora need per-row configuration or separate columns.

---

# Every code change in this phase

### 1. Migration — `1790318737503-AddContentTsvToDocumentChunks.ts` (new)

```sql
ALTER TABLE "document_chunks" ADD COLUMN "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;
CREATE INDEX "IDX_document_chunks_content_tsv" ON "document_chunks" USING GIN ("content_tsv");
```
Hand-written — the sixth migration in a row written by hand because `migration:generate` still tries to drop the Phase 8 HNSW index; it also cannot express a generated column or a GIN index from decorators. Index verified intact afterwards.

### 2. `document-chunk.entity.ts`
Added `contentTsv` with `insert: false, update: false, select: false` — declared so the column is visible to anyone reading the entity, but TypeORM must never attempt to write it (Postgres would reject it).

### 3. `retrieved-chunk.interface.ts`
`RetrievedChunk` gained `vectorRank`, `keywordRank` (both nullable — a chunk can appear in one list only) and `rrfScore`. New `RetrievalResult` wrapper so per-query information has somewhere to live that is not a per-chunk field.

### 4. `retrieval.service.ts` — the heart of the phase
One statement, five CTEs: `q` (the quoted OR tsquery), `candidates` (workspace filter applied **once**, before either search), `vector_hits` and `keyword_hits` (each `ROW_NUMBER()`, `LIMIT 20`), `fused` (`FULL OUTER JOIN` + RRF). The final `SELECT` orders by fused score and **computes the real cosine distance for every surviving row**, including chunks only keyword search found — which is what keeps the confidence check meaningful.

Constants: `CANDIDATE_POOL = 20`, `RRF_K = 60`, `DEFAULT_K = 5`.

### 5. `answer.service.ts`
- `minDistance` changed from `chunks[0].distance` to `Math.min(...)` — Q6 above.
- `searchMode` in `getConfig` changed `'Vector'` → `'Hybrid'`.
- `retrievedChunks` now carries `vectorRank`/`keywordRank` through to the API.
- The designed-then-deleted lexical-confidence gate; the deletion is documented in a comment so the absence reads as a decision rather than an oversight.

### 6. `handoff.service.ts` + `document-embedding.processor.ts`
`escalatedAt` and `readyAt` switched from JS `new Date()` to Postgres `now()` — the timezone bug (Q11).

### 7. Frontend
`api.ts` types updated (`searchMode: 'Hybrid'`, per-chunk ranks); `RetrievalInspector.tsx` now shows `vector #n / keyword #n / d 0.311` per chunk — the prototype had mocked these as "vector 0.91 / keyword 0.88" and they are real ranks now.

### 8. Tests
`test/hybrid-search.e2e.spec.ts` (11 tests, new), `test/retrieval.e2e.spec.ts` (updated for the new shape/ordering), `test/handoff-queue.e2e.spec.ts` (timezone-safe seeding + a clock-consistency regression test). **Full suite: 23 suites, 139 tests, green.**

---

# Topics to master (Step 8)

Ranked by transferable leverage, from both quizzes.

### 1. Inverted indexes, and choosing an index type from the query shape
**Search:** "inverted index vs b-tree", "postgres GIN vs GiST full text", "how does an inverted index work"
**Exposed by:** opening Q5 (answered "btree"), closing Q3 (mapping correct, mechanism missing)

Every storage engine you will ever touch makes the same bargain: an index is a precomputed structure shaped like one question, paid for in write cost and space. Being able to say *why* a B-tree cannot answer "contains this term" — because it sorts whole values, not set members — generalises to Elasticsearch, Lucene, Mongo, and to spotting the missing-index problem in any slow query. This is the single most portable idea in the phase.

### 2. Score normalisation and rank fusion across heterogeneous rankers
**Search:** "reciprocal rank fusion", "combining BM25 and vector search", "score normalization information retrieval"
**Exposed by:** opening Q6/Q7/Q8, closing Q4 (partial), Q5 (unknown)

The moment a system has two ways to rank the same items — relevance and recency, price and rating, two ML models — you face incomparable scores. RRF is the standard answer and takes two lines. The deeper skill is recognising the *category*: whenever you are about to combine two numbers, ask whether they share a direction, a scale, and a meaning. Directly reusable in recommendations, feed ranking, and A/B-tested search.

### 3. Downstream consumers of an implicit ordering
**Search:** "implicit contract refactoring", "changing sort order breaking callers", "leaky abstraction ordering guarantee"
**Exposed by:** opening Q9, closing Q6 — UNKNOWN both times, and the one that actually broke code here

`chunks[0]` meant "closest" only because of an ordering nobody wrote down. Changing the order left every line compiling and one of them quietly wrong. This is the general hazard of an **implicit contract**: a guarantee callers depend on that is not in any type or test. Whenever you change ordering, pagination, defaults, or units, the job is to *find the readers*, not just fix the writer. UNKNOWN across both quizzes makes this the top study item.

### 4. Bugs that degrade results instead of raising errors
**Search:** "silent failure vs fail fast", "defensive programming hides bugs", "fail loudly design principle"
**Exposed by:** closing Q10 (colon/weight filter) and Q11 (`GREATEST` clamp)

Two independent bugs this phase, same shape: a query that returned fewer rows than it should, and a duration clamped from −5 hours to 0. Neither raised anything. A crash costs minutes; a silent wrong answer costs months and is usually found by a customer. The practical habit: when adding `catch {}`, `?? default`, `GREATEST`, or `LIMIT`, state explicitly what it would hide — and prefer surfacing the anomaly to smoothing it.

### 5. Time zones, and `timestamp` vs `timestamptz`
**Search:** "timestamp vs timestamptz postgres", "node-postgres timezone conversion", "storing UTC best practice"
**Exposed by:** closing Q11

An 18000-second bug from two clocks writing one column. The rule — *store absolute instants, convert only at the edges* — is one of a small number of data-modelling decisions that are painful to reverse later, alongside primary key type and money representation. Every backend engineer meets this; most meet it in production.

### 6. Text analysis: tokenisation, stemming, stop words
**Search:** "postgres tsvector stemming", "what is a lexeme full text search", "stop words removal search"
**Exposed by:** opening Q3/Q4, closing Q2 — **genuinely improved**, now the strongest area

You have stemming and positions. Finish it by internalising stop-word removal and the write-time/query-time configuration symmetry. Underpins every search system; the same vocabulary (analyzer, tokenizer, filter) appears in Elasticsearch with different names.

### 7. Verifying a premise before building on it
**Search:** "testing the premise of a test", "false positive test", "assert preconditions in tests"
**Exposed by:** closing Q12

A test proved the feature was needed, and was passing for an unrelated reason. A designed feature was deleted after measuring that its failure mode did not reproduce. The habit — *measure the premise before writing the code that depends on it* — is what separates engineering from cargo-culting best practices, and it is worth being able to tell this story in an interview.

---

## What's still not understood, after both quizzes

- **Fusion remains entirely UNKNOWN** (Q5, and the single-list question from the opening diagnostic). It was taught in the doc but never written by hand — likely why it did not stick. Writing the RRF arithmetic out on paper for three chunks would probably fix it faster than re-reading.
- **The ranking-change/downstream-consumer idea is UNKNOWN across both quizzes** — the top item above.
- **The two silent-failure bugs** (Q10, Q11) were found by me, not by you, so there has been no chance to build the instinct yet. Watch for the pattern in Phase 14's caching work, where a stale cache hit is exactly the same shape of bug.
