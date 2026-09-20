# Phase 10 — Confidence Scoring, Refusal & Escalation State Machine

## Objective

Right now (end of Phase 9), *every* question gets an attempt at an answer, and Anchor decides between exactly two outcomes: found something and answered it, or found literally nothing and refused. This phase adds a third, more honest possibility — **escalate to a human** — and makes the decision between all three based on an actual, measured confidence signal rather than "did retrieval return zero rows or not." It also introduces the first *persistent* record of a customer conversation this project has ever had.

## Why the system needs this — explained in full, since this phase wasn't obvious

This section exists specifically because the purpose of this phase wasn't clear going in — worth being explicit about the whole shape of the problem before touching any code.

### The gap Phase 9 leaves open

Phase 9's design has exactly two outcomes:
1. Retrieval found **zero** chunks → refuse, say "I don't have information about that."
2. Retrieval found **any** chunks (even just one, even a mediocre match) → generate a confident-sounding, cited answer and hand it to the customer.

The problem is outcome 2's "any chunks" condition. Recall from Phase 8: `retrieveRelevantChunks` always returns up to `k` (default 5) results, **with no cutoff for how bad the closest match actually is**. If a customer asks something totally unrelated to anything in the documentation, retrieval doesn't return *nothing* — it returns the *5 least-bad* matches out of whatever exists, even if the "best" of those 5 is still a genuinely poor, barely-related match. Phase 9's current code would happily generate a fluent, well-formatted, cited answer from that weak material — and a fluent, cited answer *looks* just as trustworthy as a genuinely well-grounded one, even when the underlying match was bad. This is a real, structural gap: "an answer with citations" and "a *trustworthy* answer with citations" are not currently the same thing, and nothing in the system today tells them apart.

### The three real outcomes this phase introduces

1. **Confident answer** — retrieval found something genuinely close to the question. Generate and return the answer, exactly like Phase 9 already does.
2. **Refusal** — retrieval found nothing close enough to trust at all (which might mean zero results, *or* results that exist but are too weak to build an answer from). Tell the customer honestly that Anchor doesn't have this information — **never** generate an answer from weak material just because *some* rows came back.
3. **Escalation** — a genuinely new, third path. The situation isn't clearly "yes, confidently answerable" and isn't clearly "no, nothing relevant exists either" — it's ambiguous enough (or, later, a business might configure certain topics to *always* route this way) that the right move is neither a confident answer nor a flat refusal, but flagging the conversation for a real human to look at and respond to personally.

**Why escalation has to be a genuinely separate concept from refusal, not just "a stronger kind of refusal":** refusal means *"we're reasonably sure there's no answer here."* Escalation means *"we're not sure enough either way — a human should decide,"* which is a fundamentally different epistemic state, and matters practically too: a refused customer gets told "we don't have this," full stop; an escalated customer should ideally get told something like "let me get a person to help with this," and — critically — someone on the business side needs a way to actually *see* that this happened and follow up. Collapsing these into one category would either make Anchor too quick to give up (treating ambiguous-but-maybe-answerable questions as flat refusals) or too quick to bother a human (treating genuine "no information exists" cases as needing a person's attention).

### Why this needs a real state machine, not just a status field

A **state machine**, concretely, is: a fixed, named set of possible states a thing can be in, plus a fixed, explicit set of allowed transitions between those states — and critically, transitions *not* on that allowed list are impossible by construction, not just "shouldn't happen because the code is careful." For one customer conversation in Anchor, the real states this phase needs are something like: `answered`, `refused`, `escalated` — and (a real, deliberate scope boundary, see below) that's likely *all* this phase needs, even though more states (`claimed_by_agent`, `resolved`) will exist eventually.

Why not just a boolean flag or two (`isEscalated: boolean`, `isAnswered: boolean`)? Because booleans don't prevent nonsensical combinations — nothing stops `isAnswered: true` and `isEscalated: true` from both being set on the same row simultaneously, a state that shouldn't be reachable at all (a single customer turn was either answered, or refused, or escalated — never two of those at once). A single enum column with a constrained set of values makes the invalid combination structurally impossible to represent, not just something the application code has to remember never to create.

### Why persistence has to start existing now

Nothing about a customer's question or Anchor's answer has been saved anywhere, ever, in this project — Phase 9's `/ask` is completely stateless: one HTTP request in, one JSON response out, nothing written to any table. A state machine needs actual **state** — somewhere the current status genuinely lives, that can be read back later (by a future Phase 12 agent console, by a future Phase 17 evaluation run, by a business owner just wanting to see what their AI has been telling customers). This phase is where a real, persistent conversation record has to start existing, purely because "track which state this is in" is meaningless without something durable to track it *in*.

### The real, deliberate scope boundary against Phase 12

Phase 12 ("Agent console: human handoff") is explicitly a *separate*, *later* phase — its whole job is presence tracking and letting a real human agent claim and respond to an escalated conversation. **Phase 10 does not build any of that.** Phase 10's job ends at: detect that a conversation should be escalated, and record that fact durably (a real row, a real `escalated` status) so that *something* exists for Phase 12 to eventually build a UI around. Building agent-claiming, presence, or a human-response workflow now would be building ahead of what this phase's own objective calls for — directly against this project's standing "build only what the current phase needs" rule.

### Choosing the actual confidence signal

The two real candidates: (a) ask the LLM itself how confident it is, or (b) use Phase 8's retrieval distance. **(a) is unreliable and shouldn't be used**: an LLM generating a self-assessment of its own confidence is still just generating plausible-sounding text — it has no genuine introspective access to "how likely am I to be right," the same underlying reason Phase 9 established that ungrounded LLM output can't be trusted at face value. A model can say "I'm very confident" while being wrong, or hedge needlessly while being right — its stated confidence and its actual correctness aren't reliably correlated. **(b) is the real, load-bearing signal this phase should use**: retrieval distance is a mechanically-computed, objective geometric fact (Phase 7/8's cosine distance), not a subjective claim generated by a model — smaller distance genuinely means the retrieved content is closer, in a precise mathematical sense, to what the customer asked.

**Which distance value, though, when `k=5` results come back with different distances each?** Using the **single closest (minimum) distance**, not an average across all `k` results, is the more defensible default. Concretely: if the top chunk is a near-perfect match (distance 0.05) but the other four returned chunks are mediocre filler (distance 0.6+, returned only because `LIMIT k` always fills up to `k` rows regardless of quality), *averaging* all five would produce a misleadingly weak overall number — actively undermining confidence in a case where a genuinely excellent match exists. What actually matters for confidence is "does at least one retrieved chunk genuinely support an answer" — which the *minimum* distance answers directly, while an average gets diluted by however many mediocre also-rans happened to fill out the rest of `k`. (This isn't a universal law — a question that genuinely needs several chunks *together* to answer well might reasonably want a different aggregate — but as a starting default, minimum distance is the simpler, harder-to-accidentally-undermine choice.)

### Should the LLM's generated *answer text* also be scanned for hedging language ("might be," "I'm not sure")?

Deliberately, no — not in this phase's design. This would mean parsing free-form natural language for uncertainty cues, which is fragile in both directions: real hedge phrases can be missed (endless ways to phrase uncertainty), and words that merely *sound* uncertain can appear in a perfectly confident, correct answer for unrelated reasons (quoting a source's own hedged language, for instance). This is the same underlying lesson as ruling out LLM self-reported confidence (Q2's answer above) — a mechanically-computed number from retrieval is a far more reliable signal than trying to interpret the model's own words about its own certainty.

### Is multi-turn conversation context in scope here?

No — Phase 9's `/ask` is single-turn (no memory of prior questions feeding into retrieval or generation), and this phase doesn't change that. What *does* change: each turn now gets **persisted** as part of a growing conversation record, for future reference (a future agent picking up an escalated conversation, a future evaluation pass) — but the current turn's *own* answer generation still doesn't use earlier turns as context yet. "Now remembered" and "now used as context for follow-up understanding" are two different capabilities, and this phase only delivers the first one — worth being explicit about, since conflating them would overstate what's actually being built.

---

## The diagnostic

11 questions, answered in one batch. Scored honestly.

### Q1 — What's actually different about escalation vs. refusal?
**Answer:** "dont know"
**Score: UNKNOWN.** Fully covered above: refusal = confident there's no answer; escalation = genuinely unsure either way, a human should decide. Different epistemic states, different customer-facing messages, different downstream handling.

### Q2 — Why not just ask the LLM how confident it is?
**Answer:** "dont know"
**Score: UNKNOWN.** Covered above: an LLM's self-reported confidence is itself just generated text, with no reliable connection to actual correctness — the same underlying reason Phase 9 established that ungrounded output can't be trusted at face value.

### Q3 — How could Phase 8's distance value become a confidence signal?
**Answer:** "the more close the distance is we can consider more confident"

**Score: SOLID.** Exactly right — smaller cosine distance means a closer, more semantically similar match, which is the correct direction for a confidence signal to move in.

### Q4 — What's missing from retrieval's current design for confidence scoring to work at all?
**Answer:** "we can kept a threshold for confident indicator like threshold 0.10 if the distance is 0.10 or less we can amrk it as confident"

**Score: SOLID.** Correctly identifies the real missing piece — a threshold cutoff, not just "return whatever's closest." (The actual number, 0.10 vs. something else, is exactly the kind of thing this phase treats as tunable rather than fixed — see Q9's real answer.)

### Q5 — Closest chunk, average, or something else, and what breaks with each?
**Answer:** "based on avg"

**Score: SHAKY.** A real, considered choice, but the question specifically asked what breaks with each option, which wasn't addressed. Real answer, fully worked above: averaging risks diluting a genuinely strong single match with several mediocre also-rans that `LIMIT k` returns regardless of quality — the minimum (closest) distance is the more defensible default because it directly answers "does at least one genuinely relevant chunk exist," which is what confidence is actually trying to measure.

### Q6 — What is a state machine, concretely, for one Anchor conversation?
**Answer:** "dont know"
**Score: UNKNOWN.** Covered fully above: a fixed set of named states (`answered`/`refused`/`escalated` for this phase) plus a constrained way of assigning them, such that invalid combinations (e.g., both "answered" and "escalated" at once) are structurally impossible, not just avoided by convention.

### Q7 — Does anything about a conversation need to be persisted now?
**Answer:** "yes we keep question and anser save in db so hat we can evaluate"

**Score: SOLID.** Correct — and the evaluation-focused reasoning is real and relevant (a direct line to Phase 17). The state-machine reasoning is an equally real, additional justification: persistence isn't only for future evaluation, it's structurally required for a state to exist and be tracked at all.

### Q8 — Given Phase 12 already exists as a separate future phase, what should Phase 10 actually be responsible for?
**Answer:** "dont know"
**Score: UNKNOWN.** Covered above: detect and record the escalation decision (a real `escalated` status on a real, persisted row) — nothing about an agent-facing UI, claiming, or presence, which is entirely Phase 12's job.

### Q9 — Should the confidence threshold be a fixed number picked once?
**Answer:** "dont knwo"
**Score: UNKNOWN.** No — it should be a configurable value, deliberately treated as an empirical starting guess rather than a permanently "correct" number, the same way Phase 6's chunk size/overlap and Phase 8's `k` were treated. What would actually decide whether it's right: real observed outcomes once there's a way to measure them — exactly Phase 17's (Evaluations) reason for existing. Picking a threshold now is a reasonable starting point, not a settled fact.

### Q10 — Should the LLM's answer text also be scanned for hedging language?
**Answer:** "dont know"
**Score: UNKNOWN.** No, deliberately — covered fully above: parsing free-form text for uncertainty cues is fragile in both directions, and retrieval distance is a far more reliable, mechanically-computed alternative already available.

### Q11 — Is multi-turn context in scope for this phase?
**Answer:** "dont know"
**Score: UNKNOWN.** No — covered above: this phase persists each turn (for future reference) without yet using prior turns as context for the *current* turn's own retrieval or generation. "Remembered" and "used as context" are different capabilities; only the first is this phase's job.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for this phase's actual build:

1. **A mechanically-computed signal (retrieval distance) beats a self-reported one (LLM confidence) for anything safety-critical** (Q2) — the single idea this whole phase is built on; get this backwards and the entire confidence system rests on the exact kind of unreliable self-assessment it exists to avoid.
2. **Escalation as a distinct epistemic state from refusal, not a "worse" refusal** (Q1) — shapes both the state machine's design and what the customer actually sees.
3. **A state machine's real guarantee is making invalid combinations unrepresentable, not just unlikely** (Q6) — the difference between a genuinely enforced constraint and a convention that's one bug away from being violated.
4. **Minimum (not average) distance as the more defensible confidence aggregate, and why** (Q5) — a concrete instance of a broader pattern: an aggregate that dilutes your best signal with mediocre noise can make a system *less* confident exactly when it should be more.
5. **Scope discipline against a phase that hasn't happened yet** (Q8) — a recurring, transferable skill this project keeps re-testing: building exactly what's needed now, trusting a documented future phase to handle what it's explicitly responsible for.
6. **Persistence as a prerequisite for state, not an optional nice-to-have** (Q7) — "track a status over time" is meaningless without something durable to hold that status in the first place.

---

## Architecture & decisions

Design proposed after the diagnostic, agreed to as-is:

**1. A new `Conversation` entity — single-turn shaped, deliberately not split into `Conversation`+`Message` yet.** Named `Conversation` (not something narrower like `AnswerLog`) because PHASES.md's own roadmap calls this "conversation state machine," and future phases (11, 12) can extend this same entity naturally without a confusing rename — but its *shape* today only models one turn, since multi-turn context is explicitly out of this phase's scope (diagnostic Q11). `answer` is always populated (the real generated answer, or whichever fixed message applies) — `status` is what distinguishes *why*, avoiding a nullable-answer column that would need its own separate handling.
**2. `min_distance`, not an average, computed from the already-sorted retrieval result's first entry.** `chunks[0].distance` — no extra aggregation logic needed, since Phase 8's query already orders by distance ascending.
**3. Two thresholds resolved into a simpler two-outcome-plus-failure-escalation design, not a guessed three-way confidence split.** Rather than inventing a second cutoff with no real data behind it, escalation in this first version is reserved for a concrete, already-real case: a generation call failing outright (Phase 9's raw 500). `distance < 0.45` → answer normally; anything else (zero chunks, or a weak match) → refuse.
**4. The threshold itself (0.45) picked from real, measured data, not a guess.** A genuinely related question scored ~0.22 distance against a real chunk (and a *different* related phrasing scored ~0.38 in Phase 8's own earlier test); a genuinely unrelated question scored ~0.56. 0.45 sits between the observed related and unrelated ranges — a real starting point, explicitly tunable once Phase 17 gives actual outcome data, not asserted as permanently correct.
**5. `citations` stored as `jsonb`, not a separate table.** A small, structured value that's never independently queried (nothing needs "find all conversations that cite chunk X" yet) — a dedicated table would be schema complexity with no current benefit.
**6. `StoredCitation` duplicated by hand in the entity file, not imported from `modules/answer/`.** Database entities are lower-level infrastructure; importing a feature module's type into an entity would invert the normal dependency direction (modules depend on `database/`, never the reverse). A small, manually-kept-in-sync duplicate is the same tradeoff this project already accepted for cross-folder types (Backend/Frontend/Widget) — extended here to a cross-layer case within Backend itself.
**7. Generation failures caught and converted to `escalated`, not left as an uncaught error.** A direct, deliberate reversal of Phase 9's own design (a real 500) — now that there's somewhere durable to *record* an escalation, converting a failure into a recorded, followable-up-on state is strictly more useful than a bare error response, without weakening Phase 9's original "don't retry a live customer" reasoning at all (still no retry — just a different, better-recorded outcome).

---

## Data flow

```
POST /workspaces/:workspaceId/ask  { question }
        │
        ▼
  RetrievalService.retrieveRelevantChunks(workspaceId, question)   (Phase 8, unchanged)
        │
        ▼
  minDistance = chunks[0]?.distance ?? null
        │
        ├── minDistance === null OR minDistance >= 0.45
        │     └─→ status: REFUSED, answer: "I don't have information about that."
        │
        └── minDistance < 0.45
              │
              ▼
        generationProvider.generate(systemPrompt, question)
              │
              ├── succeeds → status: ANSWERED, real answer + resolved citations
              │
              └── throws  → status: ESCALATED, fixed "connecting you with a
                             member of our team" message, no citations
        │
        ▼
  conversations.save({ workspaceId, question, answer, status, minDistance, citations })
        │
        ▼
  { answer, citations, status }
```

---

## Migrations: what each table and column actually stores

**`conversations`** (`CreateConversations` migration) — one row per customer question, the first persistent record this project has ever kept of an actual Q&A exchange.

| Column | Stores | Why |
|---|---|---|
| `workspace_id` | FK to `workspaces.id`, indexed, `CASCADE`. | Every other tenant-scoped table in this project follows the same shape; a conversation has no meaning once its workspace is gone. |
| `question` | The customer's raw question text. | The actual input — needed for any future review, evaluation, or agent-facing display. |
| `answer` | Whatever text was actually shown to the customer — a real generated answer, or one of the two fixed messages. | Always populated regardless of outcome, so nothing downstream needs special-case handling for "no answer was ever produced." |
| `status` | `answered` \| `refused` \| `escalated`. | The state-machine value this whole phase exists to compute and record. |
| `min_distance` | The closest retrieved chunk's cosine distance, or `NULL` if nothing was retrieved at all. | The actual confidence signal, kept as a raw number (not just baked into the status) so future tuning/evaluation work can look back at real historical values, not just the binary decision they produced. |
| `citations` | The resolved citation array (possibly empty), as `jsonb`. | Exactly what was shown to the customer — kept alongside the answer for the same review/evaluation reasons as `question`/`answer`. |
| `created_at` | Timestamp, defaulted by the DB. | Matches every other table's audit-timestamp pattern in this project. |

---

## Code walkthrough

**`conversation.entity.ts`** — the one file where a deliberate layering decision (Architecture #6) is visible directly in the imports: no reference to `modules/answer/` anywhere, by design.

**`answer.service.ts`** (extended) — `answer()` now has three real exit points (refused-empty, refused-weak, answered) plus a catch block turning a generation failure into the fourth (escalated) — all four converge on the same `persistAndReturn()` helper, so persistence can't accidentally be skipped for any one outcome by a future edit that adds a fifth path without remembering to route it through the same helper.

---

## Failure cases actually tested

**1. A real, measured threshold distinguishes a genuinely related question from a genuinely unrelated one.** Directly measured against this project's own embedding model (not assumed): a related question scored ~0.22 distance, an unrelated one ~0.56 — real data behind the 0.45 threshold, not a guess.

**2. A weak match is refused, not confidently answered from thin material — proven end-to-end, with the generation provider wired to throw if called at all.** A genuinely unrelated question against a real, seeded refund chunk correctly returned `refused`, and the substitute generation provider (which would have thrown had it been invoked) was never called — real, structural proof the threshold check happens *before* any generation attempt, not just in intent.

**3. A generation failure now escalates gracefully — proven as a real HTTP 201 with a real persisted `escalated` row, not the previous phase's raw 500.** A substitute provider forced to throw resulted in a real, complete response to the customer and a real, queryable database row a future Phase 12 agent console could act on.

**4. `min_distance` is correctly `NULL` for a genuinely empty retrieval, and correctly populated (and above/below 0.45 as expected) for both the weak-match and confident-match cases** — verified directly against the real database row in every relevant test, not just the HTTP response.

---

## Tests and why each exists

| Test file | What it proves |
|---|---|
| `test/answer.e2e.spec.ts` | The full confidence/escalation/persistence logic end-to-end: a confident real answer persists correctly; an empty retrieval refuses without ever calling generation; a weak-but-nonzero match *also* refuses without calling generation (the actual new behavior this phase adds); a generation failure escalates gracefully with a real persisted row; cross-workspace isolation continues to hold; an invented citation number is still safely dropped; guard/validation behavior is unchanged |

---

## Reverse-engineering guide (if reopened in six months)

1. Start at `answer.service.ts`'s `answer()` method — the four-way branch (refused-empty, refused-weak, answered, escalated) and the shared `persistAndReturn()` helper are the entire design.
2. If a conversation's outcome ever looks wrong, check `conversations.min_distance` directly against `CONFIDENT_DISTANCE_THRESHOLD` before assuming retrieval (Phase 8) or generation (Phase 9) misbehaved — this phase's own threshold logic is the most likely place a surprising `refused`/`answered` split actually comes from.
3. `CONFIDENT_DISTANCE_THRESHOLD = 0.45` is a real, measured starting point, not a permanent constant — if retrieval quality or the embedding model ever changes, re-measure real related-vs-unrelated distances the same way this phase did, rather than assuming the old number still holds.
4. Phase 12 will need to add real states (`claimed_by_agent`, `resolved`) to `ConversationStatus` and build an actual UI around `escalated` rows — this phase deliberately stops at "detect and record," nothing more.

---

## Closing quiz (round 1) — answered and scored (2026-09-20)

**Result: 1 SOLID / 2 SHAKY / 5 UNKNOWN.** Notably weaker than Phase 9's 3/3/2 — worth naming honestly rather than glossing over, especially since one answer (Q7) directly contradicts a real, already-tested behavior of this phase's own code.

### Q1 — Step by step, what happens for a genuinely unrelated question, assuming 5 chunks still come back?
**Answer:** "we will refuse to answer"

**Score: SHAKY.** Right outcome, no walkthrough. Real, step-by-step version: retrieval returns 5 chunks (it always fills up to `k`, regardless of quality — Phase 8's own design). `chunks[0].distance` — the closest of the 5, since they're already sorted — is read as `minDistance`. That value is compared against `CONFIDENT_DISTANCE_THRESHOLD` (0.45). Because the question is genuinely unrelated, that closest distance is still large (measured at ~0.56 for a real test case), so it's `>= 0.45`, and the code takes the refusal branch — **before ever calling the generation provider.** The customer sees "I don't have information about that," and a `refused` row is persisted with the real `min_distance` value.

### Q2 — Why is `min_distance` nullable, and when is it actually `NULL`?
**Answer:** "because if there is no chunk than its min distance will alos be null"

**Score: SOLID.** Exactly right — the only case is genuinely zero retrieved chunks, since there's no "closest distance" to report if nothing was retrieved to measure one against.

### Q3 — What real, dangerous change did the auto-generated migration try to make?
**Answer:** "dont knwo"
**Score: UNKNOWN.** Real answer: it tried to `DROP` Phase 8's real HNSW index and recreate it in `down()` as a plain, non-HNSW index (`ON "document_chunks" ("embedding")`, no `USING hnsw`, no `vector_cosine_ops`). This happened because TypeORM's schema-diffing still doesn't understand `USING hnsw` + an operator class (the exact same gap Phase 8's own migration had to work around by hand) — it saw an index in the real database that isn't described anywhere in the entity's decorators, and concluded it must be a mistake to "fix." Caught by reading the generated migration before running it, not by TypeORM warning about anything.

### Q4 — Why does a generation failure now escalate instead of the raw 500 Phase 9 used?
**Answer:** "it is good for user experince"

**Score: SHAKY.** True, but generic — misses the actual structural reason this became *possible* now. Before this phase, there was nowhere to durably record "this needs human attention" — a raw error was genuinely the only honest option available. Phase 10 introduced real persistence (the `Conversation` table), which is *specifically* what makes "convert this failure into a recorded, trackable state a future Phase 12 agent console can act on" a real, meaningful choice rather than just a friendlier-sounding error message. The UX improvement is a real side effect, but the *reason it became the right engineering choice* is that there's now somewhere real for the escalation to live.

### Q5 — If the embedding model changes, what happens to `CONFIDENT_DISTANCE_THRESHOLD`?
**Answer:** "than we have to keep be according to the new embedding model embeddings"

**Score: UNKNOWN** — too imprecise to credit, though there's a fragment of the right instinct. Real answer, connecting directly back to Phase 7's Q7 (the one genuinely SOLID answer that phase produced): a new embedding model doesn't just require re-embedding every existing chunk (Phase 7's lesson) — it also means **0.45 stops meaning anything**, because that number was measured specifically against *this* model's particular geometry. A different model could place genuinely related content at a completely different typical distance (0.1, or 0.6 — there's no way to know without checking). The threshold would need to be **re-measured from scratch**, the same way this phase's own build measured it — real related-vs-unrelated test queries against the new model, not an assumption that the old number still applies.

### Q6 — Why does `StoredCitation` exist as its own duplicate type?
**Answer:** "dont know"
**Score: UNKNOWN.** Real answer: importing `Citation` from `modules/answer/` into a `database/entities/` file would mean a low-level infrastructure layer depending on a feature module — backwards from how every other entity in this project relates to the modules that use it (modules import from `database/`, never the reverse). `StoredCitation` is a small, structurally-identical type kept in sync by hand, the same tradeoff already accepted for types shared across the Backend/Frontend/Widget folder split, applied here to a layering boundary *within* Backend itself.

### Q7 — Is `escalated` currently reachable for a medium-confidence answer, or only a hard failure?
**Answer:** "yes if confident is >= 0.45"

**Score: UNKNOWN — and this one is worth being precise about, since it names the exact opposite of this phase's real, already-tested behavior.** A distance `>= 0.45` leads to **`refused`**, not `escalated` — this is exactly what the "refuses... when the closest retrieved chunk is not actually relevant" test proves for real (a genuinely unrelated question, measured at ~0.56 distance, resulted in a persisted `refused` row). In this first version, **`escalated` is only reachable one way: a genuine generation-call failure** — a real technical error, not a confidence judgment call. There is deliberately no "medium confidence" middle zone in the code at all right now (Architecture decision #3) — inventing a second threshold to create one was explicitly *not* done this phase, for lack of real data to justify where it should sit. Worth re-reading Architecture decision #3 directly, since this mixes up the two genuinely separate rejection categories (`refused` = confidence-based, `escalated` = failure-based) that this phase went out of its way to keep distinct.

### Q8 — What would Phase 12 need to add to make `escalated` useful to a human?
**Answer:** "dont know"
**Score: UNKNOWN.** Real answer: at minimum, new `ConversationStatus` values representing an agent actually picking up and resolving the conversation (something like `claimed_by_agent`, `resolved`), a real UI listing escalated conversations for agents to see, a claiming mechanism (with real concurrency handling — PHASES.md itself names "optimistic concurrency on claim" as part of Phase 12's job, since two agents could try to claim the same conversation at once), and presence tracking (knowing which agents are currently available). This phase deliberately builds none of that — it stops at "a real, queryable `escalated` row exists," which is the minimum Phase 12 needs to have something to build on top of.

---

## Topics to master

Combining the opening diagnostic (3/1/7) and the closing quiz (1/2/5).

### 1. Distinguishing a confidence-based rejection from a failure-based one, even when both produce "no confident answer"
**Search:** "error handling vs business logic rejection", "distinguishing expected outcomes from failures in API design", "graceful degradation vs error states"
**Exposed by:** closing Q7 — the most important correction in this quiz.
`refused` and `escalated` look superficially similar (neither gives the customer a confident, cited answer) but represent genuinely different situations: one is a *judgment call* about weak evidence, the other is a *technical failure* the system couldn't route around. Conflating them — treating any "no good answer" outcome as one bucket — loses information a system built to actually act on the difference (a future agent console, an evaluation pipeline) would need.

### 2. Recognizing when new infrastructure (not just new logic) is what makes a design choice possible
**Search:** *(a design-reading habit)* — related: "why does this architecture decision depend on this other one"
**Exposed by:** closing Q4.
Correctly stating an outcome ("this is better for the user") without noticing *what upstream change made this outcome newly achievable* (persistence existing at all) is a common way to under-understand a design — the same "adjacent true fact instead of the actual mechanism" pattern flagged in Phase 9's closing quiz, recurring here.

### 3. A calibrated threshold is calibrated *to something specific* — re-calibrate when that something changes
**Search:** "threshold recalibration after model change", "embedding model version migration", "why can't I reuse an old similarity threshold"
**Exposed by:** closing Q5, directly building on Phase 7's Q7.
A number tuned against real data isn't portable to a different underlying system just because it "worked before" — this generalizes well past embeddings, to any threshold, rate limit, or heuristic constant measured against one specific version of something that later changes.

---

## Interview questions this phase generates

- "Your system has two different 'we couldn't give a confident answer' outcomes. When would you deliberately keep them as separate states rather than merging them into one 'failed' bucket?"
- "A design decision in your system only became possible after an earlier, seemingly-unrelated architecture change. How do you explain *why* to someone reading the code cold?"
- "You calibrated a similarity threshold against real data. Six months later, the underlying model changes. What exactly breaks, and what do you have to redo?"
- "An ORM's auto-generated migration includes a change you didn't ask for. What's your process for catching that before running it?"

---

## What's still not understood

Five of eight closing-quiz questions remain UNKNOWN, and one (Q7) is a real, direct misconception about this phase's own tested behavior — worth resolving before moving on, not carrying forward. The clearest single fix: re-read Architecture decision #3 and the Q7 correction above together, since they're the same point stated two ways (`escalated` is reachable *only* via generation failure in this version, never via a confidence threshold). Q3 and Q6 are more mechanical (the migration bug, the layering-duplication reason) and should close quickly with a direct re-read; Q5's gap (re-calibration after a model change) is worth carrying forward explicitly, since it will become concrete and unavoidable the moment this project's embedding model ever actually changes.