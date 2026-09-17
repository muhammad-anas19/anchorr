# Phase 5 — Document Parsing & Extraction Pipeline

## Objective

Replace Phase 4's trivial placeholder job with real text extraction: read the actual PDF/DOCX bytes already sitting in storage, pull out the text a customer's documentation actually contains, and correctly distinguish "this worked" from "this is a scan with no extractable text" — matching the prototype's own failure copy. Introduces text-extraction fundamentals, BullMQ progress reporting, and honest failure-state design for a process that doesn't have a clean binary success/failure boundary.

## Why the system needs this

Everything Anchor exists to do — answer a customer's question using *only* a business's own documentation — depends entirely on that documentation existing as usable text somewhere. Right now (end of Phase 4), Anchor can accept a PDF, store it, and flip a status flag, but has never actually looked inside the file. This phase is where "we have a file" becomes "we have content" — the first point where anything resembling the actual product (as opposed to infrastructure around it) starts to exist.

---

## The diagnostic

10 questions asked up front, answered in one batch. **All 10 came back UNKNOWN** — an honest score, matching what you said going in ("this is my weakest phase"). Given that, this section is written as a full first-principles teaching pass for every question, not just a correction — including adjacent context ("other possible knowledge") beyond the literal question, as requested.

### Q1 — What "extracting text from a PDF" actually involves

**Asked:** A PDF isn't fundamentally a text file — why can a perfectly valid, non-corrupted PDF still yield zero extractable text?
**Answer:** "so we use pdf parser that will parse or extract data from pdf for us"

**The real answer, from first principles.** A PDF is not a text format — it's a **page-description format**, a distant cousin of PostScript, designed to describe exactly how a page should be *drawn*, not what it *says*. Inside a PDF, each page has a "content stream" — a sequence of low-level drawing instructions. A typical instruction looks conceptually like: *"select font F1 at size 12, move the cursor to position (72, 700), draw glyph codes [72, 101, 108, 108, 111] using that font."* Those glyph codes aren't guaranteed to be ASCII/Unicode values — they're indices into whatever font is embedded in that specific PDF, and the font itself carries a mapping table saying "glyph code 72 renders as the shape for the letter H" (or, in a maliciously or sloppily generated PDF, glyph code 72 could just as legally be mapped to render as "€" — the format doesn't prevent that).

So "extracting text" from a PDF actually means:
1. Parse the binary content stream and find every text-showing instruction.
2. For each one, look up the font's glyph-to-Unicode mapping and translate glyph codes back into actual characters.
3. Reconstruct **reading order** from the X/Y coordinates each piece of text was drawn at — because a PDF has no structural concept of "paragraph" or "this text comes before that text." A library has to *infer* order from position on the page, which is why extracted text from multi-column layouts, tables, or PDFs with headers/footers interleaved with body text often comes out visually scrambled even when every character was extracted correctly.

**Why a completely valid PDF can still yield zero text — the scanned-document case.** A scanned document (someone photographed or scanned a paper page and saved it as a PDF) contains **no text-showing instructions at all**. Each "page" is just one embedded image (a JPEG or PNG) positioned to fill the page. Visually, a human looking at it sees text clearly — but there is no data anywhere in the file saying "these are characters." There is nothing for a text-extraction library to find, because nothing resembling text, in the format's own terms, was ever written into the file. This is exactly the prototype's "the file appears to be a scan with no extractable text" case, and it's not an error or a corrupted file — it's a structurally valid PDF that simply never contained extractable text to begin with.

**Adjacent knowledge worth having:** the technique that *can* pull text out of a scanned image is **OCR (Optical Character Recognition)** — analyzing the actual pixels of an image and using pattern recognition (historically rule-based, now typically ML-based, e.g. Tesseract or cloud OCR APIs) to guess what characters are visually present. OCR is a fundamentally different technology from PDF text extraction — it works on pixels, not on structured drawing instructions — and it's explicitly **out of scope for this phase**. Anchor correctly treats a scanned PDF as `failed`, not as "needs OCR" — that would be a deliberate, separate future capability, not a bug to silently work around here.

### Q2 — Why DOCX needs a completely different code path than PDF

**Asked:** DOCX files are ZIP archives containing XML — why does that require a fundamentally different extraction approach than PDF?
**Answer:** "dont know"

**The real answer.** Rename any `.docx` file to `.zip` and unzip it — you'll find a real directory tree: `word/document.xml`, `word/styles.xml`, `[Content_Types].xml`, and more. This is the **OOXML** format (Office Open XML), and it's a completely different kind of document from a PDF in every way that matters for extraction:

- A PDF is a **binary, page-description** format built around drawing instructions and glyph positions.
- A DOCX is a **ZIP container full of structured XML**, where the actual text lives inside XML elements like `<w:p>` (a paragraph), `<w:r>` (a "run" of text with consistent formatting), and `<w:t>` (the literal text content itself).

Extracting text from a DOCX means: unzip the archive, parse `word/document.xml` as XML, and walk the resulting document tree collecting the text inside `<w:t>` nodes, respecting paragraph boundaries. There is no "glyph code → Unicode" translation step at all — the text is already stored as literal Unicode strings in the XML, exactly as a human typed them. There's also no reading-order ambiguity the way there is in a PDF — XML documents have an inherent linear structure.

Because the underlying formats are unrelated (one is a binary drawing language, the other is a ZIP-of-XML document format), a single generic "read the text out of this file" function isn't really possible — you need two genuinely separate extraction code paths, each using a library built for that specific format, dispatched based on the file's real MIME type (already known from Phase 3's magic-byte sniffing — no need to re-detect it here).

### Q3 — Detecting the "scan with no extractable text" case in code

**Asked:** How would your code actually detect this condition after running a PDF through an extraction library?
**Answer:** "i can match the extrated text content hash wwwith the content hash we found on validation (just a thought)"

That's reasoning about something else — Phase 3's `content_hash` exists to detect *duplicate uploads* (comparing one file's bytes to another file's bytes), which has no relationship to judging whether *this one file's* extraction produced usable text.

**The actual answer:** after running the file through the extraction library, you have a plain string result. Check it: trim whitespace, and see if what's left is effectively empty — not necessarily `=== ''` exactly (some extraction libraries leave behind stray whitespace, page-break markers, or a handful of junk characters even from a truly textless PDF), but below some reasonable length threshold. If the trimmed result has, say, fewer than a few dozen characters for a multi-page document, that's a strong, simple signal that nothing meaningful was actually extracted — route it to `failed` with the exact reason the prototype shows. A more refined version of this check (not required for this phase, but worth knowing exists) could compare extracted-character-count against the *page count* the library also reports — a PDF with 40 pages and only 15 total extracted characters is suspicious even if technically "non-empty."

### Q4 — What `job.updateProgress()` actually does

**Asked:** Where does that progress information go, who can see it, and does it survive a Redis restart?
**Answer:** "it will be store in our database (dont know)"

**The real answer:** BullMQ jobs live entirely in **Redis**, not Postgres — every job's data, including its current progress, is stored as part of a Redis hash structure BullMQ maintains for that specific job (keyed roughly like `bull:<queueName>:<jobId>`). Calling `job.updateProgress(...)` writes into that Redis structure and **emits a `progress` event** that anything actively subscribed to that queue's events (BullMQ's `QueueEvents` class) can observe in real time — this is the mechanism a live progress bar in a UI would eventually hook into (relevant much later, around Phase 12's real-time work).

It does **not** automatically go into our own Postgres database — that's a completely separate concern. If we wanted progress durably queryable through our own API (independent of BullMQ's internal state), we'd have to explicitly write it into a `Document` column ourselves, as a deliberate design choice, not something BullMQ gives for free.

**Does it survive a Redis restart? No, not by default.** Redis is an in-memory store; unless it's configured with persistence (RDB snapshots or an append-only file), a restart loses everything, including in-flight job progress. Even *with* persistence, once a job completes, BullMQ can be configured to auto-remove its data (`removeOnComplete`) — meaning even successfully-finished jobs' progress history disappears. The honest way to think about `job.updateProgress()`: it's a **live, ephemeral signal**, not an audit trail. If you need a durable record of "how far did this document get," that has to be a decision to persist it somewhere durable yourself.

### Q5 — Partial extraction failure (150 of 200 pages succeed, then it throws)

**Asked:** What should happen to the 150 pages' worth of already-extracted text?
**Answer:** "dont know"

There isn't one universally correct answer here — this is a genuine engineering judgment call, and it's worth understanding the real options rather than memorizing a single "right" answer:

- **Discard everything, fail the whole document.** Simplest and safest: no risk of the AI later answering customer questions from a document it silently only has 75% of. Costs the wasted work of the 150 successfully-parsed pages.
- **Keep the partial text, mark it `ready` anyway.** Tempting (nothing's wasted), but genuinely dangerous for *this specific product*: Anchor's entire value proposition is trustworthy, grounded answers. A document that's silently missing its last quarter, with no signal to anyone that anything is missing, could make the AI confidently answer (or worse, confidently *fail to answer* a question whose answer was on page 180) without anyone knowing why.
- **Keep the partial text, but mark it distinctly** (something like a `partial` state) so a human can decide whether to accept it, re-upload, or investigate. The most honest option, but requires schema growth (a new status) for a scenario that may be rare.

For Anchor specifically, given how central "don't silently degrade trust" is to the whole product, the reasonable default leans toward **discard and fail cleanly** — better to tell a business clearly "this document failed, please check it" than to have their AI quietly operate on an incomplete knowledge base. This is exactly the kind of call to make explicitly in the Design step below, not something to leave implicit.

### Q6 — What breaks if the idempotency guard were removed here

**Asked:** Now that this job has a real side effect (writing extracted text), what's the actual failure mode of a redelivered job running extraction twice?
**Answer:** "we will have more than one extracted content all over"

That's on the right track but worth making concrete. Unlike Phase 4's trivial job (where re-running "set status to ready" twice is harmless — the second run just sets the same value again), this job's side effect has real cost and, depending on *where* the extracted text is stored, real risk of duplication:

- **Wasted compute/time**, always — re-parsing a large PDF is genuinely expensive work, and once Phase 7 adds paid embedding API calls downstream, redundant reprocessing starts costing real money too.
- **If extracted text were written to a *new* file via `StorageAdapter` on every run** (rather than overwriting one fixed location), a redelivered job would leave an **orphaned duplicate file** behind every time — a real resource leak with no automatic cleanup, silently accumulating.
- **If extracted text is written to a fixed column/row (an `UPDATE`, not an `INSERT` of a new row),** re-running with the same input is actually naturally idempotent for the *final state* — the second write just overwrites with the same result. This is worth noticing: not every "idempotency risk" is equally severe; the storage *shape* you choose changes how bad a double-run actually is, independent of whether you also keep the explicit guard (which you should, regardless — relying on "well it happens to be harmless" is fragile).

### Q7 — Where extracted text should actually live

**Asked:** A new column on `Document`, a separate table, or a file via `StorageAdapter`? What's the tradeoff?
**Answer:** "we will divide it in chucks and make embedding and store in pgvector db"

That's correctly anticipating Phase 6/7's future work (chunking, then embeddings, then pgvector) — but it skips over *this* phase's actual question: where does the **raw, unchunked extracted text** live, right now, as the direct output of parsing, before any of that happens?

Three real options, with real tradeoffs:
1. **A new `extracted_text` column directly on `Document`.** Simplest to build. Postgres has no meaningful size problem storing this (large `TEXT` values get automatically moved out-of-line via Postgres's TOAST mechanism, so it doesn't bloat every row scan). The real cost: it couples "give me this document's lightweight metadata" (the common case — listing documents, checking status) with "this document's full content," even when callers only need the former.
2. **A separate table** (e.g. `document_contents`, one row per document, FK'd to `Document`). Keeps the frequently-queried `documents` table lean, cleanly separates the "metadata" concern from the "content" concern, and sets up naturally for Phase 6 — which will read this content once and explode it into many chunk rows anyway, so "content lives in its own place, metadata stays light" is a pattern that's about to matter more, not less.
3. **A file via the same `StorageAdapter` interface** Phase 3 already built for the original upload. Consistent with "files are files," keeps Postgres slim — but loses easy SQL queryability (can't filter/search on content without a separate read), and adds another I/O round-trip whenever anything needs the text.

Worth deciding deliberately in the Design step below, not defaulting silently.

### Q8 — A genuinely valid PDF/DOCX that still causes real problems

**Asked:** Files already passed Phase 3's magic-byte check. Does that mean parsing them is now safe? What's a way a *real*, non-malicious-looking file could still cause trouble?
**Answer:** "dont know"

Passing the magic-byte check only confirms the file's *header* genuinely matches PDF/DOCX — it says nothing about what's safe to do once you actually start parsing deeper into the file. Several real risk categories:

- **Zip bombs (decompression bombs).** A DOCX is a ZIP archive, and ZIP compression can achieve extreme ratios on pathological input — a file that's a few kilobytes on disk can expand to gigabytes when decompressed. If extraction code naively unzips and loads the full decompressed content into memory with no limit, a tiny, entirely well-formed-looking `.docx` upload could exhaust server memory and crash or hang the worker process. Mitigation: cap the decompressed size a ZIP library is allowed to produce, or stream/limit reads rather than reading everything unbounded.
- **XML entity-expansion attacks ("billion laughs").** Since DOCX content is XML, a maliciously crafted XML file can define nested entities that reference each other recursively, causing the parser itself to balloon a tiny input into an enormous expanded string purely during XML parsing — independent of the ZIP-bomb concern above. Well-maintained modern XML parsers generally disable this kind of expansion by default, but it's a real, named category worth recognizing (also related: **XXE**, XML External Entity attacks, where malicious XML tries to make the parser fetch external resources).
- **Parser bugs on malformed internal structure.** A file can have a perfectly correct header (passing Phase 3's check) while being corrupted or malformed further in — real parsing libraries for complex binary formats like PDF have historically had genuine security vulnerabilities (crashes, hangs, even memory-safety bugs in native/C-based implementations underlying some PDF libraries). The general posture worth having: **never fully trust a file just because its format looks right at a glance** — put real limits (timeouts, memory ceilings) around the parsing step itself.
- **Legitimately huge, valid files.** A 5,000-page, entirely genuine, non-malicious PDF can still take a very long time and a lot of memory to parse. Tying back to Phase 4: a hung parsing job ties up one of the 5 concurrent worker slots — worth having an explicit timeout on the extraction step itself, separate from Phase 3's file-*size* limit (a file can be small in bytes but pathological to parse, or the reverse).

### Q9 — Should `status` grow new values for parsing sub-stages, or does fine detail belong elsewhere

**Asked:** The prototype's UI shows distinct stages ("Parsing document" → "Generating embeddings" → "Indexing knowledge"). Should `Document.status` grow to match, or is there a better place for that detail?
**Answer:** "dont know"

There are genuinely two different *kinds* of information being conflated in the prototype's pipeline visual, and it's worth separating them:

- **Durable, macro-level stage** — "what broad state is this document in, right now, that would still be true if I queried the database an hour from now." This belongs in `status`, because it needs to survive restarts, be queryable via plain SQL, and be meaningful to any API consumer.
- **Transient, high-frequency micro-progress** — "page 45 of 200," "batch 12 of 19" — changes rapidly, is really only interesting *while it's happening*, and is exactly what `job.updateProgress()` (Q4) already exists for. Persisting every micro-update to Postgres would be wasteful and unnecessary.

Given that distinction: whether `status` should grow a dedicated `'parsing'` value (as opposed to leaving parsing folded into the existing generic `'processing'`) is a real, worth-deciding-explicitly question, but it's a **schema decision**, not a default outcome of this phase. The prototype's UI does show distinct stage labels, so this isn't purely hypothetical future need — but it's still worth deciding deliberately in the Design step rather than growing the enum reflexively just because a design mockup shows more detail than the database currently tracks.

### Q10 — "Success" as a fuzzy boundary, illustrated by a corrupted-font example

**Asked:** Extraction succeeds, but the result is just three stray garbled characters from a bad font mapping. `ready` or `failed`?
**Answer:** "dont know"

This question exists to make a specific point: unlike "did the upload succeed" (close to a clean binary — the bytes either arrived intact or they didn't), **"did extraction succeed" is a spectrum, not a boolean.** Between "completely empty" (clear failure) and "a full, clean transcript" (clear success) sits a wide, messy middle: a handful of garbled characters from a font-encoding mismatch (exactly Q1's glyph-mapping issue, showing up as a real consequence rather than a hypothetical), scrambled multi-column text, a document mostly extracted correctly except for one page with an unusual embedded font, non-Latin scripts mishandled by an extraction library that assumed Latin encoding, and more.

Where you draw the "good enough to call `ready`" line is a genuine product-and-engineering judgment call — and it matters *downstream*, not just in the moment: garbage extracted text becomes garbage chunks (Phase 6), becomes garbage embeddings (Phase 7), becomes a RAG system that can end up confidently citing nonsense to a real customer. A reasonable, honest approach for now: a simple heuristic (extracted length relative to page count, as touched on in Q3) rather than pretending to solve "text quality" perfectly upfront. Worth planting now: this project has an entire future phase — **Phase 17, Evaluations** — dedicated to *measuring* answer and retrieval quality empirically, precisely because "is this good enough" questions like this one don't have a clean upfront answer; they get a real answer once there's a way to measure outcomes, not before.

---

## Topics you must know before moving on

Given every question came back UNKNOWN, this list is close to "the whole phase" — ranked by how load-bearing each is for actually building this phase's code, not by how badly it was missed (all equally).

1. **PDF's actual structure: a drawing-instruction format, not a text format** (Q1) — the single most foundational fact this phase rests on. Understanding *why* a scanned PDF has zero extractable text (there's no text data in the file at all, not "the extraction failed") is what makes the `failed` status make sense as correct behavior rather than an error case to "fix."
2. **DOCX as ZIP-of-XML, requiring an entirely separate code path from PDF** (Q2) — not a detail, a structural fact that shapes the whole implementation (two libraries, two functions, dispatched by MIME type).
3. **`job.updateProgress()`'s actual scope: Redis-resident, ephemeral, not Postgres** (Q4) — needed to avoid the wrong assumption that progress "just persists somewhere" without a deliberate decision to make it durable.
4. **Extraction "success" as a spectrum, not a boolean, and why that matters downstream** (Q3, Q10) — this shapes actual code (the failure-detection heuristic) and is also a preview of a recurring theme in Phases 6-7 (chunking quality, embedding quality) — very little in the RAG pipeline is a clean pass/fail the way file-upload validation was.
5. **New security surface introduced specifically by parsing (zip bombs, XML expansion, parser bugs on malformed-but-valid-looking files)** (Q8) — a genuinely new category of risk this phase introduces that Phase 3's magic-byte check does *not* protect against, despite sounding similar ("we already validated the file type").
6. **The storage-location tradeoff for extracted text** (Q7) — a real design decision with consequences for Phase 6, not a detail to skip past.
7. **Idempotency risk scales with the cost and shape of the side effect** (Q6) — Phase 4's guard was "free" to reason about (flipping a status is trivially safe to repeat); this phase's guard is protecting something with real cost and, depending on storage choice, real leak potential.

---

## Architecture & decisions

Design proposed after the diagnostic, agreed to as-is (no changes requested):

**1. Extracted text storage: a separate `document_contents` table (Q7, option 2).** One row per document, `document_id` as a `UNIQUE` FK to `documents` with `ON DELETE CASCADE` (same cascade pattern as `refresh_tokens` — content has no independent existence once its document is gone). Chosen over a column on `Document` to keep the frequently-listed `documents` table lean, and because Phase 6 is about to need "content lives separately from metadata" anyway (one document explodes into many chunk rows) — building that separation now rather than migrating into it later.

**2. Extraction libraries: `pdf-parse` for PDF, `mammoth` for DOCX.** Both are widely-used, actively-maintained, pure-JS (no native binary dependency to compile/ship) libraries that do exactly one job each. No LangChain-style all-in-one document loader — consistent with the project's existing "no LangChain, thin custom interfaces" stance from the LLM provider decision.

**3. Two distinct failure types, handled differently:**
   - **Deterministic "no extractable text" (Q1, Q3, Q10)** — extraction *succeeds* (no thrown error) but the result is effectively empty. This is not a transient problem — retrying a scanned PDF five more times will never produce text. Handled entirely inside the processor: detect it via `isEffectivelyEmpty()`, set `status: 'failed'` with a clear `failureReason` directly, and **do not throw** — throwing would hand it to BullMQ's retry/backoff machinery (Phase 4), wasting two more attempts on a file that can never succeed.
   - **Genuine errors (parser crash, timeout, corrupted-but-header-valid file, I/O failure reading from storage)** — these *are* worth retrying (a transient timeout under load might succeed on attempt 2). These propagate as thrown errors, exactly as Phase 4's existing retry/backoff/`@OnWorkerEvent('failed')` machinery already expects — no new failure-handling code needed here, just correct code that doesn't accidentally swallow real errors into the deterministic path.

**4. `status` enum: not extended this phase (Q9 resolved toward "no").** `'processing'` stays a single generic value covering the whole pipeline; the prototype's per-stage UI copy ("Parsing document," "Generating embeddings"...) is presentation detail, not something the database needs to track durably yet. Revisit if a real product need for querying "which stage is this document currently in" shows up later — not before.

**5. Partial-extraction failure: discard and fail cleanly (Q5 resolved toward option 1).** If extraction throws partway through (should be rare — both libraries parse a document as a whole rather than streaming page-by-page into our code), nothing partial gets written to `document_contents`. Matches the product's "don't silently degrade trust" posture more than any of this phase's code complexity is worth trading for.

**6. Extraction timeout: 30 seconds, enforced in application code, not BullMQ.** `withTimeout()` races the extraction promise against a timer and throws `ExtractionTimeoutError` if it loses — an application-level ceiling on a single pathological parse (Q8's "legitimately huge, valid file" case), independent of and unrelated to BullMQ's own job-level `attempts`/backoff/stall-detection timers from Phase 4. A timed-out extraction throws, so it flows into the genuine-error/retry path (attempt 2 might hit a less-loaded worker and finish in time) rather than being treated as a deterministic failure.

**7. Zip-bomb / XML-expansion risk (Q8): accepted, not mitigated, this phase.** `mammoth` sits on top of well-maintained XML parsing that disables entity expansion by default, and file size is already capped at 50MB by Phase 3's upload limit — bounding how bad a decompression bomb can practically get from a single upload. A dedicated decompressed-size ceiling is real, known future-hardening work, explicitly deferred rather than silently skipped.

---

## Data flow

```
Phase 4's DocumentProcessingProcessor picks up a job: { documentId }
        │
        ▼
Load Document row (workspace_id, storage_key, mime_type) — idempotency guard:
if status is already 'ready' or 'failed', no-op and return (unchanged from Phase 4)
        │
        ▼
status: 'uploaded' → 'processing'  (unchanged from Phase 4)
        │
        ▼
buffer = StorageAdapter.read(storage_key)        (Phase 3's adapter, unchanged)
        │
        ▼
extractText(buffer, mimeType)                     (NEW — this phase)
   ├─ pickExtractor(mimeType) → extractPdfText | extractDocxText | throw UnsupportedMimeTypeError
   └─ raced against a 30s timeout → ExtractionTimeoutError on loss
        │
        ├── THROWS (parser crash / timeout / storage read failure)
        │         │
        │         ▼
        │   propagate up to BullMQ (Phase 4's retry/backoff/@OnWorkerEvent('failed') handles it,
        │   unchanged — up to 3 attempts, then status: 'failed' with a generic failureReason)
        │
        └── RESOLVES with { text, pageCount }
                  │
                  ▼
            isEffectivelyEmpty(text)?
                  │
        ┌─────────┴─────────┐
       YES                  NO
        │                    │
        ▼                    ▼
  status: 'failed'     save DocumentContent row
  failureReason:        { documentId, extractedText: text, pageCount }
  "no extractable            │
   text found"                ▼
  (no throw —          status: 'processing' → 'ready'
   no retry wasted)
```

---

## Migrations: what each table and column actually stores

**`document_contents`** (`CreateDocumentContents` migration) — one row per successfully-parsed document, holding the raw extraction output that Phase 6 will read and chunk.

| Column | Stores | Why |
|---|---|---|
| `id` | Auto-increment integer PK. | Consistent with every other table's PK style in this project (locked decision — see CLAUDE.md). |
| `document_id` | FK to `documents.id`, `UNIQUE`, `ON DELETE CASCADE`. | The `UNIQUE` constraint is what makes this genuinely one-to-one rather than one-to-many — the DB itself refuses a second content row for a document that already has one, backing up the idempotency guard at the storage layer, not just the application-code layer. `CASCADE` because extracted content has no reason to outlive the document it was extracted from. |
| `extracted_text` | The full raw text pulled out of the file — a `text` column (unbounded length, unlike `varchar`). | Postgres automatically moves large `text` values out-of-line via TOAST, so a multi-hundred-page document's text doesn't bloat every sequential scan of this table the way it would if forced into a fixed-width type. |
| `page_count` | Nullable integer — the page count `pdf-parse` reports, or `null` for DOCX (no fixed pagination without an actual rendering engine — Q2's territory). | Kept nullable rather than `0` or `-1`, because "unknown/not applicable" and "zero pages" are semantically different facts and shouldn't collide on the same sentinel value. |
| `created_at` | Timestamp, defaulted by the DB (`now()`). | When extraction actually completed — useful later for debugging "why does this document's content look stale" independent of `Document.updatedAt` (which Phase 3 doesn't currently even track — worth noticing as a gap, not fixed here). |

---

## Code walkthrough

**`document-content.entity.ts`** — the TypeORM entity described above. One thing worth noticing explicitly: `pageCount: number | null` is declared with an explicit `type: 'integer'` on the `@Column()` decorator. This isn't optional style — a bare `@Column()` on a `T | null`-typed property reflects to TypeScript's `Object` type at runtime (TypeScript erases the union, and `reflect-metadata` only sees the JS class `Object`), which TypeORM cannot map to a real Postgres column type. This exact mistake broke migrations in three earlier phases before the rule ("always give an explicit `type:` to any nullable column") became automatic — it didn't recur here only because it was applied from the start.

**`extraction.ts`** — the dispatcher and the two shared concerns (timeout, emptiness heuristic) that don't belong inside either format-specific extractor:
- `pickExtractor(mimeType)` — a plain `if/if/throw` rather than a lookup map or a registry pattern. Two supported formats doesn't justify the extra indirection a map/registry would add; this is a case for staying concrete rather than reaching for a "scalable" pattern with only two entries.
- `withTimeout()` — a generic `Promise.race`-style helper (implemented by hand rather than `Promise.race` directly, so the timer can be `clearTimeout`'d on the winning path — `Promise.race` alone would leave a dangling timer running for 30s even after the real promise already resolved, which is a real, if minor, leak worth avoiding).
- `isEffectivelyEmpty()` — deliberately exported and separately unit-testable from the extraction call itself, because it's a pure function with no I/O — exactly the kind of logic that should have direct, fast unit tests rather than only being exercised indirectly through a slower integration-style test.

**`pdf-extractor.ts` / `docx-extractor.ts`** — thin, single-purpose wrappers around `pdf-parse`/`mammoth`, both returning the same shared `ExtractionResult` shape so `extraction.ts` doesn't need to know which library actually ran.

**`document-processing.processor.ts`** — Phase 4's trivial placeholder replaced with the real pipeline: idempotency guard (unchanged) → `PROCESSING` → (`throwForTesting` short-circuit, unchanged) → `storage.read()` → `extractText()` → branch on `isEffectivelyEmpty()` → either `FAILED` with a fixed reason (no throw) or `documentContents.upsert(...)` + `READY`. The `upsert` (keyed on `documentId`, not a plain `insert`) is the one piece of new idempotency-relevant design: if a previous attempt already wrote the content row but crashed before flipping the status to `READY`, a redelivered job lands on the identical final state instead of throwing a duplicate-key error on `document_contents`'s `UNIQUE(document_id)` constraint — directly answering Q6/Q7 from the diagnostic with real code, not just discussion.

---

## Failure cases actually tested

**1. Scanned/image-only PDF → deterministic `failed`, no retry wasted.** `scanned.pdf` (fixture, image-only page) reliably extracts to text below the 40-character meaningful-text threshold. Test: `document-processing.e2e.spec.ts` → *"marks a scanned/image-only document failed directly, without exhausting retries"*. Confirms `status: 'failed'`, the specific `failureReason`, and — critically — that no row was written to `document_contents` (nothing partial persists for a file that produced no real content).

**2. A genuine PDF extracts and saves correctly end-to-end.** `sample.pdf` (real, headless-Chrome-generated, valid PDF bytes) → `status: 'ready'`, a `document_contents` row with the real extracted text and a correct `page_count`. This is the "happy path," but it's still a real test against real `pdf-parse` output, not a mock.

**3. `UnsupportedMimeTypeError` for a mime type with no registered extractor** — unit-tested directly in `extraction.spec.ts` against `pickExtractor`'s dispatch logic (e.g. `image/png`), confirming an unknown-but-otherwise-legitimate mime type fails loudly and specifically rather than silently no-op'ing or hitting a generic crash.

**4. The `isEffectivelyEmpty()` heuristic at its exact boundary** — unit-tested with synthetic strings at 38 and 56 characters (either side of the 40-character `MIN_MEANINGFUL_TEXT_LENGTH` constant), not just "obviously empty" vs. "obviously full" cases — the boundary itself is where heuristics like this actually go wrong if you only ever test the easy cases.

**5. A real, unplanned bug: pdf-parse + Jest + BullMQ worker callbacks.** This is the failure case that actually consumed the most time in this phase, and it's worth documenting in full because *how* it was diagnosed is at least as valuable as the fix.

*Symptom:* `document-processing.e2e.spec.ts`'s real-PDF tests failed unpredictably — sometimes an outright hang (`Condition not met within Nms`), sometimes a thrown `TypeError: PDFJS.getDocument is not a function` surfacing as the job's `failureReason`. The SAME extraction code, called directly from a test body or from a plain `node` script, worked every single time, with zero exceptions across dozens of manual runs.

*Diagnosis, step by step:*
1. First suspected infrastructure: Docker Desktop had in fact silently stopped running mid-session (confirmed via `docker info` failing), which explained an *earlier*, different hang (`queue.add()` blocking forever waiting for an unreachable Redis) — a real, separate bug, fixed by restarting Docker and the `anchor-redis-1` container. But after fixing that, the PDF-specific failures remained.
2. Second suspect: the runtime TypeORM config (`app.module.ts`'s `TypeOrmModule.forRootAsync`) hadn't been updated to include the new `DocumentContent` entity — only the migration-CLI config (`data-source.ts`) had. This is the exact "two TypeORM configs" gotcha flagged as still-shaky back in Phase 1/2's closing quizzes, now encountered for real a second time. Real bug, real fix (add it to both), but still not the root cause of the PDF-specific flakiness.
3. With infrastructure and DI both fixed, the *exact same* error persisted: `PDFJS.getDocument is not a function`, thrown from deep inside `pdf-parse`'s own bundled (and quite old — 2017-era) copy of `pdf.js`, specifically from its lazy, module-level-cached `require()` of that bundle.
4. Isolated the trigger precisely by adding trace logging at each step and testing variations: calling `extractPdfText()` **directly from a Jest test body** — reading the exact same fixture bytes, in the exact same process — succeeded every time. Calling the **exact same function** via `queue.add()` → BullMQ's real worker → its `process()` callback failed reproducibly. Confirmed the failure is specific to *Jest's process*, not to the code: the identical call, wrapped in `setImmediate` to simulate a native-callback context, run in a plain `node -e` script outside Jest entirely, succeeded without issue.
5. Root cause was narrowed to (but not fully explained beyond) Jest's module-sandboxing interacting badly with a dynamically-`require()`'d, module-level-cached dependency when that `require()` is first triggered from several native I/O stack frames deep (Redis's socket callback → BullMQ's internal job loop → our processor) rather than from code Jest's own test runner called directly. This is a real, narrow, and reproducible category of test-environment-only bug — genuinely different from a production bug, and worth being able to tell the two apart rather than assuming "test failed" always means "code is wrong."

*Fix:* rather than chase Jest's internals further (diminishing returns for this phase's actual learning goals), the two tests that need *real* `pdf-parse` output call `processor.process(...)` directly — still 100% real code (real Postgres, real files on disk, real `pdf-parse`), just not routed through BullMQ's transport for these two specific assertions. The other two tests in the same file (`retries with backoff`, `is idempotent`) *do* still go through the real queue end-to-end, because neither of them touches `pdf-parse` — proving the queue mechanism itself (retry/backoff, idempotent redelivery) works is unaffected by this quirk and didn't need to be worked around.

*Why this is worth keeping in the docs rather than quietly fixing and moving on:* it's a concrete, lived example of a theme that recurs constantly in real engineering — a test failure that is real (don't ignore it) but whose root cause lives in the *test environment's* interaction with a dependency, not in the application logic being tested. Telling those apart, rather than reflexively patching application code until a flaky test goes green, is a skill of its own.

**6. The scanned-PDF fixture's own limitation, discovered because of failure #5.** While debugging the above, a second, smaller, genuinely-in-the-code bug surfaced: the first `scanned.pdf` fixture (built by printing an image-only HTML page via headless Chrome) wasn't *actually* empty — Chrome's print pipeline stamps a date/URL/page-number footer into every PDF it produces regardless of page content, and that footer's length depended on the absolute file:// path of the source HTML file, which was long enough to land just *above* the 40-character `isEffectivelyEmpty()` threshold. The bug only became visible once test #5's real bug was fixed and the scanned-PDF test could actually reach real, un-short-circuited extraction logic for the first time — it had been masked the whole time by the Jest/pdf-parse failure short-circuiting to `failed` for an entirely wrong reason. Fixed by regenerating the fixture from a much shorter path (a temporary `subst`'d drive letter, removed afterward), shrinking the incidental footer text to 37 characters — under the threshold. Documented here because it's a good, concrete illustration of Q3/Q10's point from the diagnostic: "effectively empty" is a heuristic with a real, testable boundary, and a fixture that's *supposed* to represent "no real content" can still accidentally sit on the wrong side of that boundary if you don't check.

---

## Tests and why each exists

| Test file | What it proves | Why it's real, not mocked |
|---|---|---|
| `pdf-extractor.spec.ts` | Real PDF bytes → real extracted text + page count; an image-only PDF → no real content in the output | Uses a genuine, headless-Chrome-generated PDF, not a hand-constructed byte string (see Reverse-engineering guide for why) |
| `docx-extractor.spec.ts` | Real DOCX (ZIP+XML) bytes → real extracted text, `pageCount: null` | Fixture built with `jszip` constructing actual OOXML parts (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`) |
| `extraction.spec.ts` | Dispatch-by-mime-type routing; `UnsupportedMimeTypeError`; `isEffectivelyEmpty()`'s exact boundary | Pure logic plus the same real fixtures — no mocking of the extraction libraries themselves anywhere in this phase |
| `document-processing.e2e.spec.ts` | The whole pipeline wired together: storage read → extraction → status/content persistence, both success and deterministic-failure paths, plus (unchanged from Phase 4) retry/backoff and idempotent redelivery | Real Postgres, real filesystem storage, real Redis-backed BullMQ queue for the two tests that don't need to route around the Jest/pdf-parse quirk |

---

## Reverse-engineering guide (if reopened in six months)

1. Start at `extraction.ts` — the dispatcher is the whole contract: `extractText(buffer, mimeType) → { text, pageCount }`, plus the two things every caller needs to know about (`isEffectivelyEmpty()` for the deterministic-failure heuristic, `UnsupportedMimeTypeError`/`ExtractionTimeoutError` for the two named failure types).
2. Then `document-processing.processor.ts` — the only consumer of `extraction.ts` right now, and the place where the "empty vs. thrown error" branch turns into an actual `Document.status` decision.
3. `document-content.entity.ts` + the `CreateDocumentContents` migration — confirms the storage-location decision from the diagnostic (Q7): a separate table, `UNIQUE(document_id)`, `CASCADE` delete.
4. If a test in `document-processing.e2e.spec.ts` is failing in a way that looks like a `pdf-parse` internal error (`PDFJS.getDocument is not a function` or similar) **and only inside Jest, never in a plain running app** — re-read Failure Case #5 above before assuming the extraction code itself is broken. Check whether the failing code path is being invoked through BullMQ's real worker versus a direct call first.
5. The `fixtures/` directory (`sample.pdf`, `scanned.pdf`, `sample.docx`) is small and deliberately real, not hand-rolled — if a fixture ever needs regenerating, see this phase's write-up for the headless-Chrome command and the `jszip` DOCX-construction pattern rather than hand-writing PDF/DOCX bytes from scratch (multiple hand-rolled PDF attempts failed with `bad XRef entry` for reasons never fully root-caused — not worth repeating).

---

## Closing quiz (round 1) — answered and scored (2026-09-16)

Same batching format as the opening diagnostic: 10 questions, one combined reply, scored honestly without correcting in place.

### Q1 — Why can a completely valid, non-corrupted PDF still yield zero extractable text?
**Answer:** "dont know"
**Score: UNKNOWN.** Unchanged from the opening diagnostic, despite the first-principles teaching above (Q1 in the diagnostic section). The real answer: a PDF is a page-*description* format — a sequence of drawing instructions (glyph positions, font references) — not a text format. A scanned page is one embedded image with zero text-showing instructions in it; there is no text data anywhere in the file for a library to find. It isn't a corrupted or partially-broken PDF — it's a structurally valid file that never contained extractable text.

### Q2 — Why does DOCX need a completely separate code path from PDF?
**Answer:** "becuse we dont get page number"
**Score: UNKNOWN.** This names a *downstream symptom* (DOCX extraction reports `pageCount: null`), not the actual reason two separate code paths are required. The real answer: PDF is a binary, page-description format (drawing instructions + glyph codes needing font-mapping translation); DOCX is a ZIP archive containing literal XML text (`<w:t>` nodes) with no glyph-to-Unicode translation step and no reading-order ambiguity. They're unrelated file formats requiring unrelated parsing libraries — the missing page count is just one visible *consequence* of DOCX having no fixed pagination, not the reason the code is split.

### Q3 — How does the code decide a PDF is "a scan with no extractable text" vs. genuinely extracted content?
**Answer:** "so we check if number of word are more tha 40 than we consider it valid pdf"
**Score: SHAKY.** The core mechanism — a length-based threshold check — is right, and that's real progress from "don't know." Two imprecisions worth naming: (1) `isEffectivelyEmpty()` checks *character* length after trimming whitespace (`text.trim().length < 40`), not a word count — a meaningful difference, since 40 words is roughly 200+ characters, a much higher bar than what the code actually enforces; (2) the framing "we consider it valid pdf" isn't quite right either — the PDF itself is already known to be valid (it parsed without throwing) by this point; what the threshold decides is whether the *extracted text* is meaningful enough to call the *extraction* successful, a distinct question from the file's validity.

### Q4 — Where does `job.updateProgress()`'s data actually live, and does it survive a worker restart?
**Answer:** "it lives in db and yes it will survive"
**Score: UNKNOWN — and notably, the identical wrong answer as the opening diagnostic**, word for word in substance ("it will be store in our database"), despite an explicit, dedicated first-principles explanation of exactly this question in the diagnostic section above. This is the single most concerning result in this quiz: teaching didn't move this one at all. The real answer: `job.updateProgress()` writes into a Redis hash structure BullMQ maintains for that job (`bull:<queueName>:<jobId>`), and emits a `progress` event — nothing about it touches Postgres. It does **not** reliably survive a restart: Redis is in-memory, and even with persistence configured, `removeOnComplete` can wipe a completed job's data anyway. Treat it as a live, ephemeral signal, not a durable record — see the "Topics to master" list below, this is now flagged for deliberate re-exposure in Phase 6.

### Q5 — If extraction throws a genuine error (not the deterministic-empty case), what happens to the document's status? Walk through it.
**Answer:** "dont know"
**Score: UNKNOWN.** The real answer, straight from the code: the thrown error propagates up out of `process()` uncaught, which BullMQ's own retry machinery (Phase 4, unchanged) catches — it schedules another attempt with exponential backoff (up to the configured `attempts`). Only once every attempt is exhausted does `@OnWorkerEvent('failed')` fire and set `status: 'failed'` with the real error as `failureReason`. This is a direct, load-bearing continuation of Phase 4's retry logic — nothing new was built for this path, but understanding *why* a genuine error takes this route (versus the deliberately-not-thrown deterministic-empty case) is the actual design decision this phase made.

### Q6 — Why does `document-processing.processor.ts` use `documentContents.upsert(...)` instead of a plain insert when saving extracted text?
**Answer:** "than we will mark it not ready"
**Score: UNKNOWN.** This doesn't address the upsert-vs-insert question at all. The real answer: a redelivered job (retry, stall recovery) could re-run extraction on a document whose *previous* attempt already inserted a `document_contents` row but crashed before the follow-up `status: 'ready'` update landed. A plain `insert` on the second attempt would hit the `UNIQUE(document_id)` constraint and throw a duplicate-key error — turning a job that's actually *fine* into a spurious failure. `upsert` (keyed on `documentId`) makes the write land on the same correct end state regardless of how many times it runs, which is exactly Q6 from the opening diagnostic ("what breaks if the idempotency guard were removed") made concrete in real code.

### Q7 — What's the actual difference between `UnsupportedMimeTypeError` and `ExtractionTimeoutError` — when does each fire, and what happens to the job afterward?
**Answer:** "so first one check if the document is eady pdf as user is saying and second dont know"
**Score: UNKNOWN.** The first half is close to a real idea (something about mime-type mismatch) but not stated precisely enough to count, and the second half is an explicit "don't know." Real answer: `UnsupportedMimeTypeError` fires synchronously, immediately, from `pickExtractor()` — before any extraction is attempted — when the document's `mimeType` isn't PDF or DOCX; `ExtractionTimeoutError` fires only after 30 real seconds have elapsed with the extraction promise still unsettled (a genuinely slow or hung parse). Both are thrown errors, so both flow into the *same* genuine-error/retry path from Q5 — neither is treated as the deterministic-empty case. Practically, though, retrying an `UnsupportedMimeTypeError` is pointless (the mime type will never change), which is worth noticing as a slightly awkward edge in the current design — not fixed this phase, but real and worth flagging.

### Q8 — Name one real security/robustness risk introduced specifically by *parsing* file contents, that Phase 3's magic-byte check does not protect against.
**Answer:** "dont know"
**Score: UNKNOWN.** Unchanged from the diagnostic. Real answer (any of): zip bombs (a small, well-formed `.docx` that decompresses to gigabytes), XML entity-expansion attacks inside `word/document.xml`, or a parser vulnerability triggered by a file whose header is genuinely valid but whose deeper internal structure is malformed. All of these can only be reached *after* the magic-byte check already passed — that check only confirms the file's first few bytes match the claimed format.

### Q9 — In today's debugging: what was the actual, confirmed difference between the call that always worked and the call that sometimes failed?
**Answer:** "dont know"
**Score: UNKNOWN.** Real answer: the *exact same* `extractPdfText()` call, using the *exact same* fixture bytes, succeeded every time when invoked directly from a test's own code, and failed reproducibly when invoked through BullMQ's real worker callback — but **only under Jest**; the identical call in a plain `node` script (even one deliberately deferred via `setImmediate` to mimic a native-callback context) always succeeded. The confirmed, load-bearing fact: this was a test-environment artifact, not an application bug — proven by testing the same code path both inside and outside Jest, not by assumption.

### Q10 — Why did the first version of the `scanned.pdf` fixture fail to trigger `isEffectivelyEmpty()`, even though the page had no real text on it?
**Answer:** "dont know"
**Score: UNKNOWN.** Real answer: headless Chrome's print pipeline stamps a date/URL/page-number footer into *every* PDF it generates, regardless of what's on the page — so "image-only page" didn't mean "zero extracted text," it meant "extracted text is just that footer." The footer's length depended on the absolute file path of the source HTML (a longer path meant a longer `file:///...` string in the footer), and the first version happened to land at 65 characters — above the 40-character threshold. Fixed by generating the fixture from a much shorter path, shrinking the footer to 37 characters.

### Closing quiz (round 1) result: **0 SOLID / 1 SHAKY / 9 UNKNOWN**

This is materially unchanged from the opening diagnostic (0/0/10) — Q3 moved from UNKNOWN to SHAKY, nothing else moved. Per the project's standing rule ("if a critical topic is still UNKNOWN, teach it and re-ask — the phase isn't done"), the three most load-bearing questions here are being re-taught and re-asked before this phase is considered closed: **Q1** (everything else in this phase rests on this fact), **Q4** (the *identical* wrong answer recurring after dedicated teaching is the strongest signal in this whole quiz that something about the explanation didn't land, not just that it wasn't retained), and **Q6** (the specific idempotency mechanism this phase's actual code implements). See the re-ask below.

---

## Re-teaching the three critical gaps (different angle, since prose alone didn't land the first time)

**Q1 — a PDF is a robot's instruction tape, not a text file.** Imagine a robot arm holding a pen, given a tape of instructions: *"Move to (72, 700). Pick up the stencil shaped like the letter H. Press it down. Move to (84, 700). Pick up the stencil shaped like the letter e. Press it down..."* The robot has no idea it's writing a word — it's just following move-and-stamp instructions. That's exactly what a PDF's content stream is: a tape of drawing instructions. A text-extraction library's whole job is to read that tape and reverse-engineer "the shapes at these positions probably spell 'Hello'."

Now imagine, instead, someone hands the robot **a single instruction**: *"Stamp this one photograph, unchanged, covering the whole page."* That's what a scanned PDF is — one image-drawing instruction, nothing else. There's no tape of "move here, stamp this letter-shape" for the extractor to read, because a photograph was never built out of letter-shapes in the first place — it's pixels. This is why it's not a bug or a corrupted file: the "recipe" for building this particular page simply never included any text-drawing steps, in exactly the same way a photo of a street sign contains no GPS coordinates just because a human looking at the photo can read the sign.

**Q4 — two separate databases exist in this app, and `job.updateProgress()` only ever touches one of them.** This app has Postgres (durable — what your API reads from, what survives forever, what a `psql` query can find tomorrow) and Redis (fast, memory-resident, what BullMQ's own internal bookkeeping lives in). Rule of thumb that would have caught this: **if you never personally wrote a line of code that calls `this.someRepository.update(...)` or `.save(...)` on a Postgres entity, the data did not go into Postgres** — it's living inside whatever *other* system actually owns that call. `job.updateProgress(50)` is a method BullMQ itself provides; BullMQ manages its own progress bookkeeping entirely inside Redis, and nothing in `document-processing.processor.ts` ever writes progress to a `Document` column.

Concrete side-by-side, from the actual code in this phase: `this.documents.update(documentId, { status: 'ready' })` → that's a real line in `document-processing.processor.ts`, so *that* data is genuinely in Postgres, genuinely durable. `job.updateProgress(50)` → that line doesn't exist anywhere in this phase's code, but if it did, it would be BullMQ writing into *its own* Redis structures — code you never wrote and a database you didn't choose for that write. Sharpest test of whether this has landed: if the Redis container were deleted entirely right now, `Document.status` would still correctly say `'ready'` (safe in Postgres) — but any `job.updateProgress()` value from a job that already finished would be gone completely, because it was never anywhere except Redis's memory to begin with.

**Q6 — trace through the exact crash this protects against, using this phase's real code.** Attempt #1 of a job: extraction succeeds, `documentContents.insert(...)` runs and a real row appears in `document_contents`. Then, right before the *next* line (`this.documents.update(documentId, { status: 'ready' })`), the whole process crashes — power loss, an out-of-memory kill, doesn't matter. From BullMQ's point of view, this job never called back to say "done," so once its lock expires it gets redelivered — attempt #2 starts.

Attempt #2 passes the idempotency guard (status is still `'processing'`, not `'ready'`/`'failed'`), so it runs extraction again (wasteful, but not wrong) and reaches the same "save the content" line. **If that line were a plain `insert`**, it would hit the `UNIQUE(document_id)` constraint left behind by attempt #1's already-saved row and throw a duplicate-key error — turning a document that's actually *fine* (its content really did get saved) into one that looks broken. Because the real code uses `upsert` instead, attempt #2's write just overwrites attempt #1's identical values with no error, execution reaches the `status: 'ready'` line this time, and the document correctly ends up `ready` — exactly once, no matter how many attempts it actually took.

**Re-ask status: left unanswered, by explicit user choice (2026-09-17).** The three re-taught questions above were posed but not answered — the user chose to move directly to Phase 6 instead. Flagged once per the project's standing rule (never silently proceed past a state the protocol calls incomplete without saying so), then respected as the user's call, consistent with how every other locked decision in this project has worked. **Net effect: Phase 5 closes with 9 of 10 closing-quiz topics still at UNKNOWN, unusually weak even by this project's own pattern (compare Phase 2's 0/3/7 or Phase 4's 2/3/5) — carried forward as open debt, not resolved.** In particular, Q4 (`job.updateProgress()`'s Redis-only, non-durable scope) produced the *identical* wrong answer across three separate exposures now (opening diagnostic → closing quiz → still unaddressed at the re-ask) and should be treated as a standing weak spot the moment BullMQ progress reporting becomes relevant again (Phase 12's real-time work is the likely next trigger), not assumed fixed by this phase's teaching.

---

## Topics to master

Combining both the opening diagnostic (10/10 UNKNOWN) and the closing quiz (0 SOLID / 1 SHAKY / 9 UNKNOWN), ranked by how load-bearing each is across backend engineering generally — not by how badly each was missed here, though in this phase's case that ordering ends up nearly the same.

### 1. Binary/structured file format internals (why "the bytes are valid" ≠ "the content is text")
**Search:** "PDF file format internals content stream", "OOXML file format DOCX structure", "how does pdf.js extract text from PDF"
**Exposed by:** Q1 and Q2, both times, both quizzes.
High-leverage because it's the specific instance of a much bigger idea: almost every "we can't parse this file" bug in a real backend traces back to a wrong mental model of what a file format actually *is* at the byte level, not a library bug. Engineers who reach for "let's just try a different library" without first asking "what does this format actually store, structurally" burn enormous time on problems a five-minute spec skim would have prevented.

### 2. Durable storage vs. ephemeral/in-memory bookkeeping (Postgres vs. Redis as a design axis, not just "two databases")
**Search:** "Redis vs Postgres use cases", "what data belongs in Redis", "BullMQ job progress persistence"
**Exposed by:** Q4, in the opening diagnostic, the closing quiz, and again at the re-ask — the single most consistent gap in this entire phase, unmoved by two dedicated teaching passes.
Genuinely one of the highest-leverage distinctions in backend systems generally: knowing *by design*, not by memorization, which category a given piece of state belongs in (would losing this on a restart be catastrophic, or shrug-worthy?) is the difference between an engineer who reaches for the right tool reflexively and one who has to look it up every time. This is flagged as unresolved going into Phase 6 and should get deliberate, concrete re-exposure the next time BullMQ progress or any Redis-resident state comes up — not assumed fixed.

### 3. Idempotent writes via upsert (making a retry safe by construction, not by hoping)
**Search:** "upsert vs insert idempotency", "postgres ON CONFLICT DO UPDATE", "idempotent job processing patterns"
**Exposed by:** Q6, both quizzes.
Retried work is a fact of life in any system with queues, webhooks, or at-least-once delivery (which is most real systems) — the pattern of "make the *write itself* safe to repeat" rather than relying on an application-level guard alone is a core, transferable resilience technique, and the specific failure mode it prevents (a correct write getting reported as a spurious failure) is exactly the kind of bug that's brutal to reproduce in production and easy to prevent at design time.

### 4. Distinguishing genuine (retryable) errors from deterministic (non-retryable) outcomes
**Search:** "retryable vs non-retryable errors", "when not to retry a failed job", "error classification in distributed systems"
**Exposed by:** Q5 and Q7, both quizzes.
A huge fraction of "why does this job keep retrying forever and burning resources" incidents in real systems trace back to not having made this distinction on purpose. Treating every failure as equally retry-worthy is a default that quietly costs money and time (three wasted attempts on a file that will *never* succeed) the moment real traffic hits a system that does any kind of processing pipeline — chunking, embeddings, and payment webhooks in this very project will all face the identical design question again.

### 5. Content-quality heuristics and where to set their thresholds deliberately
**Search:** "text quality heuristic extraction", "handling malformed extracted text", "OCR confidence threshold"
**Exposed by:** Q3 and Q10, both quizzes.
"Did this succeed" is rarely a clean boolean in any pipeline that touches real-world, messy input (parsing, OCR, ML inference, user-submitted data) — recognizing when a problem is actually "pick a defensible threshold and monitor it" rather than "find the one correct answer" is a mindset shift that saves enormous wasted effort chasing false precision.

### 6. Security surface introduced by parsing (decompression bombs, XML entity expansion)
**Search:** "zip bomb protection", "XML entity expansion attack XXE billion laughs", "safe file parsing untrusted input"
**Exposed by:** Q8, both quizzes.
File-upload validation (MIME/magic-byte checks) and file-*parsing* safety are two genuinely separate security surfaces — a file passing the first tells you nothing about the second. Any system that accepts user-uploaded documents, images, or archives and then actually opens/parses them needs both, and conflating them is a common, real vulnerability class.

### 7. Isolating whether a failing test reflects a real bug or a test-environment artifact
**Search:** "jest module resolution issues", "flaky test root cause analysis", "test environment vs production parity"
**Exposed by:** Q9, this phase's live debugging session.
The instinct to keep "fixing" application code until a red test goes green, without first confirming the code is actually wrong (versus the *test's own environment* behaving differently from production), is a trap that wastes huge amounts of time and can introduce real workarounds for imaginary problems. The discipline demonstrated in this phase's own debugging — testing the identical code path both inside and outside the suspect environment before touching application code — is the transferable skill, independent of the specific (and genuinely obscure) Jest/BullMQ interaction that triggered it here.

---

## Interview questions this phase generates

- "Walk me through why a PDF can be perfectly valid and still have no extractable text." (Q1)
- "You're building a document-processing pipeline. A job fails halfway through — how do you decide whether it should retry or fail permanently?" (Q5/Q7)
- "What's the difference between an upsert and an insert-then-update, and when does that difference actually matter?" (Q6)
- "Where would you store job progress in a queue-based system, and would it survive a Redis restart?" (Q4)
- "A test fails in CI but the code works fine when you run it manually. How do you figure out whether the test or the code is wrong?" (Q9)
- "What security risks exist specifically in *parsing* a file, that validating its type/magic bytes doesn't catch?" (Q8)

---

## What's still not understood

Per the closing quiz and the explicit choice to move on without answering the re-ask: **the large majority of this phase's core concepts remain at UNKNOWN**, most notably where BullMQ job state lives and why (Q4, unmoved across three exposures), the retryable-vs-deterministic error distinction (Q5/Q7), and the upsert-based idempotency mechanism this phase's own code actually implements (Q6). This is carried forward openly rather than assumed resolved — see "Topics to master" above and the re-ask status note in the closing quiz section. Phase 6 (chunking) doesn't structurally depend on these gaps closing first, but Phase 7 (embeddings, real API cost per call) and Phase 12 (real-time progress) both will — worth a deliberate re-check at whichever comes first.