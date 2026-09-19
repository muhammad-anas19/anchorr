# Phase 9 — LLM Provider Interface & Grounded Answer Generation

## Objective

Take Phase 8's retrieved chunks and a customer's question, assemble them into a prompt, call Gemini's chat/generation model behind a thin custom interface (matching this project's "no LangChain, one LLM provider" locked decision), and return an answer that's actually grounded in — and cites — the retrieved documentation, not the model's own general knowledge.

## Why the system needs this

Retrieval (Phase 8) finds the right pieces of documentation; it doesn't answer anything by itself. This phase is where Anchor's product actually starts *talking* — and where the two things that make Anchor trustworthy rather than just "a chatbot with a search feature" get built: grounding (the answer has to come from this business's own content, not the model's generic training knowledge) and citations (the answer has to say exactly where it came from, so it can be checked). Get this phase wrong and everything built so far — accurate extraction, sensible chunking, correct retrieval — is wasted the moment the model is free to ignore it and answer from its own assumptions instead.

---

## The diagnostic

12 questions, answered in one batch. Scored honestly, without correcting in place — real explanations follow.

### Q1 — What does "grounded" mean, and why does it matter specifically for customer support?
**Answer:** "don't know"

**Score: UNKNOWN.** "Grounded" means the model's answer is built *only* from specific, verifiable source material handed to it at generation time (the retrieved chunks) — not from its own broad, un-sourced training knowledge. Why it matters here specifically: a customer-support AI that isn't grounded can answer *confidently and fluently* using generic assumptions about "how most companies handle refunds" instead of *this* business's actual policy — sounding authoritative while being wrong. That's not a minor quality issue for Anchor — it's the exact failure mode that would make a business's own AI misrepresent them to their own customers, doing real reputational or even financial harm. Grounding is the mechanism that ties every answer back to a specific, checkable source, which is also *why* citations (Q5) are central to this whole product, not a nice-to-have feature bolted on afterward.

### Q2 — What is "hallucination," and why doesn't good retrieval automatically prevent it?
**Answer:** "it is llm thing like if llm dont hae enough context it halucinates and give wrong or random answer"

**Score: SHAKY.** The link between insufficient context and bad output is real, but hallucination is broader than that — worth the fuller picture, since this is directly the point of Q12 later on. Hallucination is when a model generates text that is fluent and confident-sounding but factually wrong or fabricated — and critically, **this can happen even with perfectly good, sufficient context**, for a few real reasons: (a) the model can blend the given context with unrelated facts from its own training data, without ever signaling that it did; (b) the model can genuinely misread or subtly misinterpret the context and state something that sounds right but doesn't match what the source actually said; (c) the model can fill in specific-sounding details (a number, a date, a policy nuance) that were never actually present anywhere in the context, because generating *something* concrete is what its training rewards, even when the honest answer would be "the source doesn't specify." This is exactly why grounding *reduces* hallucination without *eliminating* it (Q12) — it's not solely a "ran out of context" problem.

### Q3 — Concretely, how do you assemble chunks + question into what's sent to the LLM?
**Answer:** "so i will send both to llm with a system prompt in whihc i will explain his role how he has to behave and etc"

**Score: SOLID.** Correct shape. To make it concrete: chat/generation models take a structured sequence of **messages with roles** — a **system** message (the model's role, rules, and constraints — "You are a support assistant for [business]. Answer only using the context below. If the answer isn't there, say so."), then the **context** (the retrieved chunks, typically numbered), then the **user's actual question**. The model treats all of this as one continuous conversation and generates the next message in that sequence.

### Q4 — What goes wrong without an explicit "answer only from the context" instruction?
**Answer:** "it can produce answer that is not related to the workspace"

**Score: SHAKY.** True, but understates the real risk. Without that instruction, the model treats the retrieved chunks as *helpful background*, not a *hard constraint* — it will freely blend its own general knowledge with what was actually provided, with **no signal to anyone about which parts came from where**. The dangerous version of this isn't "an obviously off-topic answer" (easy to notice) — it's an answer that *sounds* precisely tailored to this business's real policy, mixing genuine retrieved content with the model's own generic assumptions seamlessly, which is much harder for anyone — the customer, the business, even Anchor itself — to catch.

### Q5 — How would the model know which chunk supports which part of its answer?
**Answer:** "i will tell the llm the info about that chunk like ondex and other meta data"

**Score: UNKNOWN.** Real, standard mechanism: number each retrieved chunk directly in the prompt (`[1] Refunds are available within 30 days... [2] Enterprise contracts are non-refundable...`), and instruct the model to cite those bracket numbers next to the claims they support in its answer (`You can get a refund within 30 days [1], though enterprise plans are excluded [2].`). The model isn't handed abstract "metadata" to recite — it's given a numbered list and told to reference numbers. **After** generation, those numbers get mapped back to the real chunk/document metadata Phase 8's result already contains (`chunkId`, `documentId`, `originalFilename`) to build actual citation links in the response — that mapping happens in application code, not inside the model's own output.

### Q6 — What should happen differently when retrieval returns zero chunks?
**Answer:** "maybe we can tell user and the workspace admin about this issue so that it can reuplaod the doc and if chunk contains embedding than we will send that chunk to llm and users query to genarte final answer"

**Score: UNKNOWN.** The real, load-bearing design point got missed: when Phase 8 returns zero chunks, the correct behavior is to **short-circuit entirely — return a fixed, honest "I don't have information about that" response without ever calling the generation LLM at all.** Two real reasons: (1) cost — there's nothing to generate an answer *from*, so paying for a generation call is pure waste; (2) safety — calling the LLM with an empty context block and *hoping* it says "I don't know" is unreliable; a model given nothing to ground on may still answer from its own general training knowledge, which is exactly the ungrounded-hallucination risk from Q1/Q4. Short-circuiting *before* the LLM is ever called removes that risk structurally, rather than trusting a prompt instruction to catch it. This needs to be a genuinely separate code path — "chunks found" and "no chunks found" aren't two variations of the same logic, they're two different outcomes entirely.

### Q7 — What should the LLM provider interface actually look like?
**Answer:** "it neetts some mre data like temperatre and more things i am not yet familiar maybe structure of answwer i want memrory etc"

**Score: SHAKY** — a genuinely honest, correctly-aimed guess (this needs to be more than a copy of `EmbeddingProvider`), even without full certainty. Real answer: a generation call needs, at minimum, the actual structured messages (system + context + question — Q3), not one plain string, plus real configuration like **`temperature`** (how random vs. deterministic the output is — for a factual support answer, *low* temperature is the right default, favoring consistency over creative variation) and typically a `maxOutputTokens` ceiling (a real cost/length control). The return shape is a generated answer (a string, or a richer object), not a fixed-size vector. Given this project's locked "one LLM provider behind a custom interface" decision, this phase defines something shaped like `generateAnswer(systemPrompt, context, question): Promise<string>` — genuinely different from `EmbeddingProvider`, not a reskin of it.

### Q8 — Is a generation call meaningfully different from an embedding call — cost, latency, failure modes?
**Answer:** "for this we will use websocket not typical req res cycle"

**Score: UNKNOWN** — this answers Q11's question, not this one. Real answer: **cost** — generation models are typically billed per *input* token *and* per *output* token (embedding calls are essentially input-only, since the "output" is just a fixed vector); output-token pricing is often the more expensive side. **Latency** — generation is meaningfully slower: an embedding call returns a fixed-size vector almost immediately, while a generation call has to produce potentially hundreds of words of new text, taking real seconds rather than milliseconds. **Failure modes** are broadly the same categories (rate limits, downtime, timeouts) but the *stakes* differ sharply: a failed embedding call (Phase 7) just delays invisible background processing; a failed generation call means a customer gets **no answer at all**, in the exact moment they're waiting for one.

### Q9 — Synchronous, same request as retrieval, or somewhere else?
**Answer:** "dont know"

**Score: UNKNOWN.** Yes, synchronous, same request — a direct continuation of Phase 8's own reasoning. A customer is waiting live for one coherent conversational turn (ask → get an answer), and generation directly depends on retrieval's output — there's no real benefit to splitting "find the chunks" and "generate from those chunks" into two separate round-trips when both have to finish before the customer sees anything useful anyway.

### Q10 — If the generation call itself fails while a customer is waiting, is this the same "retry later" situation as background jobs?
**Answer:** "not we will just ak user to try again but if the error is about limit exceed than clear error and no try again"

**Score: SOLID.** Correct, and the rate-limit-specific distinction is a genuinely good instinct. To state the underlying principle plainly: this is fundamentally **not** the Phase 4-7 pattern, where a failure just means "try again in the background in a few seconds, nobody's watching." Here, a customer is actively waiting *right now* — there's no acceptable version of "silently retry later and get back to them" inside one synchronous chat turn. The correct shape is failing fast with a real, visible error the customer sees immediately (and can choose to ask again themselves) — not a hidden retry queue.

### Q11 — Streaming, or a single complete response — what decides that?
**Answer:** "i think streaming so that user dont have to wait he can get res as soon as llm generates it"

**Score: SHAKY** — a reasonable UX instinct, but missing the actual sequencing reason this phase specifically shouldn't build it yet. Real answer: this phase should return a **single, complete, synchronous response**. Streaming (words appearing progressively) needs a genuinely different transport — Server-Sent Events or, in this project's case, the Socket.IO real-time infrastructure that's explicitly **Phase 11's** job, not built yet. Building streaming now, with no live chat widget yet able to *display* progressive output, would mean building a feature this phase has no way to actually verify end-to-end — directly against this project's own standing rule (build only what the current phase's objective calls for). Phase 9 returns one complete answer; Phase 11 is where streaming becomes real, testable, and worth the complexity, once there's an actual UI to stream into.

### Q12 — Is grounding alone a complete fix for hallucination? What's the real gap?
**Answer:** "dont know"

**Score: UNKNOWN.** No — grounding is a **strong mitigation, not a complete fix**. Even under an explicit "only use the provided context" instruction, a model can still: (a) subtly paraphrase in a way that drifts from what the source actually said; (b) fill in plausible-sounding specifics when the context is ambiguous or incomplete, rather than honestly saying the source doesn't specify; (c) occasionally not follow the instruction perfectly under certain prompt conditions — models are not perfectly rule-following systems. This is exactly why **citations matter as a second, independent safeguard, not a cosmetic feature**: a citation lets a human — a business owner today, an automated evaluation system in Phase 17 eventually — actually go check whether the cited source really says what the model claims. Grounding reduces *how often* hallucination happens; citations make the hallucination that still slips through **detectable** instead of invisible. This exact gap is also the reason Phase 10 (confidence scoring and escalation) exists as its own phase — grounding plus citations still isn't a 100% guarantee, and a real system needs a designed, deliberate way to know when to hand off to a human instead of trusting an answer at all.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for this phase's actual build:

1. **Grounding as a hard constraint you have to instruct for, not a property retrieval gives you for free** (Q1, Q4) — the single idea this whole phase exists to implement; skip the explicit instruction and Phase 8's careful, correct retrieval work buys nothing.
2. **Hallucination as a broader failure mode than "not enough context"** (Q2, Q12) — it can and does occur even with good context, which is exactly why citations exist as a *second*, independent safeguard rather than redundant with grounding.
3. **The empty-retrieval short-circuit as a genuinely separate code path, not a prompt-level detail** (Q6) — a real, structural design decision (skip the LLM call entirely) with real cost and safety reasons behind it, not just "handle the edge case somehow."
4. **The citation mechanism: number chunks in the prompt, resolve numbers back to metadata afterward** (Q5) — the concrete technique that turns "the model said something" into "the model said something, and here's exactly where to check it."
5. **A generation call's different cost/latency/stakes profile from an embedding call** (Q8) — directly shapes this phase's error-handling design (Q10) and previews real billing considerations (Phase 15/16).
6. **Scope discipline: not building streaming before there's a consumer for it** (Q11) — a recurring, transferable engineering habit this project keeps re-testing: matching what gets built to what the current phase can actually verify, not to what would eventually be nice.

---

## Architecture & decisions

Design proposed after the diagnostic, agreed to as-is:

**1. A new, separate `src/generation/` module — deliberately not merged into `src/embedding/`.** Both wrap the same underlying Gemini SDK, but `AnswerGenerationProvider` and `EmbeddingProvider` are genuinely different capabilities with different configuration (temperature/system-instruction have no meaning for embedding calls) — the same interface-segregation instinct that already kept `StorageAdapter` separate from everything else.
**2. Interface shape matches the real API split, not a generic "messages array."** `generate(systemPrompt: string, userMessage: string, options?): Promise<string>` — mirroring how `@google/genai`'s `generateContent` actually separates `systemInstruction` from `contents`, rather than inventing a role-array abstraction that doesn't match what's really being called underneath.
**3. Model discovery, not a guessed name (Q7/Q8 territory, directly reusing Phase 7's method).** `gemini-2.5-flash` (the name in the SDK's own doc comments) returned a real 404 — *"no longer available to new users... use models/gemini-3.6-flash"* — the API telling us the exact replacement. Used `gemini-3.6-flash`.
**4. `temperature: 0.2` by default, not left at the SDK's own default.** A real, deliberate choice per Q7's reasoning — favoring consistent, low-variance answers for a factual support context over creative diversity.
**5. A new `AnswerService` orchestrating retrieval → short-circuit → prompt assembly → generation → citation resolution**, in `modules/answer/`, depending on `RetrievalModule` (Phase 8) and the new `GenerationModule`. `RetrievalModule` needed `RetrievalService` added to `exports` — it had never needed to be consumed by another module before this phase.
**6. Citations: numbered in the prompt, parsed by regex, resolved against the *same* array retrieval returned.** `[${i+1}]` numbering in the prompt maps directly back to `chunks[index - 1]` after generation — no separate lookup, no re-querying the database for citation metadata, since Phase 8's result already carried everything needed (`chunkId`, `documentId`, `originalFilename`).
**7. Unresolvable citation numbers are silently dropped, not treated as errors (Q12's "models aren't perfectly rule-following" made concrete).** Proven for real in Failure Cases below — a model citing a number outside the range it was actually given doesn't crash or corrupt the response, it just doesn't produce a citation entry for that number.
**8. No try/catch around the generation call — a real failure propagates as a real, immediate error (Q10).** Deliberately *not* wrapped in a "return a fallback answer" pattern — a customer waiting live for an answer should see an honest failure, not a silently degraded, potentially misleading response.

---

## Data flow

```
POST /workspaces/:workspaceId/ask  { question }
        │
        ▼
  JwtAuthGuard → WorkspaceGuard   (unchanged since Phase 2)
        │
        ▼
  AnswerService.answer(workspaceId, question)
        │
        ▼
  RetrievalService.retrieveRelevantChunks(workspaceId, question)   (Phase 8, unchanged)
        │
        ├── chunks.length === 0
        │     └─→ return { answer: "I don't have information about that.", citations: [] }
        │          (generation provider never called)
        │
        └── chunks found
              │
              ▼
        buildSystemPrompt(chunks)   → numbered context + grounding + citation instructions
              │
              ▼
        generationProvider.generate(systemPrompt, question)   (real Gemini call)
              │
              ▼
        resolveCitations(rawAnswer, chunks)   → parse [n], map back to chunk metadata
              │
              ▼
        { answer, citations: [{ index, chunkId, documentId, originalFilename }, ...] }
```

---

## Code walkthrough

**`answer-generation-provider.interface.ts` / `gemini-answer-generation.provider.ts`** — mirrors Phase 7's `EmbeddingProvider` pattern exactly (a thin interface, a Gemini-specific implementation, a `ConfigService`-injected API key), the one difference being the interface's actual shape (Architecture decision 2).

**`answer.service.ts`** — the entire phase's logic in one file. `buildSystemPrompt()` and `resolveCitations()` are plain, pure functions (no DI, no I/O) — deliberately kept outside the injectable class, the same instinct Phase 6 applied to `chunkText()`: pure logic is easier to reason about and test in isolation than logic tangled into a class method. `resolveCitations()`'s `chunks[index - 1]` line is the one place the "prompt numbers from 1, arrays index from 0" translation happens — worth remembering if citation numbers ever look off by one during future debugging.

---

## Failure cases actually tested

**1. Grounding actually works, proven with a real, adversarial-ish prompt.** Given a context about office hours and asked "What is the capital of France?" (a question the model obviously *knows* the answer to from its own training), the real Gemini call correctly refused and returned the exact configured fallback phrase — direct, real evidence that the system-prompt instruction genuinely constrains the model, not just a hopeful assumption.

**2. A real, end-to-end grounded answer with a correctly-resolved citation.** A real chunk ("Refunds are available within 30 days...") seeded, a real question asked, a real Gemini call made — the returned answer correctly referenced the fact, and the citation array correctly resolved index 1 back to the actual seeded document's filename.

**3. Empty retrieval short-circuits before ever calling the generation provider — proven, not assumed.** Using a substitute `AnswerGenerationProvider` that throws if invoked at all, a workspace with zero embedded chunks correctly returned the fixed "no information" answer without the substitute ever firing — real proof the short-circuit branch, not just prompt wording, is what prevents an empty-context generation call.

**4. Cross-workspace isolation holds through the *entire* answer flow, not just raw retrieval.** A real chunk seeded only in a second workspace never leaked into the first workspace's answer, even indirectly through generation — the empty-retrieval short-circuit fired correctly across the workspace boundary.

**5. A model citing a number outside the range it was actually given doesn't break anything.** A substitute generation provider was made to return `[1]` (real) and `[7]` (invented — only one chunk was ever sent) in the same answer. The real citation-resolution code correctly kept the valid one and silently dropped the invalid one, rather than crashing or producing a broken citation entry — a direct, deliberately-triggered test of Q12's "models don't always follow instructions perfectly."

**6. A real generation failure surfaces as a real, immediate error — not a silent fallback.** A substitute provider was made to throw; the real HTTP response was a genuine `500`, visible in the server's own error log, with no retry, no queued job, and no degraded "best guess" answer returned instead. Directly proves Q10's design: this is not the Phase 4-7 background-job failure pattern.

---

## Tests and why each exists

| Test file | What it proves |
|---|---|
| `gemini-answer-generation.provider.spec.ts` | Real Gemini generation calls succeed and respect the system prompt's tone/format instruction; real, adversarial proof that grounding actually prevents an off-context answer |
| `test/answer.e2e.spec.ts` | The full real pipeline end-to-end (real embedding, real retrieval, real generation, real citation resolution); the empty-retrieval short-circuit proven with a throwing substitute provider; cross-workspace isolation through the whole flow; guard enforcement (401/403); DTO validation; both deliberate failure injections (Failure Cases 5 and 6) |

---

## Reverse-engineering guide (if reopened in six months)

1. Start at `answer.service.ts` — `answer()` is the whole orchestration; `buildSystemPrompt()`/`resolveCitations()` are the two pure functions worth reading in isolation if either citations or grounding behavior ever look wrong.
2. If citations look off (wrong document, off-by-one), check `resolveCitations()`'s `chunks[index - 1]` line first — the prompt numbers from 1, the array indexes from 0.
3. If the model ever seems to be answering from outside the provided documentation, re-read `buildSystemPrompt()`'s exact wording before assuming the retrieval step (Phase 8) found the wrong chunks — grounding is an instruction, not a hard guarantee (Q12), and prompt wording changes can weaken it.
4. If `gemini-3.6-flash` (or whatever model is configured by the time this is reopened) ever 404s, don't guess a replacement — call `client.models.list()` for real and filter for `generateContent` support, exactly as this phase's own build had to do.
5. A generation failure is a real, uncaught error by design (Architecture decision 8) — if this ever needs to change (e.g., a friendlier customer-facing error message), that's a deliberate product decision to make explicitly, not a bug to "fix" by adding a try/catch reflexively.

---

## Closing quiz (round 1) — answered and scored (2026-09-20)

**Result: 3 SOLID / 3 SHAKY / 2 UNKNOWN** — the best UNKNOWN-count ratio of any phase's closing quiz so far, and real movement from this phase's own opening diagnostic (2/4/6).

### Q1 — Why does `AnswerService` never call the generation provider for a workspace with zero embedded chunks?
**Answer:** "because there is no reason to call llm if we dont have answer of question"

**Score: SOLID.** Right core reasoning, stated briefly. Full version for completeness: no cost (nothing to pay for generating an answer from), and no safety risk (an empty-context generation call can't be trusted to reliably say "I don't know" on its own — see Q1/Q4 from the diagnostic).

### Q2 — In `resolveCitations()`, why `chunks[index - 1]` and not `chunks[index]`?
**Answer:** "because array is 0 indexed"

**Score: SOLID.** Exactly right — the prompt numbers chunks starting at 1 (`[1]`, `[2]`, ...) for readability, but the underlying array is 0-indexed, so citation number 1 corresponds to `chunks[0]`.

### Q3 — Does putting context in the system prompt vs. the user message actually matter to Gemini's API, or is it just style?
**Answer:** "ecause if we send user prompt too maybe llm will haluciante ad try to give random answer"

**Score: UNKNOWN** — doesn't address what was actually asked. Real answer: it's a **genuine technical distinction, not just a style choice**. Gemini's API treats `systemInstruction` and `contents` differently — `systemInstruction` is persistent behavioral guidance the model treats as standing rules for the whole exchange, while `contents` represents the actual conversational turns (what the user said, what the model is now responding to). Putting the retrieved context inside `systemInstruction` (this phase's actual choice) frames it as "background rules to operate under"; putting it in the user message instead would frame it as "part of what the user is saying," which is a legitimate alternative some real RAG implementations use. Both can work — the point is that this is a real architectural choice with a real effect on how the model weighs the information, not an arbitrary organizational preference.

### Q4 — If `gemini-3.6-flash` gets retired next year, what's the first move — and the wrong move?
**Answer:** "we will update model in provider"

**Score: SHAKY.** Correct destination, but skips the actual point of the question. The **wrong** move is guessing a plausible-sounding replacement name from memory or old documentation — exactly what this phase's own build almost did with `gemini-2.5-flash`. The **right** first move is calling `client.models.list()` against the live API (or simply attempting the call and reading the real error, which in this project's actual experience directly *named* the correct replacement) to find a model that's currently valid, *before* touching the provider file at all. "Update the model in the provider" is the last step, not the first.

### Q5 — Why does a real Gemini outage during `/ask` produce an immediate 500, not retry-with-backoff?
**Answer:** "because we dont want user to wait while we are reryting, instead user should know about the events happening in backend so that he can retry by himself"

**Score: SOLID.** Correct — a live, waiting customer shouldn't be kept waiting through a background retry cycle; failing immediately and visibly lets them decide to try again themselves, which is a fundamentally different shape of "retry" than Phases 4-7's silent, automatic, backgrounded kind.

### Q6 — A model cites `[7]` when only 3 chunks exist. What actually happens, step by step?
**Answer:** "we will verfiy afetr model response"

**Score: UNKNOWN** — true but not actually a walkthrough. Real, step-by-step answer: the regex in `resolveCitations()` finds every `[n]` pattern in the raw answer text, including `[7]`. For each number found, the code looks up `chunks[7 - 1]` = `chunks[6]` — which is `undefined`, since the array only has 3 elements (indices 0-2). The `if (!chunk) continue;` check catches this and skips adding a citation entry for it — **no error is thrown, no crash occurs.** One detail worth being precise about: the *raw answer text* returned to the caller still literally contains the string `"[7]"` wherever the model wrote it — only the separate `citations` array omits an entry for it. The response isn't "cleaned up" to remove the dangling reference from the visible answer text itself, only from the structured citation list.

### Q7 — Why does `AnswerGenerationProvider` live in a separate module from `EmbeddingProvider`?
**Answer:** "maybe in future we want answer genartion model of opai"

**Score: SHAKY.** A real, plausible benefit of clean interfaces generally (provider swappability), but not quite this phase's own stated reason. The actual driver (from the Architecture section): **the two capabilities need genuinely different configuration** — `temperature` and `systemInstruction` are meaningless for an embedding call, and an embedding call's fixed-size vector output has nothing in common with a generation call's free-form text output. Interface segregation based on *what each capability actually needs*, not anticipated future provider-swapping, is the more precise reason — though "swappability" is a real, secondary benefit that falls out of the same design for free.

### Q8 — What does `temperature: 0.2` actually control, and why is low the right choice here?
**Answer:** "it controls how specific the answer should be and low means more specific"

**Score: SHAKY** — right direction, imprecise mechanism. Temperature controls **randomness in token selection**, not "specificity." At low temperature, the model strongly favors its single most probable next word at each step, producing consistent, repeatable, low-variance output; at high temperature, it's more willing to pick less-probable-but-still-plausible words, producing more varied, creative output across repeated runs of the *same* prompt. Low temperature is the right choice here not because it makes answers "more specific," but because a factual support answer should be **consistent** — the same question should tend to get essentially the same answer each time, rather than genuinely fresh, more improvisational phrasing on every call.

---

## Topics to master

Combining the opening diagnostic (2/4/6) and the closing quiz (3/3/2).

### 1. LLM sampling temperature as a randomness control, not a "quality" or "specificity" dial
**Search:** "LLM temperature parameter explained", "top-p vs temperature sampling", "deterministic vs creative LLM output"
**Exposed by:** closing Q8.
A genuinely common, load-bearing misconception — believing temperature governs correctness or detail rather than *variability* leads to picking the wrong value for the wrong reason (e.g., cranking it down expecting "more accurate" answers, when what it actually buys is "more repeatable" ones — a real but different property). Any work involving an LLM API, in any project, needs this distinction correct.

### 2. System vs. user role separation in chat-completion APIs as a real architectural choice
**Search:** "system prompt vs user prompt", "chat completion message roles", "RAG context placement system vs user message"
**Exposed by:** closing Q3.
Not yet landed: that where information gets placed in a structured chat API call is a genuine design decision with real behavioral consequences, not an arbitrary style preference. This generalizes to every chat-completion-shaped API (OpenAI, Anthropic, Gemini all use this pattern), not just this one provider.

### 3. "Verify against the live system before guessing" as a recurring debugging discipline
**Search:** *(a debugging habit, recurring across this project)* — related: "API deprecation handling", "avoid hardcoding third-party model/API names"
**Exposed by:** closing Q4, directly building on Phase 7's identical lesson (Q10 there).
This is now the *second* time in this project a model name from documentation/memory turned out to be stale, and the fix both times was the same: ask the live API what's actually valid right now. Worth having fully internalized as a reflex by the time a *third* instance of this shows up, rather than needing a third re-teaching.

### 4. Reference resolution against untrusted model output as a real, expected failure surface
**Search:** "parsing LLM output safely", "handling malformed structured output from language models", "defensive parsing of AI-generated references"
**Exposed by:** closing Q6.
A model's output — even under careful prompting — is not a trusted, schema-validated data source. Treating any structured pattern extracted from it (citation numbers, function-call arguments, anything) the same way you'd treat unvalidated user input — checking existence before use, never assuming well-formedness — is a transferable pattern for any system that parses LLM-generated text programmatically.

---

## Interview questions this phase generates

- "What does an LLM's temperature parameter actually control at the token-selection level, and why would you set it low for a factual Q&A system specifically?"
- "You're building a RAG system. Does it matter whether retrieved context goes in the system prompt or the user message? Why or why not?"
- "A third-party model your code depends on gets deprecated. Walk through your actual first three steps, in order."
- "You're parsing structured references (citation numbers, IDs, whatever) out of an LLM's free-text output. What's your defensive strategy, and why treat this differently from parsing your own database's data?"
- "Why might you deliberately choose *not* to retry a failed request in a live, synchronous, user-facing flow, when every other part of your system retries automatically?"

---

## What's still not understood

Two of eight closing-quiz questions remain UNKNOWN (Q3, Q6), both now covered a second time, differently, in this section and worth a direct re-read rather than treated as resolved by this write-up alone. Three SHAKY answers (Q4, Q7, Q8) share a pattern worth naming explicitly: each correctly identified *an* adjacent true fact (update the provider file; a future provider swap is plausible; low temperature relates to consistency) without landing the *specific* mechanism or reasoning actually being asked about. This is a different, milder gap than flat UNKNOWN — worth treating as "close but not precise yet" rather than either fully understood or fully missing.

Phase 10 (confidence scoring and escalation) will make Q3 and Q6's remaining gaps matter more directly — deciding when to trust a generated answer enough to show it to a real customer requires the same "don't trust the model's output at face value" instinct Q6 was reaching for.