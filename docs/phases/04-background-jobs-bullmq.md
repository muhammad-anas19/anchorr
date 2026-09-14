# Phase 4 — Background Jobs with BullMQ

## Objective

Get a trivial job flowing through a real queue — enqueue on upload, pick it up in a separate worker process, mark the document processed — before any real processing logic (parsing, chunking, embedding) exists. Introduces Redis-backed job queues, the producer/worker split, retries with backoff, and idempotent handler design.

## Why the system needs this

Real document processing (Phases 5-7: parsing a PDF, chunking it, generating embeddings) can take anywhere from a fraction of a second to tens of seconds per document, and none of it should happen inside the HTTP request/response cycle that Phase 3's upload endpoint runs — a slow or failing third-party call (or just a large file) would otherwise make the client wait, risk a timeout, and tie up a server thread for no good reason. A job queue decouples "accept the upload and respond immediately" from "actually do the work," and this phase builds that plumbing with a deliberately trivial job (nothing more than flipping a status) so the mechanism itself — not the processing logic — is what gets understood first.

---

## The diagnostic

10 questions asked up front, answered in one batch, scored honestly.

### Q1 — Why not process synchronously in the request
**Asked:** If we processed a document synchronously inside the upload HTTP handler, what problem would that actually cause for the client?
**Answer:** "so client/jser as to keep seenign loading for a longer time till we stop finishing all the parts due to which user will get frustrated instead we will put the doc in queue and tell user the stauts"
**Score: SOLID.** Correct core reasoning — the client is stuck waiting for work that has nothing to do with "was the upload received," and the fix is exactly what this phase builds: enqueue and respond immediately, let status convey progress separately.

### Q2 — Job / queue / worker mental model
**Asked:** What are the three core pieces, and how do they relate — who creates a job, who's watching for it, where does its data live while waiting?
**Answer:** "job is the task, queue is datastructure in whihc we store docs, worker are the funtions that process on that doc, so producer craetes a job and push it into queue than it gives it to the wroker who work on it."
**Score: SOLID.** Precise and correct: a job is a unit of work with data attached, a queue holds jobs (not "docs" literally, but the intent — the data a job needs — is right), a worker is the process/function that picks up and executes jobs, and the producer→queue→worker flow is exactly right.

### Q3 — What Redis actually needs to provide
**Asked:** What Redis data structures/capabilities does a queue actually need at minimum (ordering, tracking what's been taken)?
**Answer:** "so redis store that jobs in queue and process them one by one and if any req fails we have dead later queue mechnisim in whihc we reprocess the job till fixed number of times."
**Score: SHAKY.** This describes retry/dead-letter behavior (a real, related concept) but doesn't address what was actually asked — the underlying Redis mechanism that makes a queue safe to use from multiple workers at once. BullMQ stores jobs using Redis **Lists** (for the waiting/active queues) and **sorted sets** (for delayed or prioritized jobs), and critically relies on Redis's **atomic** operations (a `BRPOPLPUSH`/`LMOVE`-style move-with-pop) so that when a worker takes a job off the queue, it's removed from "waiting" and placed into "active" as one indivisible step — no other worker can simultaneously grab the same job. Ordering and atomic hand-off are the two properties a queue structurally needs; retries and dead-letter handling are policies built on top of that foundation, not the foundation itself.

### Q4 — At-least-once vs exactly-once
**Asked:** What's the actual difference, and why is exactly-once so hard to guarantee?
**Answer:** "exactly once is like if queue passed the jb to the worker now it does'nt mater if it is successfully executed or not while atleast once means we will keep trach of job till it does not process perfectly."
**Score: UNKNOWN.** These definitions are swapped/confused. **At-least-once** means the system guarantees a job *will* be processed — but it might be processed **more than once** (e.g., a worker starts a job, crashes before confirming completion, and the job gets redelivered to another worker even though the first attempt might have partially succeeded). **Exactly-once** means a job runs precisely one time, never zero, never two — and this is genuinely hard because it requires atomically coordinating two separate things that usually can't be made atomic together: "mark this job as done" (in the queue system) and "the actual side effect of doing it" (e.g., writing a row to Postgres, calling an external API). Without special patterns (transactional outboxes, idempotency keys checked *inside* the same transaction as the side effect), a crash between those two steps either loses the completion signal (job re-runs — this is what at-least-once falls back to) or loses the side effect (job is marked done but never actually happened). What you described — "doesn't matter if it's successfully executed" — is closer to **at-most-once** (fire and forget, no guaranteed delivery at all), a third, different guarantee neither of you named.

### Q5 — Idempotency and why at-least-once requires it
**Answer:** "dont know"
**Score: UNKNOWN.** Directly follows from Q4: since at-least-once delivery means a job *can* run more than once, a handler is **idempotent** if running it twice (or ten times) with the same input produces the same end result as running it once — no duplicated side effects. Concretely for this phase's trivial job: setting `document.status = 'ready'` is naturally idempotent (setting the same value twice changes nothing extra); something like "increment a counter" or "send a welcome email" would *not* be idempotent without extra guard logic, because running it twice visibly does something different than running it once. Idempotency is the property that makes at-least-once delivery *safe* to build on — without it, every redelivery becomes a real bug.

### Q6 — Backoff on retry
**Answer:** "already explain above but we keep some gap between retrying becuase if failure is due to any third party sercvice we are using in worker if that service is down than if we try instantly after failure we will again get and error so we keep some exponential gap between retries"
**Score: SOLID.** Correct reasoning and correctly identifies exponential growth — retrying instantly against a struggling dependency just adds load to something already failing; spacing retries out (and growing that spacing each time) gives the dependency room to recover instead of getting hammered repeatedly.

### Q7 — Worker process crash mid-job
**Answer:** "retried."
**Score: SHAKY.** Right end result, no mechanism. The way BullMQ actually detects this: an active worker periodically renews a **lock** on the job it's processing (a heartbeat, roughly). If the worker process dies, it stops renewing that lock; once the lock expires without renewal, BullMQ recognizes the job as **stalled** and makes it available for another worker to pick up and retry (up to a configurable maximum number of stall-recoveries, since a job that keeps stalling every time might indicate the job itself is the problem, not just bad luck). "Retried" is the outcome; "the lock stopped being renewed and expired" is the actual mechanism worth knowing.

### Q8 — Worker concurrency
**Answer:** "1"
**Score: UNKNOWN.** "1" happens to be BullMQ's actual default, but the question also asked *what setting controls it* and *what the tradeoff is* — neither was addressed, so this reads as a guess rather than knowledge. The setting is the `concurrency` option passed to a `Worker`, controlling how many jobs that single worker process will run **at the same time** (interleaved via Node's event loop, not true parallel threads, unless the job itself offloads CPU-heavy work). Higher concurrency means more throughput and better utilization of time spent waiting on I/O (a network call, a database query) — but also more simultaneous load on whatever the job calls out to (a database, an external API, memory usage from having many jobs' data in flight at once). Lower concurrency is safer and more predictable but slower to drain a large backlog.

### Q9 — Does enqueuing block the HTTP response
**Answer:** "dont know"
**Score: UNKNOWN.** Enqueuing a job (writing it into Redis) is fast and is `await`ed as a normal part of the request — but the *processing* of that job happens entirely separately, in the worker process, on its own schedule. The HTTP response goes out as soon as the job has been successfully placed on the queue, **before** any actual processing has started, let alone finished. This is precisely why the response can't say "your document is ready" — at the moment of responding, processing hasn't necessarily even begun. The client sees the upload succeed (with `status: 'uploaded'`) and has to check back (poll, or later phases might push updates) to learn when it's actually `ready`.

### Q10 — Status transitions and what that implies about handler assumptions
**Answer:** "when we put job in queue it will amrk as uploaded, in worker procesing, after that ready or failed absed on result"
**Score: SHAKY.** The transitions themselves are exactly right (`uploaded` → `processing` → `ready`/`failed`). What wasn't addressed is the second half of the question: *because* at-least-once delivery means this same job could run more than once, a handler can never safely assume "I am the first and only execution of this job" just because it's starting. If a job's handler blindly does `status = 'processing'` then does its work then sets `status = 'ready'` with no check of the document's *current* state first, a redelivered job could, for example, re-process (or worse, re-append side effects to) a document that a previous attempt already finished — a handler needs to check where a document actually is before assuming where it should be going next. This is the concrete, project-specific version of idempotency from Q5.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for this phase's build:

1. **At-least-once vs exactly-once vs at-most-once, correctly** (Q4) — these got swapped, and this is the single most foundational fact this phase rests on; everything else (idempotency, safe status transitions) follows from getting this right.
2. **Idempotency, concretely** (Q5, and the deeper half of Q10) — not an abstract property, a specific design requirement: every job handler in this codebase must tolerate being run more than once on the same input without corrupting anything.
3. **The stalled-job/lock mechanism for detecting a dead worker** (Q7) — "it gets retried" is the visible symptom; the lock-heartbeat-expiry mechanism is what's actually worth being able to explain.
4. **What Redis structurally provides a queue (atomic take, ordering)** (Q3) — distinct from the retry/backoff *policies* built on top of it, which were already understood well.
5. **Worker concurrency as a named, tunable setting with a real tradeoff** (Q8) — not just "it's 1," but *why* you'd change it and what you trade away either direction.
6. **Enqueue-then-respond as a specific request lifecycle** (Q9) — the HTTP response and the actual job completion are on two entirely separate timelines, and the client-visible consequence of that (status has to be polled/pushed, not returned inline) is exactly why Phase 3's `status` enum exists in the first place.

---

## Architecture & decisions (as built)

```
DocumentsService.upload()              document-processing queue (Redis)         DocumentProcessingProcessor
  │ create Document row (status: uploaded)         │                                        │
  ├──────────────────────────────────────────────►│ job: { documentId }                    │
  │                                                 │ attempts: 3, exponential backoff        │
  │ ◄─ HTTP response returns HERE ──────────────────┤                                         │
  │    (status still 'uploaded')                    │                                          │
  │                                                 ├─────────────────────────────────────────►│ re-fetch document
  │                                                 │                                          │ if already ready/failed: no-op (idempotent)
  │                                                 │                                          │ else: status → 'processing'
  │                                                 │                                          │ (trivial "work")
  │                                                 │                                          │ status → 'ready'
  │                                                 │           (on exhausted retries) ◄────────┤ @OnWorkerEvent('failed')
  │                                                 │                                          │ status → 'failed', failureReason set
```

- **`@nestjs/bullmq`**, matching the pattern of every other library wrapper in this project (`@nestjs/jwt`, `@nestjs/passport`). `src/queue/queue.module.ts` holds only the shared Redis connection config (same tier as `database/`/`redis/` — infrastructure, not a feature); the actual queue registration and its processor live inside `modules/documents/processing/`, since the job belongs to the feature that owns it.
- **The idempotency guard is the first thing the processor does**, before any side effect: re-fetch the document, and if it's already in a terminal state (`ready`/`failed`), do nothing. This is the concrete answer to Q5/Q10 — it's what makes at-least-once delivery (a redelivered job, a retried job, anything running this handler more than once) safe rather than dangerous.
- **`attempts: 3` with exponential backoff (`{ type: 'exponential', delay: 1000 }`)** on every enqueued job. On final failure, `@OnWorkerEvent('failed')` checks `job.attemptsMade` against `job.opts.attempts` — only on the *last* attempt does it write `status: 'failed'` to the document; intermediate failures (attempts 1 and 2, which BullMQ will still retry) are left alone.
- **Concurrency explicitly set to 5** (`@Processor(..., { concurrency: 5 })`), not left at BullMQ's silent default of 1 — named and chosen on purpose, per Q8.
- **Worker runs in the same Node process as the API**, registered as an ordinary Nest provider (`DocumentProcessingProcessor` in `DocumentsModule`'s `providers`). This is a deliberate simplification, not an oversight: a real production deployment might split API and worker into separate processes (so heavy processing can never starve API responsiveness) — worth revisiting once real parsing/embedding work (Phases 5-7) actually has meaningful CPU/latency cost, which the current trivial job doesn't.
- **No schema change this phase** — the `status` enum and `failure_reason` column already existed from Phase 3, built in advance for exactly this moment (the payoff of that earlier "topics you must know" lesson).

## Data flow: from upload to `ready` (or `failed`)

1. `DocumentsService.upload()` (Phase 3, unchanged apart from one addition) saves the `Document` row with `status: 'uploaded'`, then calls `processingQueue.add('process', { documentId }, { attempts: 3, backoff: {...} })`.
2. That `add()` call is `await`ed — but it only waits for the job to be written into Redis, not for it to run. The HTTP response goes out immediately after, carrying `status: 'uploaded'`.
3. Independently, `DocumentProcessingProcessor.process()` picks the job up (on its own schedule, governed by Redis and BullMQ's polling/blocking mechanism) and runs the idempotency-guarded logic described above.
4. If `process()` throws, BullMQ catches it, and the `@OnWorkerEvent('failed')` handler fires. If retries remain, nothing else happens (BullMQ will redeliver the job after the backoff delay); if this was the last attempt, `status` becomes `failed` and `failureReason` is recorded.

## Code walkthrough

**`src/queue/queue.module.ts`** — `BullModule.forRootAsync(...)`, reading `REDIS_HOST`/`REDIS_PORT` the same way every other Redis-touching config in this project does (Phase 2's rate limiter, Phase 2's `RedisModule`). Exported so any feature module can register its own queues against this shared connection.

**`src/modules/documents/processing/document-processing.constants.ts`** — just the queue name string and the job-data shape (`{ documentId: number }`), kept in one tiny file so both the producer (`DocumentsService`) and the consumer (`DocumentProcessingProcessor`) import the exact same constant rather than risking a typo'd queue name silently creating two different queues.

**`src/modules/documents/processing/document-processing.processor.ts`** — the whole job, in order: re-fetch → idempotency check → `processing` → (trivial work) → `ready`. The `throwForTesting` flag on job data is a deliberate test-only escape hatch, checked only inside the processor — production code (`DocumentsService.upload()`) never sets it, so there's no way for a real client request to trigger it.

**`src/modules/documents/documents.module.ts`** — registers the queue (`BullModule.registerQueue({ name: DOCUMENT_PROCESSING_QUEUE })`) and the processor as a provider, alongside everything Phase 3 already had.

**`src/modules/documents/documents.service.ts`** — `upload()` gained exactly one new step: enqueueing, after the row is successfully saved (and, notably, *not* inside the same try/catch that handles the unique-violation race from Phase 3 — enqueueing only happens once we're certain the document was actually created).

## Failure cases (tested for real, not hypothetical)

1. **Normal processing.** A job for a freshly-uploaded document runs to completion, flipping `uploaded → processing → ready`, observed via polling.
2. **Forced failure through full retry exhaustion.** A job deliberately configured to always throw, with `attempts: 3` and a short exponential backoff, was watched through all three attempts failing and the document landing on `status: 'failed'` with `failureReason` populated — not just asserting the final state, but confirming the retry mechanism itself ran (via the timing: the test only passes if the backoff delays actually elapsed).
3. **Idempotent redelivery.** A job was enqueued for a document *already* in `status: 'ready'` — simulating what an at-least-once redelivery of an already-successful job looks like from the processor's point of view. Confirmed the processor's guard fired: no error, no re-processing, `status` and `failureReason` both unchanged.
4. **A real, live worker crash and stall recovery — not simulated in the automated suite, demonstrated directly.** Two standalone BullMQ workers were started against a scratch queue (`stall-demo`, short `lockDuration`/`stalledInterval` so the wait was seconds, not BullMQ's 30s default). Worker A picked up a job and then hung forever (simulating a crashed/frozen process — never resolving, never renewing its lock). Its OS process was then force-killed mid-job. Worker B, started fresh against the same queue, initially did nothing until the lock's TTL expired — at which point BullMQ's stall detection recognized the job's lock hadn't been renewed, marked it stalled, and handed it to Worker B, which completed it normally. Real log output:
   ```
   [worker-a] active: job 1
   [worker-a] started job 1, now hanging forever (simulated crash)...
   (worker-a process force-killed here)
   [worker-b] listening
   [worker-b] active: job 1
   [worker-b] picked up job 1 (attempt 1) — completing normally.
   [worker-b] COMPLETED job 1
   ```
   This is the actual mechanism behind Q7's "it gets retried" — not a black box, a lock with a TTL that something else notices has gone stale.

## Tests and why each exists

- **`test/document-processing.e2e.spec.ts`** (e2e, real Redis + real Postgres) — the three automated cases above: success path, failure/retry/exhaustion path, idempotent redelivery. Uses a `waitUntil` polling helper throughout, because — as this entire phase is about — job completion is never synchronous with the call that enqueued it; a test that asserted immediately after `queue.add()` would be testing nothing.
- **The stall-recovery demonstration is deliberately *not* a permanent automated test** — it requires killing a real OS process mid-job and waiting out real lock-expiry timers, which makes it slow and inherently more fragile than this project's other tests. It's documented here as a one-time, directly-observed exercise instead, consistent with treating some "break it deliberately" steps as things to witness and understand rather than things to keep re-running in CI forever.

## Reverse-engineering guide — if you open this in six months

1. Start at `src/modules/documents/processing/document-processing.processor.ts` — the entire job lifecycle is one file, short enough to read in full.
2. If jobs never seem to run, check `docker compose ps` for Redis first (this project's Redis lives in Docker on a non-default port, `6380` — see `docs/SETUP.md`) before suspecting the queue code itself.
3. If a status seems "stuck" on `processing`, that document's job likely stalled — check for a crashed/restarted worker process around that time, and see Failure Case #4 for the actual mechanism (not a bug, a lock TTL working as designed, possibly just slower than expected if `lockDuration`/`stalledInterval` are left at BullMQ's 30s defaults, which this project's real queue does — the demo used shortened values purely to make the wait observable).
4. Run `npm test` inside `Backend/` — 8 suites, 32 tests as of this phase, including the retry/backoff/exhaustion path against real timers (expect these specific tests to take several real seconds, not milliseconds).

---

## Closing quiz

10 questions, batched, scored honestly. 2 SOLID / 3 SHAKY / 5 UNKNOWN. One result worth sitting with rather than glossing over: the stall-detection mechanism (Q3) came back "don't know" immediately after watching it happen live, with real log output, minutes earlier — a sharp reminder that watching something work and being able to explain it are genuinely different, a pattern this project keeps surfacing phase after phase.

### C1 — At-least-once vs exactly-once, revisited
**Answer:** "so exactly once means a job will be idempotent and will run only one time whihc atleast once means it can be run more than one time but atleast one must, bullmq give us atleast once but we can also make it exactly once too but it require changes in code"
**Score: SOLID.** This is real, corrected understanding, and the last clause is the sharpest part of the answer: BullMQ genuinely only gives at-least-once delivery at the transport level — but combining that with an idempotent handler (exactly what this phase built) produces an *effectively* exactly-once **outcome**, without the queue itself ever needing to make that guarantee. That's a subtle, accurate point, and a real correction from the original diagnostic's swapped definitions.

### C2 — Idempotency mechanism, pointing to the actual code
**Answer:** "it means that req will be only run once and it contains idempotent key if second req comes with same key it will not be executed."
**Score: SHAKY.** Describes a real, valid *pattern* for achieving idempotency (an idempotency key, the way Stripe's API works) — but that's not what this codebase actually does, and the question specifically asked to point at the real mechanism in `DocumentProcessingProcessor`. Our idempotency guard isn't a key at all — it's a **status check**: `if (document.status === READY || document.status === FAILED) return;`, right at the top of `process()`, before any side effect. No key, no deduplication table — just checking where the document already is before deciding what to do next.

### C3 — The stall mechanism, right after watching it happen
**Answer:** "dont know"
**Score: UNKNOWN — worth teaching once more, plainly, since the live demo didn't land it.** A worker holding an active job periodically renews a **lock** on it — think of the lock as a timestamped claim: "I'm still alive and working on this, don't give it to anyone else." As long as the worker keeps renewing that claim before it expires, nothing else can touch the job. In the demo, Worker A picked up the job and then hung forever (`await new Promise(() => {})` — never resolving, so the code that would renew the lock never got a chance to run again). When its process was force-killed, there was nothing left to renew anything. Every worker on that queue (Worker B, once started) periodically checks for jobs whose lock has gone past its expiry with no renewal — when it finds one, it treats the job as **stalled**, and makes it available to be picked up again, which Worker B then did. Nothing detected "the process died" directly — Redis has no way to know that. What actually happened is purely: *a claim expired, and nobody renewed it in time.*

### C4 — What actually governs the stall-recovery delay (confused with retry backoff)
**Answer:** "we define the exponential delay, and it is not instant becuase if failure is due to any third party sercvice we are using in worker if that service is down than if we try instantly after failure we will again get and error so we keep some exponential gap between retries"
**Score: UNKNOWN.** This answers a *different* question — it's a correct description of retry backoff (Q6 from the opening diagnostic), which governs the delay between a job **throwing** and being retried. It has nothing to do with the delay in the stall demo, which was governed by two entirely separate settings: `lockDuration` (how long a claim lasts before it's considered expired) and `stalledInterval` (how often any worker checks for jobs whose claim has expired). We set both to 2000ms specifically to make the demo's wait observable in seconds rather than BullMQ's 30-second defaults. These are two unrelated knobs solving two unrelated problems — one for "my handler threw, try again later," the other for "the worker holding this job seems to have vanished."

### C5 — `concurrency: 5` given a single-threaded runtime
**Answer:** "so we can run 5 worker concurrently and since nodejs is single threaded so to achieve concurrency we use eventloop mechanism"
**Score: SHAKY.** The underlying mechanism is right — Node's event loop interleaves I/O-bound async work (our job handler mostly `await`s database calls) without needing real parallel threads. Worth being precise about the terminology though: this is **one Worker instance processing up to 5 jobs concurrently**, not "5 workers." That distinction matters — if someone later asks "how many workers do you have running," the honest answer is one process, one `Worker` object, with room for 5 jobs in flight inside it at once.

### C6 — Enqueue after save, not before or in parallel
**Answer:** "becuase if we save it after enqueuen and than save operation fails we will not have track of the docuement and thta will break consistency"
**Score: SOLID.** Exactly right — enqueuing before the document exists (or racing the two) risks a job referencing a `documentId` that never actually got created, an orphaned reference to nothing. Saving first guarantees the job's data is always valid by the time anything tries to act on it.

### C7 — Why check `attemptsMade` before marking failed
**Answer:** "dont know"
**Score: UNKNOWN.** Without that check, the *very first* failed attempt — with two more retries still scheduled — would immediately flip the document to `'failed'`, even though the job might go on to succeed on attempt 2 or 3. The document would show as permanently failed to a customer while BullMQ was still quietly retrying behind the scenes, and if a later attempt *did* succeed, the status would flip back to `'ready'` out from under the premature failure — a confusing, flickering state that misrepresents what's actually happening. The check ensures `'failed'` is only ever written once every real chance to succeed has been exhausted.

### C8 — The Redis operation preventing double-pickup
**Answer:** "dont know"
**Score: UNKNOWN.** Same gap as the opening diagnostic's Q3. The short answer: an atomic "move and return" operation (conceptually like Redis's `BRPOPLPUSH`/`LMOVE`) that removes a job from the waiting list and places it on the active list as one indivisible step. Two workers racing to grab the same job can't both succeed, because the operation that removes-and-claims never runs "halfway" — Redis either completes it entirely for one caller or the other, never both.

### C9 — What changes (and doesn't) when Phase 5 replaces the placeholder
**Answer:** "we just have to update service nothing elese remian enqueng and retrying mechanism will remina same"
**Score: SHAKY.** The core insight is exactly right and is the whole point of this phase's design: the enqueue/retry/idempotency plumbing doesn't need to change at all when real parsing logic arrives. What's misplaced is *where* that change happens — it's not `DocumentsService` (which only enqueues and has nothing to do with what happens during processing), it's **`DocumentProcessingProcessor.process()`** — the trivial placeholder logic between "status → processing" and "status → ready" is exactly the block Phase 5 will replace with real parsing. Small correction, but worth being precise about which file actually owns that responsibility.

### C10 — End-to-end customer experience if processing always fails
**Answer:** "dont know"
**Score: UNKNOWN.** Worth walking through once, since it ties every piece of this phase together: the upload still succeeds immediately (`201`, `status: 'uploaded'`) — nothing about accepting the file depends on whether processing will later work. The job runs, throws, retries twice more with backoff, and on the third failure `@OnWorkerEvent('failed')` sets `status: 'failed'` with a `failureReason`. The customer sees the document sitting in a permanently failed state in the Knowledge screen — matching the prototype's own "1 document failed processing" banner — with no crash, no 500 anywhere in the stack, just an honestly-reported failure. This is the payoff of decoupling upload from processing: a systematic bug in parsing logic degrades gracefully into "documents fail with a reason," not into broken uploads or hung requests.

---

## Topics to master — not just for Anchor, for being a genuinely strong engineer

Combining both quizzes for this phase.

### 1. Distinguishing separate timing mechanisms that "look similar" (retry backoff vs. stall detection)
**Search:** "BullMQ lockDuration vs backoff", "job queue stalled job detection", "retry backoff vs heartbeat timeout"
**Exposed by:** closing C4 (UNKNOWN — retry-backoff reasoning applied to a stall-detection question). This is the single most important correction from this phase: two mechanisms that both involve "waiting before something happens" are not the same mechanism just because they rhyme. Retry backoff answers "my handler threw — how long before trying again?" Stall detection answers "the worker holding this job seems to have vanished — how would anything ever notice?" Conflating timing-related settings that solve different problems is an easy, recurring trap in any system with multiple independent timeout/retry knobs (HTTP timeouts, TCP keepalives, cache TTLs, lock leases) — the general habit worth having: before reasoning about *any* timing setting, name specifically what condition it's protecting against.

### 2. Distributed locks with expiry (leases), as a general pattern
**Search:** "distributed lock with TTL", "lease-based locking", "heartbeat renewal pattern"
**Exposed by:** closing C3 (UNKNOWN, even right after a live demonstration). BullMQ's job lock is one instance of an extremely common distributed-systems pattern: a "lease" — a claim on a resource that automatically expires unless actively renewed, so that a crashed holder can never permanently block anyone else from ever recovering that resource. The same shape shows up in distributed locks (Redis `SETNX` with a TTL), Kubernetes leader election, DNS record leases, and countless "who currently owns this" problems. The core insight worth having cold: **nothing detects that a process died — expiry is what stands in for that, because processes dying without notice is exactly the failure mode you can't reliably detect any other way.**

### 3. Idempotency as "check before acting," not just "don't repeat"
**Search:** "idempotent job handler pattern", "idempotency key vs status check", "safe to retry design"
**Exposed by:** opening Q5 (UNKNOWN) and closing C2 (SHAKY — named a valid but different pattern than what's actually in the codebase). Idempotency key deduplication (Stripe-style) and "check current state before proceeding" (this project's approach) are two different implementations of the same underlying property. Worth being able to name both, and to recognize that the *simplest* idempotency mechanism is often just reading the current state of the thing you're about to change before changing it — no separate deduplication infrastructure required.

### 4. Precise vocabulary: "N workers" vs "one worker at concurrency N"
**Search:** "BullMQ worker concurrency option", "node.js event loop concurrency vs parallelism"
**Exposed by:** closing C5 (SHAKY) — a small but real terminology slip with practical consequences (operational questions like "how many worker processes do we have running" get answered incorrectly if the words are conflated). Precise vocabulary here isn't pedantry — "5 workers" implies 5 separate processes/instances to someone reading logs or monitoring dashboards, when the reality is one process with headroom for 5 concurrent in-flight jobs.

### 5. Synthesizing a full request/failure lifecycle across multiple pieces already built
**Search:** "trace a request through a distributed system", "failure mode analysis end to end"
**Exposed by:** closing C10 (UNKNOWN). Every individual piece this phase built (enqueue-then-respond, retries, idempotency, exhaustion-triggered failure) was understood well enough in isolation to build and test — but asked to narrate the *combination* end-to-end, from a customer's perspective, that synthesis didn't come automatically. This is worth deliberately practicing: after building several interacting pieces, periodically stop and narrate the whole path a request or a failure takes through all of them, out loud, without looking at the code.

## Interview questions this phase generates

- "You have two BullMQ settings that both involve waiting: backoff and stalledInterval/lockDuration. Explain what each actually protects against, and why mixing them up would matter in production." (Topic #1, directly — this phase's sharpest miss.)
- "Explain a lease/lock-with-expiry pattern you've seen or built, and why 'detecting that something died' is usually impossible to do directly." (Topic #2.)
- "Design two different ways to make an operation idempotent. When would you reach for one over the other?" (Topic #3.)
- "A teammate says 'we're running 10 workers' but you suspect they mean one worker at concurrency 10. Why does the distinction actually matter operationally?" (Topic #4.)
- "Walk me through, in order, everything that happens — success and failure paths both — from the moment a client uploads a file to the moment it's either ready or permanently failed." (Topic #5 — this phase now has a complete, real system to narrate instead of a hypothetical.)

## What I still don't understand

Carried forward, not glossed over:

- **The stall/lease mechanism (topics #1, #2)** — taught via a live, hands-on demonstration with real captured log output, and still didn't transfer into an explanation minutes later. This is the strongest signal yet in this project that *watching* something work is not the same skill as *explaining* it — worth deliberately re-approaching next time by having the explanation come first, then the demo, rather than the reverse order used this time.
- **The Redis atomic move-and-claim operation (topic in the opening diagnostic's Q3, still open)** — unresolved across both quizzes this phase; worth a concrete, hands-on pass (e.g., actually running the underlying Redis commands by hand against the dev Redis instance) rather than another verbal explanation.
- **Full-system narration under a hypothetical failure (topic #5)** — the individual pieces are each reasonably understood; the combination isn't automatic yet. Worth deliberately practicing this specific skill (narrating a whole request path from memory) before Phase 5 adds another layer to narrate.
