# Phase 15 — Usage metering & rate limiting

> Status: **complete.** Built, tested, broken and documented. Closing quiz posed 2026-10-01; the user asked for written explanations instead of answering, and they are below.

## Objective, and why the system needs it now

Anchor already *does* the expensive things: every answered question costs an embedding call and a generation call to Gemini (Phases 7–9), and every uploaded document costs one embedding call per chunk. Until now nothing records how much of that each workspace consumed, and the only limits are two narrow abuse guards (login attempts, widget messages).

Phase 16 bills three plan types (decided 2026-09-29): a **free trial**, **fixed plans** billed monthly / quarterly / yearly, and **pay-as-you-go** billed on usage. Two of those three need this phase to exist first:

- **Pay-as-you-go** is literally "multiply what was metered by a price". If the meter is wrong, the invoice is wrong — the one place where a bug is *also* a legal and trust problem.
- **The free trial and fixed plans** need *quotas* ("500 answers this month") enforced before work is done, or a free workspace can run up an unbounded Gemini bill that nobody pays.
- **Rate limits** stop one tenant (or one attacker) from exhausting capacity every other tenant shares — the 20/day Gemini generation quota this project keeps hitting in its own tests is exactly the shared resource a noisy neighbour would burn.

So this phase builds three different things that are easy to blur together — see Q1 — and the most important skill of the phase is keeping them apart.

---

## Diagnostic (2026-09-30)

**Score: 0 SOLID / 7 SHAKY / 5 UNKNOWN.**

| # | Topic | Score |
|---|---|---|
| 1 | Rate limit vs quota vs meter | SHAKY |
| 2 | The fixed-window boundary burst | UNKNOWN |
| 3 | Token bucket | UNKNOWN |
| 4 | Usage events vs a counter column | SHAKY |
| 5 | Idempotent metering on retry | SHAKY |
| 6 | Should a cache hit be billable? | SHAKY |
| 7 | Where the usage event is written: lose vs double-count | UNKNOWN |
| 8 | Aggregating for invoices; late events | UNKNOWN |
| 9 | What a 429 must carry | SHAKY |
| 10 | Rate limiting across instances; the Phase 14 fallback | SHAKY |
| 11 | Quota check before/after; the race at 499 | SHAKY |
| 12 | Billing-period time: timezone and column type | UNKNOWN |

The shape is the familiar one for a phase whose topic is new: every answer points in a plausible direction, and none names the mechanism. The standout pattern worth naming: **Q7 and Q10 both describe a *different* system than the one this project already has.** Q10 says Redis-down means "no rate limit" when the code you chose in Phase 14 falls back to a per-instance limit; Q7 picks the one option that can silently *lose* billable usage. Both are the "reasoning from the abstract instead of reading what's there" pattern flagged in Phase 3's quiz.

---

### Q1. What is the difference between a rate limit, a quota and a meter — and which one does billing actually depend on?

**Your answer:** "rate limiting is the process of restricting api calls if it exceeds from the defined number of times in defined interval, quota is how much llm call we can do per day, metering is tracking record of the llm calls we have done in specific time period."

**Score: SHAKY.** The rate-limit definition is right. Metering is close (it records usage — though of any billable thing, not only LLM calls). Quota is defined too narrowly, and the second half of the question — which one billing depends on — wasn't answered.

**The full distinction:**

| | Rate limit | Quota | Meter |
|---|---|---|---|
| Question it answers | "Too fast?" | "Too much, in total, for this plan?" | "How much was used?" |
| Window | Short and rolling: seconds, a minute | Long and tied to the plan: a billing period, a trial | None of its own — it records every event, periods are chosen when you read it |
| Protects | **The service** (capacity, fairness between tenants, abuse) | **The business** (a plan's economics — free users can't run up unbounded cost) | Nothing — it *observes* |
| When exceeded | `429`, try again in a moment | `402`/`403`-style "upgrade or wait for next period" | Nothing is refused |
| Must it be exact? | No — approximate is fine (Phase 14 accepted N × limit during a Redis outage) | Close to exact, but a small overshoot is tolerable | **Yes.** It is money. |
| Source of truth | Redis (fast, disposable) | Derived from the meter | Postgres (durable, auditable) |

**Billing depends on the meter.** Quotas are *computed from* the meter ("sum this period's metered answers, compare with the plan's allowance"), and rate limits are independent of both. A useful test: if Redis were wiped right now, rate limits would reset (harmless — everyone gets a fresh minute), but the meter must be untouched, because that's what the invoice is built from. That is why the meter cannot live in Redis (see Q7).

Also worth correcting: a quota isn't only about LLM calls or only "per day". It can cap any resource over any plan-defined period — answers per month, documents stored, seats, storage bytes.

---

### Q2. "20 requests per minute" as a fixed window: how many requests can a client get accepted in about 2 seconds, and what fixes it?

**Your answer:** "a client can get all 20 req in that two seconds because one minute is the max time for doing 20 req… we can divide 20 req in one minute and allow one req in 3 secs (i think i did not understand the question)"

**Score: UNKNOWN** — you said so yourself, and the answer is 40, not 20. There's a genuinely good idea in your answer though: "one request every 3 seconds" is **spreading requests out evenly**. That is a real algorithm (the *leaky bucket*, used for traffic shaping), and it comes up again in Q3.

**First, a correction to my own question.** I said our limiter counts "per clock-minute". It doesn't. `FixedWindowRateLimiter` (`Backend/src/common/rate-limit/fixed-window-rate-limiter.ts`) runs `INCR`, and only when the count becomes 1 does it set `EXPIRE key 60`. So each key's window **starts at its first request** and ends 60 s later. The problem below is identical either way.

**The boundary burst, step by step.** A fixed window forgets everything the moment it ends:

```
limit = 20 per 60 s window

t = 0.0 s    first request → key created, count 1, expires at t = 60.0
t = 58.9 s   (the client has been quiet) … sends 19 more → count 20. All accepted.
t = 60.0 s   key expires. Redis now holds nothing about this client.
t = 60.1 s   sends 20 → a fresh key, counts 1..20. All accepted.

→ 39–40 accepted between t = 58.9 and t = 60.1: about 2× the limit in ~1 second.
```

The limit is enforced "per window", and a window boundary is the one moment where two full allowances sit next to each other. Worst case: **2 × limit in an instant**. Here's an analogy: a gym allows 20 visits "per calendar month", so you visit 20 times on 31 January and 20 more times on 1 February.

**The fixes, and what each costs:**

| Algorithm | How it works | Accuracy | Cost |
|---|---|---|---|
| **Fixed window** (what we have) | One counter per window | Allows up to 2× at a boundary | 1 key, 1 `INCR` — as cheap as it gets |
| **Sliding window log** | Store the *timestamp* of every request (a Redis sorted set); count those in the last 60 s | Exact | Memory grows with the limit: one entry per request per client. At 20/min it's trivial; at 10,000/min per key it isn't |
| **Sliding window counter** | Keep the current and previous window counts; estimate `previous × (overlap fraction) + current` | Approximate, but the boundary burst is gone | 2 counters — nearly as cheap as fixed. Cloudflare published this as their production approach |
| **Token bucket** | See Q3 | Exact, with a *deliberate* burst allowance | 2 values per client (tokens, last-refill time) |

For a login limit, 2× at a boundary is harmless: bcrypt at 12 rounds already caps an attacker to a few guesses a second. For a *paid API limit* sold as "N per minute", customers notice and it's embarrassing. The decision is part of this phase's design.

---

### Q3. Token bucket: what are its two parameters, what traffic does it allow that "N per window" doesn't, and why would a product want that?

**Your answer:** "dont know"

**Score: UNKNOWN.** From first principles:

**The analogy.** A bucket holds at most `capacity` tokens. Tokens drip in at a steady `refill rate`, and anything above capacity spills away. Every request must take one token out, and if the bucket is empty the request is refused.

```
capacity = 10 tokens      refill = 1 token per second

t=0    bucket full (10). Client fires 10 at once → all accepted, bucket 0.   ← a burst, allowed
t=0.5  request → bucket 0.5 → refused (429)
t=1    bucket 1 → one request accepted → 0
t=1..  from now on: at most 1 per second, sustained
t=30   client idle since t=1 → bucket refilled, capped at 10 → can burst 10 again
```

**The two parameters mean different things:**
- **Refill rate** is the *sustained* throughput you're selling: 1/s is 60/min over time.
- **Capacity** is the *burst* you tolerate: how much work a client may do all at once after being idle.

**What it allows that "N per window" doesn't:** a burst that's **earned by being idle**, and *only* then. A fixed window gives a free 2× burst at every boundary whether the client earned it or not (Q2). A token bucket makes the burst an explicit, capped, deliberate parameter.

**Why a product wants that.** Real traffic is bursty. A customer's support widget sits quiet, then a promotional email goes out and 30 visitors ask questions in the same second. A strict 1-per-second pacer (the "one request every 3 seconds" idea from your Q2 answer, which is the leaky bucket) would make 29 of them wait or fail, although *on average* the customer is well within their plan. A token bucket with capacity 30 lets the spike through and then holds the long-run rate. This is why the AWS API Gateway, Stripe and GitHub API limits are all token-bucket-shaped ("rate" plus "burst").

**How it's stored:** two numbers per client, `tokens` and `lastRefillAt`. On each request you compute `tokens = min(capacity, tokens + (now − lastRefillAt) × rate)`, then take one if there's one to take. The read-compute-write has to be **atomic**, or two concurrent requests both see "1 token left" and both spend it. In Redis that means one Lua script. It's the same lesson as Phase 14's `INCR_WITH_EXPIRY`, and the same reason that script exists.

---

### Q4. Why append-only `usage_events` rows instead of `UPDATE workspaces SET answers_used = answers_used + 1`?

**Your answer:** "so we can divide metering based on the event big events will have high cost"

**Score: SHAKY.** There's one real reason in there: **an event carries its own attributes** (what kind, how many tokens, which model), so different kinds of usage can be priced differently, and a counter can't do that. But that's one reason of about six, and it's the least important one.

**The reasons, most important first:**

1. **You can't answer "why is my bill 4,812?" with a counter.** A counter holds a number and no history. When a customer disputes an invoice, and they will, the event log is the evidence: every answer, when it happened, which conversation. With a counter, the only honest reply is "trust us".
2. **Idempotency needs somewhere to hang.** A retry must not be charged twice (Q5). With events, each one carries a unique key and the database *rejects* the duplicate (a `UNIQUE` constraint, the same two-layer idea as Phase 3's `content_hash`). With `+1`, a retried `+1` is just another `+1`; there's nothing to compare against.
3. **You can recompute.** Found a metering bug? Changed the price? Want to move from "per answer" to "per 1,000 tokens"? With events, you rerun the aggregation over history. With a counter, the past is a single number that can't be re-derived.
4. **Hot-row contention.** Every answer in a busy workspace would `UPDATE` the *same* `workspaces` row. Postgres takes a row lock per update, so concurrent requests queue on one row. That's the same serialisation the workspace lock in the members work used *on purpose*, here imposed by accident on the hottest path in the product. `INSERT`s into an append-only table don't contend with each other.
5. **Any period, after the fact.** A counter only knows the total "since it was reset". Events answer "usage this month", "last 7 days", "the trial period", "by day for the chart", all from the same rows.
6. **Different billable dimensions.** Your reason: tokens, documents embedded, and answers are separate columns or event types, each with its own price.

The trade-off the other way: events cost storage, and summing them costs a query. That's what Q8 is about, and why rollups exist.

**In Anchor today:** `conversations` already *behaves* like an event log. It's append-only, one row per answered turn, and has `prompt_tokens`/`total_tokens` since Phase 12's playground work. So the real design question is whether to meter off `conversations` or give usage its own table, and that belongs in the design step.

---

### Q5. The response is lost and the client retries. How do you charge once, not twice?

**Your answer:** "so we will use the idempotency key, in ask api"

**Score: SHAKY.** You named the right concept, but none of the mechanism. An idempotency key is a promise with four moving parts, and the second is the part people get wrong:

1. **Who creates the key: the client, before the first attempt.** It's generated once (a UUID) and **reused unchanged on every retry** of that same logical request. If the server generated it, a retry would get a new key and look like a new request, which defeats the purpose.
2. **The server makes duplicates impossible, not merely unlikely**: `UNIQUE (workspace_id, idempotency_key)` on the usage-events table (or on the request record). A "check first, then insert" isn't enough for the same reason it wasn't in Phase 3's duplicate uploads and the invitations' partial index: two concurrent retries both pass the check. The constraint is the guarantee; a pre-check is only there to give a friendlier error.
3. **A retry gets the *original* response back, not an error.** The client retried because it never saw the result. Answering "duplicate, 409" leaves it just as blind. Stripe's API (the standard reference for this pattern) stores the first response and replays it for any retry with the same key.
4. **Keys expire.** Stripe keeps them 24 hours. Keeping them forever grows without limit, and the retry window is minutes anyway.

**A subtlety that matters for Anchor specifically.** The widget talks over a Socket.IO connection, not HTTP, and a reconnecting socket that re-sends a message is a retry too. And the Phase 14 cache means a retried question is often a cache hit, so even a double-charged retry would cost *you* nothing. The customer would still be billed twice, though, and that's the thing the key prevents.

---

### Q6. Should a Phase 14 cache hit (no Gemini call, 0 tokens) be billable?

**Your answer:** "customer is paying for the service… he doesn't care how we are doing it so even on cache hit we must charge user but usage event should be less costly, and here we are charging for the infra costs"

**Score: SHAKY.** You took a clear position with a real reason: the customer is buying the *outcome*, not your cost structure. That's a legitimate product stance, and it's what most SaaS pricing does. The answer mixes two different billing models without noticing, though, and the question asked for both sides.

**The two models your answer mixes:**
- **Value-based unit: "per answer" (or per resolved conversation).** The customer got an answer, so they're charged. A cache hit is billable, at the same price, and the cache is *your* margin improvement. It's simple to explain and stable for the customer ("my bill doesn't change because you got more efficient").
- **Cost-based unit: "per token".** The customer is charged for resources consumed. A cache hit consumed 0 tokens, so it's free. It's transparent, but it passes your cost volatility to them, and it means your caching work lowers your revenue.

"Charge on a cache hit, but less" is a third, hybrid option, and it is used in the real world. OpenAI and Anthropic both bill cached *prompt* tokens at a discount. It's a pricing decision, not a technical one.

**The side you didn't argue** (the question asked for both):
- **Against charging:** if customers can *see* the cost (the playground shows `0 tokens · cached`), charging full price for a zero-cost response can feel like overbilling once they notice. And if your published unit is tokens, charging for a zero-token response is simply inconsistent with your own terms.
- **The technical consequence either way:** the meter must record **what happened** (`cache: hit`, `tokens: 0`), not **what to charge**. Pricing is applied later, when usage is added up. Then this question can be answered or changed without touching the meter, and without losing history (Q4 reason 3).

---

### Q7. Writing the usage event: (a) in the same transaction as the `conversations` row, (b) after it commits, (c) a Redis counter. Which can lose usage, double-count it, or neither?

**Your answer:** "i think b option"

**Score: UNKNOWN.** No reasoning was given, and (b) is the one option here that can *silently lose* billable usage, so this gets taught from first principles.

**The mental model.** Ask of each design: "if the process dies at the worst possible instant, what state is left behind?"

**(a) Same transaction as the conversation row: neither lose nor double.**
```
BEGIN
  INSERT INTO conversations (...)
  INSERT INTO usage_events (...)
COMMIT          ← both exist, or neither does
```
A crash anywhere before `COMMIT` rolls back both. There's no instant where the answer was recorded but the usage wasn't. That's the same atomicity guarantee Phase 6's chunk-replace transaction was *tested* to provide. A retry can still double-count, but that's what the idempotency key (Q5) is for. **This is the correct default whenever the usage and the thing being billed live in the same database.**

**(b) Separate write after commit: can LOSE.**
```
COMMIT conversations   ← the answer is saved, the customer received it
   ✗  process crashes here: OOM, deploy restart, pod eviction
INSERT usage_events    ← never runs
```
The customer got the service and there's no charge. Nothing errors and nothing retries; it's gone. Worse, you'd never find out, because a missing row looks exactly like "this didn't happen". It's the Phase 13/14 lesson again: **the dangerous bug is the one that degrades a result instead of raising an error.** The window is milliseconds wide, but at scale milliseconds happen thousands of times a day.

**(c) A Redis counter: can LOSE and can DOUBLE.**
- *Lose:* Redis is memory-first. Anchor's container runs with no persistence tuning, and `FLUSHALL`, eviction, or a restart without AOF wipes the numbers. That's the same "LRU could evict the counter" reasoning that put Phase 14's `knowledge_version` in **Postgres, not Redis**.
- *Double:* `INCR` then crash before responding, then the client retries, then another `INCR`. There's no key to dedupe against.
- *Not atomic with Postgres:* the conversation commits and the `INCR` fails (Redis is down). That's the same "anything you stop waiting for may still happen" problem Phase 14's `docker pause` showed, in reverse.

Redis counters are right for **rate limits** (approximate, disposable) and wrong for **meters** (exact, durable). It's Q1's table made concrete.

**When (a) isn't possible,** for example because the billing system is a different service with its own database, the industry answer is the **transactional outbox**. You write an "event to publish" row in the *same* transaction as the business change, and a separate worker delivers it with retries. It's what the invitations work flagged as the future fix for its enqueue-after-commit gap, and it's why, in this project, the Phase 16 Stripe usage report will be (a) followed by an outbox, not (b).

---

### Q8. Totals over millions of events for an invoice: when does `SUM` at invoice time break, what replaces it, and what happens when a late event arrives for a period already summed?

**Your answer:** "so we can generate invoice after the month has ended like on the 1st date of next month so in this way we will be safe from after summed thing"

**Score: UNKNOWN.** Waiting until the period has closed is a real part of the answer, and usage systems do it. But it doesn't address the first half (scale), and it doesn't make late events go away; it only moves the question to "how late is too late?".

**Part 1: when `SUM` over raw events breaks.** Summing on read is correct and fine at small scale: an index on `(workspace_id, created_at)` turns "this workspace's September" into a range scan. It breaks when:
- **the dashboard asks constantly.** A usage chart that re-sums a million rows on every page load, for every workspace;
- **the numbers are asked across all tenants at once.** Month-end invoicing for every workspace is one enormous scan, all at the same moment;
- **you need it fast at request time.** The quota check (Q11) happens *on every request*, so a `SUM` in the request path is a latency and load problem that grows with usage.

**What replaces it: rollups (pre-aggregation).** A table like `usage_daily (workspace_id, day, metric, quantity)`, maintained incrementally or by a scheduled job. Invoices and charts read about 30 rows per workspace instead of a million. Phase 18 ("analytics rollups") is where this project builds the scheduled version. The raw events stay; they're the source of truth that the rollup can always be rebuilt from, and that's precisely Q4's recomputability argument.

**Part 2: late events are normal, not rare.** Examples: a queue retry lands 4 minutes after midnight; a job ran just before midnight and committed just after; the event carries the time the *work happened*, but it was written later. The standard toolkit:
1. **Two timestamps.** `occurred_at` (when the usage happened, which is what's billed) and `recorded_at` (when the row was written). Periods are assigned by `occurred_at`.
2. **A grace period (a watermark).** Don't finalise September at 00:00 on 1 October. Finalise it after a delay, say 24–72 hours, once late arrivals have stopped. Your "wait until the 1st" is this idea with a zero-length grace period, which is too short.
3. **After finalising, never edit the closed invoice.** An issued invoice is a legal document. A late event for a closed period becomes an **adjustment** on the *next* invoice ("+3 answers from September"). Stripe models this directly.

---

### Q9. What should a 429 carry, and what should the client do?

**Your answer:** "wait and try again after 1 min"

**Score: SHAKY.** Waiting and retrying is the right behaviour. What's missing is **how the server tells the client how long to wait**, and **why "wait exactly 1 minute" is dangerous**.

**What the response should carry:**
- **`Retry-After: <seconds>`** (a standard HTTP header, RFC 9110). The server *knows* when the window resets, so the client shouldn't guess.
- **`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`** (the IETF draft; GitHub uses `X-RateLimit-*`). These go on **every** response, not just the 429, so a well-behaved client can slow down *before* being refused.
- A body saying which limit was hit (per-workspace, per-key, per-IP).

**What the client should do, and why a fixed wait is wrong.** If 1,000 clients all get limited at the same moment and all wait exactly 60 s, they all come back at the same moment and all get limited again. That's a synchronised stampede, the *thundering herd*, the same shape as Phase 14's cache stampede. The fix is:
1. **Respect `Retry-After`** if present.
2. Otherwise **exponential backoff**: wait 1 s, 2 s, 4 s, 8 s…
3. **Plus jitter**: randomise each wait (e.g. a random value between 0 and the backoff), so retries spread out instead of lining up. AWS's "Exponential Backoff and Jitter" article is the canonical reference.
4. **Cap the attempts**, then give up and surface the error.

BullMQ's own retry backoff (Phase 4) is exactly this on the server side. The client side needs the same discipline.

---

### Q10. With 3 API instances, where must the rate-limit counter live? What did Phase 14's limiter do when Redis stopped responding, and what's the effective limit across 3 instances?

**Your answer:** "so it will be in redis which will be shared to all three instances, if redis is down we will allow all the req no rate limit"

**Score: SHAKY.** The first half is right. A counter in each instance's memory would let a client get `limit` from *each* instance the load balancer sends it to, so the count must be in one shared place, and here that's Redis.

The second half describes a design you **didn't** choose. On 2026-09-28 you decided "fail open", and it was implemented as **fail open to a weaker limit, not to no limit**. Read `FixedWindowRateLimiter.hit()`: when the Redis call throws or times out (250 ms), it calls `hitLocal(key)`, which is a per-process `Map` counter with the same limit and window.

**The effective limit across 3 instances while Redis is down: up to 3 × limit.** Each instance enforces `limit` on its own count, and a client whose requests are spread across all three can get `limit` from each. It's not unlimited: an attacker who *causes* a Redis outage still hits a wall, just a higher one. The class's own comment says exactly this: "N instances allow N × limit — but protection degrades rather than vanishes."

This is worth rereading, because the design comes straight from your own decision, and it isn't the obvious one. That's the kind of detail an interviewer probes: "what happens when your limiter's store is down?" "It allows everything" is the answer that gets a follow-up about attackers.

---

### Q11. A free-trial workspace gets 500 answers a month. Check before or after running the pipeline? What goes wrong with two requests at 499?

**Your answer:** "no free trial will be just for 7 days only one per month quota and we will use locking mechanism if two req came at 499"

**Score: SHAKY.** Two useful things here. First, product information (recorded below). Second, "a locking mechanism" is the right *family* of fix: something must serialise the check. What's missing is the before/after answer, the precise race, and the cheapest mechanism.

**Product decision recorded:** the free trial lasts **7 days**. The rest of the sentence ("only one per month quota") I read as "a trial workspace gets one allowance for its period". I'll confirm the exact trial allowance with you in the design step rather than guess.

**Before or after?** Both, doing different jobs:
- **Before**: *enforcement*. The pipeline costs real money (embedding and generation), so a workspace that's already out of allowance must be refused *before* the Gemini calls happen. Checking only afterwards means you've already paid for the answer you're refusing to show.
- **After**: *recording*. The usage event is written once you know it succeeded, and with what cost (tokens, cache hit or not).

**The race at 499:**
```
request A: reads used = 499 → 499 < 500 → allowed ─┐
request B: reads used = 499 → 499 < 500 → allowed ─┤ both ran the pipeline
                                                    └→ used = 501
```
It's a check-then-act race: the same shape as Phase 12's claim, Phase 3's duplicate upload, and the last-owner write skew.

**The fixes, cheapest first:**
1. **An atomic reservation.** Turn "check then increment" into one statement that only succeeds if there's room:
   ```sql
   UPDATE workspace_quota SET used = used + 1
   WHERE workspace_id = $1 AND used < allowance
   RETURNING used;            -- 0 rows → refused
   ```
   It's the same atomically-conditional `UPDATE` as Phase 12's claim: the condition lives on the row being written, so no explicit lock is needed. In Redis the equivalent is a small Lua script doing "INCR only if below the limit".
2. **Reserve, then settle.** Reserve one unit before the pipeline; if the pipeline fails or is refused, **release** it. Otherwise a Gemini outage would burn a customer's allowance for answers they never got.
3. **Or accept a bounded overshoot.** Many real products *allow* going a little over (a soft limit) rather than paying for strict serialisation on every request. It's a product call: "500" versus "about 500".

A lock (`SELECT … FOR UPDATE`) works too, but it holds a row lock for the whole pipeline (seconds, while Gemini runs), so every request in that workspace queues behind it. The conditional update holds its lock for microseconds.

---

### Q12. "Usage for September": which timezone, which column type, and which bug from this project shows why it matters?

**Your answer:** "dont know"

**Score: UNKNOWN.** And the bug in question is one this project already paid for.

**The bug:** Phase 13's full-suite run found every agent-console wait time was **minus five hours**. JavaScript `new Date()` values were written into `timestamp without time zone` columns (node-postgres writes the *host's local wall clock*, PKT, UTC+5) and compared against Postgres `now()` (UTC). That's 18,000 seconds of skew. A `GREATEST(..., 0)` clamp hid it. The rule the project adopted afterwards: **every server-set timestamp is written with `now()`**, and **new tables use `timestamptz`**. The invitations table was the first to follow it.

**Why billing makes this worse than a wrong wait time:** a usage event at 23:30 UTC on 30 September is **04:30 on 1 October in Pakistan**. Store it in a plain `timestamp` column from a JS `Date` on this machine, and it lands in **October's** bill. A 5-hour skew moves the last 5 hours of every month into the wrong invoice, silently, for every customer.

**The three separate decisions:**
1. **Column type: `timestamptz`.** It stores an absolute instant, so it doesn't matter which clock or client wrote it.
2. **Written by: `now()`**, or whatever time the *work happened* (`occurred_at`, Q8), never a client-supplied time.
3. **Period boundaries.** Two defensible answers, and this one is a product decision for Phase 16:
   - **UTC calendar months**: simple, and every tenant is on the same boundaries. Many B2B APIs do this.
   - **The subscription's own billing anchor.** Stripe bills from the **date the subscription started**. A plan bought on the 14th renews on the 14th, so "September usage" means 14 Sep to 14 Oct, not 1–30 Sep. Since Phase 16 bills fixed plans monthly, quarterly and yearly through Stripe, **the meter must be able to sum over an arbitrary `[start, end)` range**, not only a calendar month. That's another reason to store raw events with precise timestamps rather than pre-bucketing everything by month.

Also note **`[start, end)`, half-open.** An event at exactly midnight must land in exactly one period, never both and never neither. `created_at >= start AND created_at < end` is the only correct form; `BETWEEN` includes both ends and double-counts the boundary instant.

---

## Topics you must know before moving on (ranked by how load-bearing each is)

1. **Rate limit vs quota vs meter** (Q1). Every other design choice in the phase follows from which of the three a piece of code is. Getting it wrong puts money in Redis or refuses requests from the meter.
2. **Where the event is written, and what a crash leaves behind** (Q7). Atomic-with-the-business-row as the default, outbox when it can't be. This is the difference between an invoice that's right and one that's silently low.
3. **Idempotency keys as a mechanism** (Q5): client-generated, a `UNIQUE` constraint as the guarantee, the original response replayed.
4. **Atomic reservation for quotas** (Q11): conditional update, reserve then settle, release on failure.
5. **`timestamptz`, `now()`, half-open periods** (Q12): this project already shipped the bug once.
6. **Events as the source of truth, rollups as a cache of them** (Q4, Q8), including late events and adjustments.
7. **Algorithm choice: fixed window vs sliding window vs token bucket** (Q2, Q3), and what each costs.
8. **What a 429 carries, and client backoff with jitter** (Q9).
9. **Distributed limits and degraded modes** (Q10): shared store, and the N × limit fallback you chose.

---

## Architecture and decisions (agreed 2026-09-30)

```
POST /ask  or  widget "message"            (optional client idempotency key)
     │
     ▼
① Rate limit — token bucket, per workspace (/ask) and per publicKey (widget).
     Redis Lua, atomic; fails open to a per-instance bucket (the Phase 14 decision).
     Over → 429 + Retry-After + RateLimit-* headers   (widget: 'rate-limited' event)
     ▼
② Idempotency — (workspace, key) already answered? → replay the stored answer.
     ▼
③ Quota reserve — UPDATE workspace_quotas SET used = used + 1
                   WHERE workspace_id = $1 AND used < allowance AND now() < period_end
     0 rows → quota exhausted, no Gemini call
     ▼
④ Answer pipeline (cache → retrieval → generation), unchanged
     ├─ outcome not billable (escalated by our failure) → refund the unit
     ▼
⑤ ONE transaction: INSERT conversations + INSERT usage_events
```

**Product decisions (the user's, 2026-09-30):**
- **Free trial: 7 days, 200 answers.** A `workspace_quotas` row is created at registration.
- **Billable, and counted against the allowance: `answered` and `refused`. Cache hits count** (value-based pricing: the customer bought an answer, not our cost structure; consistent with the user's Q6 answer). **`escalated` doesn't count.** In this system an escalation is caused by a generation failure, which is our failure, not the customer's usage.
- **Over quota, the widget hands off to a human.** The end-customer is never told anything about the business's billing state. The conversation escalates, so the business still receives it.
- **The Frontend "Usage & cost" page is built** as the final increment, after the backend.

**Engineering decisions and their alternatives:**

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Meter store | Postgres `usage_events`, in the same transaction as the business row | A Redis counter: lost on flush, double-counted on retry (Q7) |
| Quota counter | Postgres conditional `UPDATE` on `workspace_quotas` | Redis Lua (faster, but must reconcile after a flush); `FOR UPDATE` (holds a lock across the Gemini call) |
| Quota vs bill | The quota is a **derived gate**, recomputable from `usage_events`; a crash can leak one unit (the customer is refused one answer early), never a charge | Treating the quota counter as the bill |
| No quota row | Unlimited (pay-as-you-go). Phase 16 creates rows from plans | Default-deny, which would break every workspace created before this phase |
| Rate-limit algorithm | Token bucket (new `TokenBucketRateLimiter`), same fail-open-to-local behaviour | Fixed window, because of the 2× boundary burst (Q2). The login throttle keeps its fixed window: bcrypt already makes a burst harmless |
| Embedding metering | One event per chunk, in the chunk's embedding transaction; key = chunk id (reprocessing creates new chunk ids, so it's billed again; a retried job is not) | Per document: bills chunks a partially failed job never embedded |
| Totals | `SUM` on read over `(workspace_id, occurred_at)`, half-open `[from, to)` | Rollups, deferred to Phase 18 |
| Pricing | Not stored on events; applied when usage is totalled (Phase 16) | Price on the event: a price change would rewrite history |
## Complete data flow

### An answer (dashboard `POST /ask`, or a widget `message`)

```
1. JwtAuthGuard → WorkspaceGuard → PermissionsGuard(knowledge.query)      [dashboard only]
2. AskRateLimitGuard          token bucket ask:{workspaceId}, burst 20, 20/min
                              → sets RateLimit-* on the response; over → 429 + Retry-After
   (widget: WidgetRateLimitGuard — widget-session:{key}:{session} then widget-site:{key};
    over → 'rate-limited' {retryAfterSeconds}, message dropped)
3. AnswerService.answer(ws, question, sessionId, idempotencyKey)
   a. idempotencyKey (user:{id}:… or session:{id}:…) already in conversations?
        → findReplay(): stored answer + tokens from its usage event, replayed: true. STOP.
   b. QuotaService.reserve(ws)   UPDATE … SET used = used + 1 WHERE … used < allowance
        reserved  → continue          unlimited (never had a row) → continue
        exhausted / expired → throw QuotaExceededException (402)
          widget catches it → escalateUnanswered(…, 'quota_exhausted') → handoff message
   c. produce(): cache → retrieval → generation (Phases 8–14)
        retrieval throws (embedding outage) → escalated, reason retrieval_failed
        generation throws                    → escalated, reason generation_failed
   d. persistAndReturn — ONE transaction:
        INSERT conversations (… idempotency_key)
        INSERT usage_events  (metric answer, billable = isBillableAnswer(status),
                              key conversation:{id}, attributes {status, cache, tokens, model, reason})
        UNIQUE(workspace_id, idempotency_key) violated → a concurrent same-key request won:
          this transaction rolls back entirely; return the winner's answer (replayed)
      after commit: escalation → HandoffService.recordEscalation (broadcasts to agents)
   e. refund the reserved unit if: the request threw, the outcome is not billable
      (escalated), or the result is a replay
4. Widget only: toPublicAnswer() — answer, status, citations {index, documentId, filename}
```

### A document's embeddings

```
DocumentEmbeddingProcessor, for each chunk still missing an embedding:
  embed (Gemini) → ONE transaction:
     UPDATE document_chunks SET embedding = … WHERE id = $1 AND embedding IS NULL  → filled?
     filled → INSERT usage_events (chunk_embedded, key chunk:{chunkId}, ON CONFLICT DO NOTHING)
```

### A registration

```
bcrypt (outside the transaction) → ONE transaction: user, workspace, owner membership,
workspace_quotas trial row (200 answers, [now, now + 7 days), source 'trial')
```

### The usage report (`GET /workspaces/:id/usage?from&to`, `usage.view`)

```
QuotaService.status → default range = the allowance period (else last 30 days)
validate [from, to): to > from, ≤ 366 days
totals: one SELECT … count(*) FILTER (…) over usage_events
daily:  generate_series of UTC days, capped at today, LEFT JOIN usage_events
rateLimit: ASK_LIMIT + TokenBucketRateLimiter.peek(ask:{id}) — reads, never takes
```

---

## Migrations: what each table and column stores

### `CreateUsageMetering` → table `usage_events` (the meter)

One row per unit of metered work. Append-only: the application never updates or deletes a row. **It's the source of truth billing is computed from.** Quotas and the usage page are derived from it.

| Column | What it stores |
|---|---|
| `id` | `bigserial`. The one table here that can plausibly outgrow 2³¹ rows. node-postgres returns it as a string, since a JS number can't hold every 64-bit value. |
| `workspace_id` | Whose usage. `ON DELETE RESTRICT`, deliberately unlike every other workspace-owned table, because billing history is a financial record and must not disappear as a side effect of deleting a workspace. |
| `metric` | What was used: `answer` or `chunk_embedded` (a `CHECK` limits it to these). |
| `quantity` | How many units (always 1 today; the column exists so a future batched metric doesn't need a schema change). `CHECK > 0`. |
| `billable` | Whether it counts toward billing and quota, decided **when written** from the rule in force then (`isBillableAnswer`). Escalations are recorded with `false`. |
| `occurred_at` | When the usage happened, which is what periods are assigned by. `timestamptz`, default `now()`. |
| `recorded_at` | When the row was written. Equal today; it differs when work is recorded late (a queued job), which is why it's a separate column. |
| `idempotency_key` | Identifies the unit of work: `conversation:{id}` for answers, `chunk:{id}` for embeddings. With `UNIQUE (workspace_id, metric, idempotency_key)`, the same work can never be metered twice. |
| `conversation_id` | The conversation an answer event meters. `SET NULL` if that row ever goes. |
| `document_id` | The document an embedding event belongs to. `SET NULL`. |
| `attributes` | `jsonb` raw facts: `status`, `cache`, `promptTokens`, `totalTokens`, `model`, `escalationReason` for answers; `chunkId`, `characters`, `model` for embeddings. **Never a price.** |

Index `(workspace_id, occurred_at)` serves every read, since everything is "this workspace, this time range".

### `CreateUsageMetering` → column `conversations.idempotency_key`

The client's own identifier for one request, already namespaced by the caller (`user:{id}:…` / `session:{id}:…`). `UNIQUE (workspace_id, idempotency_key)`. NULLs are distinct in a Postgres `UNIQUE`, so requests without a key are unaffected. Lives on `conversations` because the conversation row *is* the request record, and replays are read back from it.

### `CreateWorkspaceQuotas` → table `workspace_quotas` (the gate)

One allowance for one period. **A gate derived from the meter, not the bill**: `used` can always be recomputed from `usage_events` (`QuotaService.reconcile`).

| Column | What it stores |
|---|---|
| `workspace_id` | Whose allowance. `CASCADE`: unlike the meter, an allowance has no meaning once its workspace is gone. |
| `metric` | Only `answer` today (`CHECK`). |
| `allowance` | Units included in the period, e.g. 200 for the trial. `CHECK > 0`. |
| `used` | Units reserved so far. `CHECK (used >= 0 AND used <= allowance)`: the reserve statement can't exceed the allowance, and the `CHECK` makes any other code path that tries fail loudly. The break-it below shows that backstop working. |
| `period_start`, `period_end` | The half-open window `[start, end)`, `timestamptz`, with `CHECK (end > start)`. |
| `source` | Where the allowance came from: `trial` now; plan rows arrive in Phase 16. |
| `created_at` | When the row was written. |

`UNIQUE (workspace_id, metric, period_start)`, plus index `(workspace_id, metric, period_end)` for "the current period". **Semantics that must not collapse:** *no rows ever* means unlimited (pay-as-you-go); *rows, none covering now* means the trial ended, so requests are refused.

### `AddUsageViewPermission` → rows in `permissions` / `role_permissions`

Adds `usage.view` ("See usage, cost drivers and the plan allowance"), granted to `owner` only. The fourth permission added after the seed, through the same enum + migration workflow the startup drift check enforces.

---

## Code walkthrough

**`src/metering/usage-meter.service.ts`**: `UsageMeter.record(manager, event)`. It takes the *caller's* `EntityManager` on purpose: the event must be written inside the transaction of the work it meters (Q7, option a). `ON CONFLICT ON CONSTRAINT "UQ_usage_events_idempotency" DO NOTHING`, because re-recording the same unit of work is normal under at-least-once delivery and must be a no-op, not an error. `isBillableAnswer()` is the user's product rule, in exactly one place.

**`src/metering/quota.service.ts`**:
- `reserve()` is the whole quota in one statement: `UPDATE … SET used = used + 1 WHERE … used < allowance RETURNING id`. The condition lives on the row being written, so concurrent reservations serialise on that row's lock (microseconds), and each re-checks `used < allowance` after the previous one commits. It's the same shape as Phase 12's claim. Off the happy path it tells `exhausted` (a current row, full) from `expired` (rows, none current) from `unlimited` (never a row).
- `refund()` uses `used > 0`, so a refund can never go negative.
- `reconcile()` recomputes `used` from the meter for the current period (`LEAST(allowance, count of billable events in [start, end))`).
- `status()` is the read-only view for reporting.
- `QuotaExceededException` is a 402 carrying `quota_exhausted` / `trial_ended`.

**`src/modules/answer/answer.service.ts`**:
- `answer()` is now a wrapper: replay check → `reserve` → `produce()` (the old body) → refund rules.
- `persistAndReturn()` writes the conversation and its usage event in one `dataSource.transaction`. It catches `UQ_conversations_idempotency` and returns the winner's answer.
- `findReplay()` rebuilds the stored answer, with tokens from the usage event (the only place they're persisted) and `retrievedChunks: []`, because they were never stored and a replay doesn't invent them.
- `escalateUnanswered()` is for the widget's over-quota handoff.
- Retrieval is wrapped in `try/catch`: an embedding outage now escalates like a generation failure, where it used to be a raw 500.

**`src/common/rate-limit/token-bucket-rate-limiter.ts`**:
- `TAKE` is one Lua script that refills, checks and takes. It uses `redis.call('TIME')`, so every API instance shares Redis's clock, not its own. It returns numbers as strings, because Redis truncates a Lua number reply to an integer.
- The TTL is the time to refill completely plus 1 s, so an idle bucket expires.
- `PEEK` is read-only, for the usage page.
- On a Redis error or a 250 ms timeout it falls back to a per-process `Map` bucket (the Phase 14 fail-open decision), warning at most once per 10 s.
- `rateLimitHeaders()` builds `RateLimit-Limit/-Remaining/-Reset`, plus `Retry-After` only on a refusal.

**`src/common/guards/ask-rate-limit.guard.ts`**: a method-level guard on `POST /ask` only, so it runs *after* the class guards: only a member can spend, or learn anything about, the workspace's budget. It sets the headers before throwing, so they ride along on the 429.

**`src/modules/widget-chat/widget-rate-limit.guard.ts`**: two buckets. The site bucket is only charged once the visitor's own bucket allowed the message, so one noisy visitor's *refused* messages don't drain everyone else's budget. A refusal emits `rate-limited` with the wait.

**`src/modules/widget-chat/widget-chat.gateway.ts`**: `QuotaExceededException` becomes a handoff, and `toPublicAnswer()` sends only what the widget needs.

**`src/modules/documents/processing/embedding/document-embedding.processor.ts`**: `saveAndMeter()` makes each chunk's conditional embedding write and its event one transaction.

**`src/modules/auth/auth.service.ts`**: `register()` is now one transaction including the trial row.

**`src/modules/usage/usage.service.ts`**: the report.
- Totals come from one query with `FILTER` clauses.
- The daily series is `generate_series` over UTC days, **capped at today**, with a `LEFT JOIN`.
- Range resolution defaults to the allowance period, and validates the order and the 366-day cap.

**`src/common/utils/`**: `idempotency-key.ts` (validates and scopes a client key), `like-pattern.ts`, `postgres-errors.ts` (`isUniqueViolation` matches the constraint *name*, not just the code).

**`test/helpers/reset-database.ts`**: now also clears the Redis keys derived from ids it restarts (`ask:*`).

**Widget** (`Widget/src/socket.ts`): a per-message `clientMessageId` from `crypto.getRandomValues`, not `randomUUID`, which only exists in secure contexts and would have stopped messages sending on plain-HTTP customer sites. It shows the `rate-limited` wait.

**Frontend** (`features/usage/`): `UsagePage` (tiles, allowance and forecast, breakdown, cache, rate limits, reconciliation marked Soon), `DailyUsageChart` (SVG, hover tooltip, table view), `format.ts` (UTC dates). The `--chart-1` token was validated with the dataviz palette checker, and the dark accent failed, so it uses a darker step. The sidebar link is gated on `usage.view`.

---

## Failure cases actually tested

Each was predicted, triggered and observed. "Premise check" means the protection was deliberately removed to prove the test can fail.

1. **A meter failure must not leave an answer behind.** The meter was made to throw: a 500, with **0 conversations and 0 events**. *Premise:* with the transaction replaced by plain writes, the same failure left **1 conversation with no usage event**, an answer that would never be billed.
2. **Concurrent requests with one idempotency key.** 5 at once gave 5 × 201, **one** answer, one conversation, one event. *Premise:* without the duplicate-key handling, 4 of 5 got a **500**. The constraint alone already prevents the double charge; the handling is what gives retries the original answer.
3. **Two workers on one embedding job.** Gemini was called **6** times and **3** chunks were charged. *Premise:* each layer alone (the `IS NULL` guard, the chunk key) still gives 3; with **both** removed, 6 chunks were charged.
4. **The quota race:** 20 concurrent requests with 10 units left.
   - The real code: exactly **10 × 201, 10 × 402**, used = 500.
   - *Premise:* naive check-then-increment with the `CHECK` kept: no overspend, but **10 crashed with a 500** at the constraint.
   - Naive, with the `CHECK` dropped: **all 20 served** on 10 units.
5. **Registration failing half-way.** The trial insert was made to throw: no user, workspace or membership left behind. Before this phase that would have left a workspace with *no* quota rows, which means free unlimited usage.
6. **A token bucket that isn't atomic.** *Premise:* the Lua script replaced by read → compute → write in JavaScript: **50 of 50** concurrent requests allowed, each seeing "remaining 9".
7. **The fixed-window boundary burst, measured:** limit 5, the fixed window accepted **10 inside a second**; the token bucket didn't.
8. **Redis frozen (`docker pause`) under a live `/ask` on the dev server:**
   - Every request **answered** (201).
   - Headers came from the per-instance fallback (19 → 18 → 18).
   - Postgres metered all 4 (quota 85 → 89, events 94 → 98).
   - The limiter warned once.
   - **After unpausing, the Redis bucket held 17, where a bucket that never saw the paused requests would have refilled to 20**: the three timed-out `take()` commands executed when Redis woke up, so those requests were counted twice, by the fallback and by Redis. This is the Phase 14 lesson that a timeout doesn't cancel a sent command, now measured on a rate limiter. It errs in the safe direction (briefly stricter, never looser) and isn't fixable without cancelling sent commands, which Redis can't do.
   - Latency **not established**: the baseline was the server's first, cold request.
9. **Found by tests or the browser, not predicted:**
   - LIKE-pattern escaping was broken, so every search containing `%` matched nothing (caught by the `100%` test).
   - The `/ask` bucket leaked between test suites through reused workspace ids.
   - A token-bucket test with a 50 ms refill interval failed under load.
   - The usage chart drew **future days as zero usage**; the series is now capped at today.
   - The chart's resize observer went stale after switching to the table view.
   - The widget was broadcasting full `AnswerResult`s to anonymous visitors, including snippets of documents an answer *didn't* cite.

---

## Tests and why each exists

| Suite | What it proves |
|---|---|
| `test/usage-metering.e2e.spec.ts` (11) | Each outcome is metered with the right `billable`, cache hits included; the meter is atomic with the conversation; replays charge once, also concurrently; keys are scoped per caller; malformed keys are rejected; widget `clientMessageId` dedupes |
| `document-embedding.processor.spec.ts` (+4) | One event per chunk; exactly once across a failed attempt and its retry; once with two concurrent workers; a reprocessed document is billed again |
| `test/quotas.e2e.spec.ts` (13) | Trial row created with the workspace, atomically; what consumes and what refunds; graceful retrieval failure; replay doesn't consume; 402 before any work; ended trial ≠ unlimited; the concurrency race; reconcile repairs a leak; the widget hands off without mentioning billing; the widget payload has no internals; the per-visitor and per-site buckets |
| `token-bucket-rate-limiter.spec.ts` (8) | Burst then refusal with the right wait; continuous refill; no boundary burst compared with the fixed window; atomic under 50 concurrent; idle TTL; fail-open with Redis hanging; headers; `peek` spends nothing |
| `test/ask-rate-limit.e2e.spec.ts` (3) | Headers on every response; 429 + `Retry-After` and **no quota consumed**; `/ask/config` unaffected |
| `test/usage-report.e2e.spec.ts` (9) | Half-open boundaries to the millisecond; breakdowns; zero-filled UTC days (an event at 23:30 UTC lands on the right day); the default period and quota; ended vs unlimited; isolation; validation; owner-only; no future days |
| `test/permissions.e2e.spec.ts` (+3) | `usage.view` in the role matrix |

---

## Reverse-engineering guide (reopening this in six months)

- **"Why was this customer billed N?"** `SELECT * FROM usage_events WHERE workspace_id = … AND occurred_at >= … AND occurred_at < …`. Every row links to its conversation or document, and `attributes` holds the facts. The meter is the answer, never `workspace_quotas.used`.
- **"A workspace says it's out of answers but shouldn't be."** Compare `workspace_quotas.used` with the billable event count for the period, then run `QuotaService.reconcile()`. A leak (a crash between reserve and commit) only ever errs toward refusing early.
- **Changing what's billable** means changing `isBillableAnswer()`. That affects *future* events only. Re-pricing history is a deliberate operation on the `attributes`, which is why they're kept raw.
- **Changing limits:** `ASK_LIMIT`, `WIDGET_SITE_LIMIT`, `WIDGET_SESSION_LIMIT` (burst and refill). `TRIAL` holds the trial's length and size.
- **Adding a metric:** extend the `CHECK` on `usage_events.metric` with a migration, write it with `UsageMeter.record` **inside the transaction of the work it meters**, pick an idempotency key that names the unit of work, and add it to the report's `FILTER`s.
- **Debugging a stuck rate limit:** `HGETALL ask:{workspaceId}` in Redis shows `tokens` and `ts` (Redis's clock, in ms). Deleting the key gives the workspace a full bucket.
- **A test seeing unexpected 429s** means something left an `ask:*` bucket drained. `resetDatabase()` clears them; a suite that doesn't use it must clear them itself.

---

## Closing quiz (2026-10-01): not attempted, explanations requested

**Score: not scored.** The user asked for every answer to be written out rather than attempting the questions ("I don't know anything about how we are doing it"). Recorded as such, not as UNKNOWN across the board. That would claim a measurement that wasn't taken. **Suggested, the user's call:** after reading this, a short re-quiz of five of these questions in their own words, since the pattern across Phases 2, 4, 11 and 14 is that understanding from reading and understanding from explaining come out differently.

---

### First: the whole phase as one story

Picture Anchor as a **restaurant that bills by the meal**.

- The **meter** (`usage_events`) is the **till receipt roll**: every dish served is printed on it, in order, and nothing is ever erased. At month-end, the bill is the receipt roll added up. That's all billing is.
- The **quota** (`workspace_quotas`) is a **meal plan card**: "this table gets 200 meals this week." A waiter checks the card *before* cooking. The card is for deciding whether to cook, **not** for billing. If the card and the receipt roll ever disagree, the receipt roll is right, and the card gets corrected from it.
- The **rate limit** (the token bucket) is the **kitchen's pace rule**: "one table can't order 50 dishes in the same minute." Its job is to protect the kitchen (shared Gemini capacity), not to bill. It can be approximate.

Three different jobs, with three different stores and three different failure responses. Almost every design choice in this phase follows from keeping them apart.

**What happens to one question, start to finish:**

1. **Pace check.** Is this workspace asking too fast? If so, `429 Too Many Requests` with "retry in N seconds". Nothing else happens, and nothing is charged.
2. **"Have I already answered exactly this request?"** If the client sends the same request id again (because its first response got lost), we hand back the *stored* answer. We don't cook it again and don't charge again.
3. **Meal-plan check.** Reserve one unit from the allowance, in one atomic step. If there's none left: `402 Payment Required` for the dashboard, or a polite "let me connect you with the team" for a widget visitor.
4. **Cook.** Cache → retrieval → generation, the Phases 8–14 pipeline.
5. **Write the receipt in the same breath as serving.** The conversation row and its usage event are saved in **one transaction**: both exist or neither does.
6. **Give the reserved unit back if it shouldn't count**: our own failure, an error, or a replay.

Embedding a document's chunks follows the same pattern: each chunk's embedding and its receipt line are one transaction. The usage page reads the receipt roll.

---

### Q1. Rate limit, quota and meter in Anchor: where stored, what status, which builds the invoice?

| | Rate limit | Quota | Meter |
|---|---|---|---|
| **Job** | Stop "too fast". Protects shared capacity | Stop "too much this period". Protects the plan's economics | Record what was used. Protects nothing; it's the record |
| **Stored in** | **Redis**: one hash per bucket, `ask:{workspaceId}`, `widget-session:…`, `widget-site:…` | **Postgres** `workspace_quotas` (`allowance`, `used`, the period) | **Postgres** `usage_events`, append-only |
| **When exceeded** | **429** + `Retry-After` (widget: a `rate-limited` event) | **402** (widget: handoff to a human) | Never refuses anything |
| **Must be exact?** | No. During a Redis outage it degrades to per-instance counting | Close; it can be one unit off after a crash, always toward refusing early | **Yes.** It's money |

**The invoice is built from the meter**, and only from the meter:
- **Not the rate limit:** it lives in Redis, which can be flushed, evicted, or (as the break-it showed) briefly double-count during an outage. Wiping it is harmless for pacing, and would be a disaster for billing.
- **Not the quota counter:** it's a fast gate that can drift (a crash between "reserve" and "commit" leaks a unit). It's *derived from* the meter, and `QuotaService.reconcile()` ([quota.service.ts:136](../../Backend/src/metering/quota.service.ts#L136)) recomputes it from the meter.

**What this achieves:** each store gets the guarantees its job needs and no more. Redis is fast and disposable where speed matters; Postgres is durable and transactional where money matters.

**Interview line:** "Rate limits protect the service and live in Redis; quotas protect the plan and gate requests; the meter is an append-only ledger in the database, and it's the only thing billing reads."

---

### Q2. The fixed-window boundary burst, and what our test measured

**How the old limiter works** ([fixed-window-rate-limiter.ts](../../Backend/src/common/rate-limit/fixed-window-rate-limiter.ts)): `INCR` a counter. On the *first* request it also sets `EXPIRE key 60`. When the key expires, the counter is simply gone.

**The flaw:** a fixed window **forgets everything at its boundary**. Limit 5 per 1 s:

```
t = 0.00  first request → counter 1, key expires at t = 1.00
t = 0.85  4 more → counter 5            (5 accepted, all near the END of the window)
t = 1.00  key expires — Redis now remembers nothing about this client
t = 1.05  5 more → fresh counter 1..5   (5 more accepted)
→ 10 accepted between t = 0.85 and t = 1.05: twice the limit in 0.2 s
```

**Measured, not argued:** the test `does not allow the boundary burst a fixed window does` ([token-bucket-rate-limiter.spec.ts](../../Backend/src/common/rate-limit/token-bucket-rate-limiter.spec.ts)) ran exactly this. The fixed window accepted **10 inside a second on a limit of 5**. The token bucket, given the same burst, accepted only its 5 plus what had refilled.

**Why we changed algorithms for `/ask` and the widget:** a limit sold or documented as "N per minute" that actually allows 2N at boundaries is a limit customers will notice and attackers will time. **The login throttle keeps its fixed window on purpose:** bcrypt already costs ~250 ms per attempt, so a 2× burst of login guesses is harmless.

**Interview line:** "A fixed window allows up to 2× the limit around a boundary because it forgets everything when the window rolls; a sliding window or token bucket removes the boundary."

---

### Q3. The token bucket in practice: idle 10 minutes, then 30 questions at once

**The model:** a bucket holds at most **20** tokens and refills at **20 per minute** (one every 3 s). Each question takes one token. No token, no question.

**The scenario:**
- Idle for 10 minutes means the bucket refilled long ago and is **full at 20**. It's *capped* at capacity, so 10 idle minutes don't bank 200.
- 30 arrive at once: **20 succeed** and **10 get 429**.
- The next token appears **~3 s** later, so `Retry-After: 3` on the refusals. After that, one more question every 3 s, sustained.

**What this achieves:** real traffic is bursty (a promo email goes out and 20 visitors arrive in the same second), so the burst lets a genuine spike through. The cap and the steady refill keep the *long-run* rate at 20/min. Unlike a fixed window, the burst is only available if it was **earned by being idle**.

**Why Redis's `TIME`, not `Date.now()`** ([token-bucket-rate-limiter.ts:15](../../Backend/src/common/rate-limit/token-bucket-rate-limiter.ts#L15)): all API instances share one bucket. If each passed its own clock, a server whose clock runs 2 s fast would refill everyone's bucket early, and one running slow would see time go backwards. With `redis.call('TIME')` inside the script, every refill is computed against **one** clock. It's the same lesson as Phase 13's five-hour bug: decide which clock is authoritative.

**Two details in the script worth knowing:**
- The whole refill → check → take is **one Lua script**, so it's atomic (proven in Q11's sibling test: done in JavaScript instead, 50 of 50 concurrent requests got in).
- Numbers go back as **strings**, because Redis truncates a Lua number reply to an integer (0.97 tokens would come back as 0).

**Interview line:** "A token bucket has two parameters, capacity for the burst and refill rate for the sustained throughput; it's atomic in Redis via Lua, and uses the server's clock so instances can't disagree about time."

---

### Q4. Why append-only events with a unique key, not `used = used + 1`?

**What we did** ([usage-meter.service.ts:25](../../Backend/src/metering/usage-meter.service.ts#L25)): every unit of work becomes **one new row** in `usage_events`, with a key naming the work (`conversation:{id}`, `chunk:{id}`), protected by `UNIQUE (workspace_id, metric, idempotency_key)`.

**What a counter can't do, and events can:**
1. **Answer "why is my bill 4,812?"** Every row is linked to the exact conversation or chunk it bills, with its facts (tokens, cache hit, status). A counter holds a number and no history, so there's nothing to show a disputing customer.
2. **Refuse a double count.** A retried `+1` is just another `+1`. A second event with the same key **cannot be inserted**: the constraint rejects it (`ON CONFLICT DO NOTHING`).
3. **Recompute.** Pricing changed? A bug found? Rerun the totals over the events. A counter's history is unrecoverable.
4. **Avoid a hot row.** Every answer would `UPDATE` the same row, so concurrent requests queue on one lock. `INSERT`s don't contend.
5. **Any period.** "This trial", "last 7 days", "per day for the chart", all from the same rows.

**The "failing meter" test** (`never leaves a conversation without its usage event`, [usage-metering.e2e.spec.ts](../../Backend/test/usage-metering.e2e.spec.ts)): the meter was made to throw while saving.
- **With the transaction:** the request failed with a 500, and **0 conversations, 0 events** were left. Nothing was half-saved.
- **With the transaction removed** (the premise check): the same failure left **1 conversation with no usage event**. The customer got an answer that would **never be billed**, and nothing anywhere said so.

**What this achieves:** the bill can be proven, can't double-count, and can't silently lose a row.

**Interview line:** "A usage counter is unauditable and can't dedupe retries; an append-only event log with a unique key per unit of work gives you an audit trail, idempotency and recomputability."

---

### Q5. Idempotency keys: who creates it, what makes duplicates impossible, what a retry gets, why the `user:` prefix

**The problem it solves:** the client asks a question, we answer and charge, the response is lost (a flaky network, a closed laptop lid), and the client retries. Without protection, that's **two answers and two charges for one question.**

**The four parts:**
1. **The client creates it, once, before the first attempt**, and reuses it unchanged on every retry. The dashboard sends the `Idempotency-Key` HTTP header; the widget sends a `clientMessageId` with each message. If the *server* generated it, a retry would look like a new request.
2. **A duplicate is impossible because of a database constraint**, `UNIQUE (workspace_id, idempotency_key)` on `conversations`, not because of a check. A "look first, then insert" check fails when two retries arrive at the same moment: both look, both see nothing, both insert. The constraint lets exactly one win. In the concurrency test, 5 requests at once with the same key produced **1** conversation and **1** charge.
3. **A retry gets the *original* answer back** (`replayed: true`), with no pipeline run and no Gemini call ([answer.service.ts:422](../../Backend/src/modules/answer/answer.service.ts#L422), `findReplay`). Not an error: the client retried *because it never saw the answer*, so "409 duplicate" would leave it just as stuck.
4. **The `user:{id}:` (or `session:{id}:`) prefix is a security boundary** ([idempotency-key.ts](../../Backend/src/common/utils/idempotency-key.ts)). A replay *returns an answer*. Without the prefix, a colleague (or a widget visitor) who learned or guessed someone else's key could send it and **receive that person's answer**. With it, the same raw key from two callers is two separate requests (tested: `scopes keys per caller`).

**One known limit:** two *simultaneous* requests with the same key both run the pipeline before either commits. The customer is still charged once (the loser's transaction rolls back), but we may pay Gemini twice. Stopping that needs an "in progress" marker taken before the pipeline.

**Interview line:** "Client-generated key, enforced by a unique constraint rather than a check, the original response replayed on retry, and keys scoped per caller so a replay can't leak someone else's response."

---

### Q6. Cache hits: the decision, what's recorded, why no price

**The decision (yours, in the diagnostic and the design):** **a cache hit is billable.** The customer is buying an *answer*, not your cost structure. Caching is how *you* make each answer cheaper; it isn't a discount you owe them. This is value-based pricing.

**What the meter records for a hit:** a normal `answer` event with `billable: true` and `attributes: { status: 'answered', cache: 'hit', promptTokens: 0, totalTokens: 0, model: null }` (tested: `meters a cache hit as billable with zero tokens`).

**Why the event stores no price:** price is a *decision*; the event records *facts*.
- If the event said "charge $0.002", then changing a price, running a promotion, or switching the unit from "per answer" to "per 1,000 tokens" would mean **rewriting history** or living with inconsistent rows.
- With facts only (status, cache, tokens, model), any pricing rule can be applied at billing time, including retroactively for a refund or a dispute.
- It's also why the Q6 debate (should hits be cheaper?) can change later **without touching the meter**: the `cache: 'hit'` fact is already there.

**Interview line:** "Meter facts, not prices; pricing is a function applied when usage is totalled, so it can change without rewriting the ledger."

---

### Q7. Which write option we implemented, and exactly what option (b) could lose

**Implemented: option (a). The usage event is written in the same transaction as the conversation** ([answer.service.ts:345](../../Backend/src/modules/answer/answer.service.ts#L345), `persistAndReturn`):

```
BEGIN
  INSERT conversations …     ← the answer
  INSERT usage_events …      ← its charge
COMMIT                       ← both, or neither
```

**What option (b), "write the event after the commit", loses, and when:**

```
COMMIT conversations          ← answer saved, response on its way to the customer
   ✗ the process dies here     (a deploy restart, out-of-memory, a pod evicted, a crash)
INSERT usage_events           ← never runs
```

The customer received the service, and **no charge exists**. Nothing errors and nothing retries, because a *missing* row looks exactly like "this never happened". The window is milliseconds wide, but at thousands of answers a day, across every deploy, it gets hit. Lost revenue, invisible.

**Option (c), a Redis counter,** can lose (flush, eviction, a restart without persistence) *and* double-count (increment, crash before responding, client retries, increment again).

**What (a) achieves:** a crash at any instant leaves either both rows or neither. **When (a) isn't possible** (billing in a different service with its own database), the standard answer is a **transactional outbox**: write an "event to publish" row in the same transaction, and a worker delivers it with retries. That's what Phase 16 will need for Stripe.

**Interview line:** "Write the usage record in the same transaction as the work; a write-after-commit can be lost to a crash in between, silently."

---

### Q8. When `SUM` on read stops being acceptable; why the chart stops at today

**Today:** the usage report sums raw events on every request, over the index `(workspace_id, occurred_at)` ([usage.service.ts](../../Backend/src/modules/usage/usage.service.ts)). For one workspace and one month that's a fast range scan, which is fine at this scale.

**It stops being acceptable when:**
- workspaces have **millions** of events per period, and the page re-sums them on every load;
- **month-end invoicing** sums *every* workspace at once, one enormous scan;
- a check on the **request path** needs a total (the quota check avoids this by keeping a counter).

**What replaces it: rollups.** A table like `usage_daily (workspace_id, day, metric, quantity)`, filled by a scheduled job, so invoices and charts read about 30 rows instead of a million. The raw events stay as the source of truth that rollups can always be rebuilt from. Phase 18 builds this.

**Late events** (a queued job finishing after midnight) are why events carry `occurred_at` separately from `recorded_at`. They're also why a real billing system waits a **grace period** before finalising a month, and turns anything later into an **adjustment** on the next invoice rather than editing an issued one.

**Why the chart stops at today:** the "current period" for a 7-day trial ends *in the future*. The first version drew those future days as **zero bars**, and a zero bar says "nothing happened that day", which is false for a day that hasn't happened yet: it's **unknown, not zero**. That's the silent-wrong-answer shape again: no error, just a misleading result. The fix caps the daily series at today on the server ([usage.service.ts:75](../../Backend/src/modules/usage/usage.service.ts#L75)), with a test, so every consumer of the API gets it right, not just this chart.

**Interview line:** "Sum on read until scale demands it, then roll up from the raw events, which stay the source of truth; and never draw unknown as zero."

---

### Q9. A 429 from `/ask`: headers, `Retry-After`, client backoff

**What every `/ask` response carries** ([token-bucket-rate-limiter.ts:173](../../Backend/src/common/rate-limit/token-bucket-rate-limiter.ts#L173)):
- `RateLimit-Limit: 20`: the burst size.
- `RateLimit-Remaining: N`: whole tokens left after this request.
- `RateLimit-Reset: S`: seconds until the bucket is full again.
- **Only on a 429:** `Retry-After: S`.

They go on *every* response, not just refusals, so a well-behaved client can slow down **before** it's refused.

**`Retry-After` is computed from the token math:** `(1 − tokens left) ÷ refill rate`, i.e. the time until one whole token exists, rounded up to whole seconds. At 20/min that's at most ~3 s.

**How a client should back off:**
1. Honour `Retry-After` when present.
2. Otherwise use **exponential backoff**: wait 1 s, 2 s, 4 s, 8 s…
3. **Plus jitter**: randomise each wait.
4. Give up after a few attempts and show the error.

**Why a fixed "wait 60 s" goes wrong:** if 1,000 clients are limited at the same moment and all wait exactly 60 s, they **all return at the same moment** and are all limited again. It's a synchronised stampede (the "thundering herd"), the same shape as Phase 14's cache stampede. Jitter spreads them out.

**Interview line:** "Send RateLimit-* on every response and Retry-After on the 429; clients use exponential backoff with jitter so retries don't arrive in lockstep."

---

### Q10. Redis frozen: what the limiter does, the 3-instance limit, why 17 not 20

**What it does** ([token-bucket-rate-limiter.ts:108](../../Backend/src/common/rate-limit/token-bucket-rate-limiter.ts#L108)): every Redis call is given **250 ms**. On a timeout or error it **fails open to a per-instance bucket**, an in-memory one inside that API process with the same limits, and logs a warning at most once per 10 s. That was your Phase 14 decision: keep the service available, but keep *some* limit, never none.

**Effective limit with 3 instances: up to 3 × the limit.** Each process enforces its own bucket, and a client whose requests are spread by the load balancer can get a full burst from each. Weaker, but **never unlimited**, so an attacker who causes the outage still hits a wall.

**Why 17 instead of 20 after unpausing.** We measured this on the live dev server:
- **Before the freeze:** the shared bucket held **19** (one request taken).
- **During the freeze:** three requests each sent their `take()` to Redis, waited 250 ms, gave up, and used the local bucket instead. **But the commands had already been sent**, and a client-side timeout doesn't recall a command (Phase 14's lesson). They sat in Redis's input queue.
- **On unpause:** Redis executed all three at once. Over ~7 s the bucket would have refilled from 19 to its cap of 20, and the three late takes brought it to **17**.
- **So those three requests were counted twice:** once by the local fallback during the outage, and again by Redis afterwards.

**Why we accept it:** it errs in the safe direction (briefly *stricter*, never looser), it refills within a minute, and preventing it would mean cancelling already-sent commands, which Redis can't do. It's recorded under Known limits.

**Interview line:** "The limiter fails open to per-instance buckets, so N instances allow N× the limit, not unlimited; and timed-out commands still execute later, so state after an outage can lag reality."

---

### Q11. The quota race: the SQL, why no lock, what the naive version did

**The SQL** ([quota.service.ts:95](../../Backend/src/metering/quota.service.ts#L95)):

```sql
UPDATE workspace_quotas SET used = used + 1
WHERE workspace_id = $1 AND metric = 'answer'
  AND period_start <= now() AND now() < period_end
  AND used < allowance
RETURNING id;            -- a row back = reserved; no row = refused
```

**Why no explicit lock is needed:** the condition (`used < allowance`) is on **the same row** the statement updates. Postgres takes that row's lock for the `UPDATE`. A second concurrent reservation **waits** for the first to commit, then **re-checks the condition against the new value**. So "check" and "increment" can't be split by another request. The lock is held for microseconds, not across the seconds Gemini takes. It's the same shape as Phase 12's claim.

**The break-it:** 20 concurrent questions with 10 units left.

| Reservation method | What happened |
|---|---|
| **The atomic `UPDATE` above** | Exactly **10 × 201** and **10 × 402**. `used` = allowance |
| **Naive "read `used`, then increment", `CHECK` kept** | All 20 read "490 < 500" and passed. The database's `CHECK (used <= allowance)` **refused 10 of the increments**, so there was no overspend, but those 10 requests **crashed with a 500** instead of getting a clean 402 |
| **Naive, `CHECK` dropped** | **All 20 served** on 10 units of allowance |

**What this achieves, and the layering lesson:**
- The atomic statement makes the **correct** outcome also the **clean** one.
- The `CHECK` constraint is a **backstop**: if some other code path ever gets the logic wrong, the database turns a silent overspend into a loud error.

**Interview line:** "Do check-and-increment as one conditional UPDATE so the row lock serialises it, and keep a CHECK constraint as a backstop so a bug elsewhere fails loudly instead of overspending."

---

### Q12. Ended trial vs unlimited; why registration became one transaction

**The distinction** ([quota.service.ts](../../Backend/src/metering/quota.service.ts), `reserve`):
- **Never had a quota row** means **unlimited** (pay-as-you-go; nothing to enforce).
- **Has had rows, but none covers now** means the **trial ended**, so refuse with `402 trial_ended`.

Both cases look the same if you only ask "is there a *current* row?". Treating them the same would turn **every expired trial into free unlimited usage**, a fail-open-by-accident bug that costs real money. So `reserve()` asks a second question when there's no current row: has there *ever* been one?

**Why registration had to become one transaction** ([auth.service.ts:60](../../Backend/src/modules/auth/auth.service.ts#L60)): `register()` used to save the user, the workspace and the membership as **three separate writes**. Adding the trial row as a fourth separate write opened a hole: crash after the workspace is saved but before the trial row, and you have a workspace with **no quota rows at all**, which by the rule above means **unlimited**. Now all four writes are one transaction: all or nothing. Tested by making the trial insert fail: no user, workspace or membership was left behind.

**What this achieves:** no sequence of crashes can create a free-forever workspace.

**Interview line:** "Absence of a record often has two meanings; make them distinguishable, and create the records that define a limit atomically with the thing they limit."

---

### Q13. Embedding metering: the two layers, why the chunk id, what's still paid twice

**Where:** `saveAndMeter()` ([document-embedding.processor.ts:97](../../Backend/src/modules/documents/processing/embedding/document-embedding.processor.ts#L97)) runs one transaction per chunk:

```sql
UPDATE document_chunks SET embedding = … WHERE id = $chunk AND embedding IS NULL   -- layer 1
-- only if that filled the chunk:
INSERT INTO usage_events (…, idempotency_key = 'chunk:{id}') ON CONFLICT DO NOTHING -- layer 2
```

**The two independent layers:**
1. **The conditional `UPDATE`**: it only fills an embedding that's still empty, and reports whether it did. Only the run that filled it goes on to meter it.
2. **The idempotency key** `chunk:{id}`: even if a second insert were attempted, the unique constraint makes it a no-op.

**Tested both ways:** with either layer removed, two workers on the same job still charge **3** chunks; with **both** removed, **6** (each chunk charged twice).

**Why the chunk id is the right key:**
- Reprocessing a document **deletes its chunks and inserts new ones** (Phase 6), with **new ids**, so a genuine re-embed *is* billed again. Tested: 2 chunks, reprocessed, gives 4 events.
- A **retried or stall-redelivered job** works on the **same** chunk ids, so it's *not* billed again.

The key names exactly "this piece of work" — no broader, no narrower.

**What's still paid twice, and by whom:** when two workers race on the same chunk (BullMQ's stall detection can hand a still-running job to a second worker), **both call Gemini** before either commits. **We** pay Gemini twice; **the customer** is charged once. It's rare and acknowledged.

**Interview line:** "Meter with a key that names the unit of work, so retries don't double-charge but genuine rework does; and make the write itself conditional as a second layer."

---

### Q14. The widget over quota; what the payload stopped sending

**What the visitor sees:** "Let me connect you with a member of our team who can help with that." It's an ordinary handoff message, with **nothing about plans, limits or billing** ([widget-chat.gateway.ts:204](../../Backend/src/modules/widget-chat/widget-chat.gateway.ts#L204)). The visitor is the *business's* customer; the business's billing state is none of their concern, and showing it would embarrass the business. That was your decision in the design step.

**Where the conversation goes:** it's saved as an **escalation**, so it appears in the **agent console's queue** (Phase 12) and the business still gets the conversation and can answer it. It's metered as **non-billable** with `escalationReason: 'quota_exhausted'`, and no Gemini call is made.

**What the payload stopped sending** ([widget-chat.gateway.ts:293](../../Backend/src/modules/widget-chat/widget-chat.gateway.ts#L293), `toPublicAnswer`): until this phase the gateway broadcast the **entire internal answer object** to anonymous visitors, including:
- `retrievedChunks`: 160-character **snippets of documents the answer didn't even cite**;
- raw similarity distances and token counts;
- and, from this phase, the escalation reason, which would have revealed "quota exhausted".

Anyone could read all of it in the browser's developer tools. Now a visitor receives only `answer`, `status` and `citations` (index, document id, filename). The widget never used anything else. This came out of a test that asserted the payload contains no billing words, which led to checking what else was in there.

**What this achieves:** the public surface exposes only what it needs. The general rule: **an internal type shouldn't double as a public API response**; project it explicitly.

**Interview line:** "Never serialise an internal object to an untrusted client; map it to an explicit public shape, so new internal fields can't leak by default."

---

## Topics to master

Ranked by how load-bearing each is across backend work generally, not just Anchor. The closing quiz wasn't attempted, so this list rests on the opening diagnostic (0 SOLID / 7 SHAKY / 5 UNKNOWN) and on which mechanisms were built by Claude rather than reasoned through by the user, which in earlier phases predicted what didn't stick.

### 1. Atomicity of business writes and their side records (transactions, and the transactional outbox)
**Search:** "transactional outbox pattern", "dual write problem microservices", "write to database and message queue atomically"
**Exposed by:** diagnostic Q7 (picked the one option that silently loses data); closing Q4, Q7, Q12.
Every system that records something *about* an action (an audit log, a usage event, an email to send, a message to publish) has to decide whether that record can be lost when the process dies between the two writes. "Same transaction, else an outbox" is the answer an excellent engineer gives without thinking, and the failure it prevents (silent loss) is the hardest kind to notice.

### 2. Idempotency keys for safe retries
**Search:** "idempotency key API design", "Stripe idempotent requests", "exactly-once vs at-least-once retries"
**Exposed by:** diagnostic Q5 (named the concept, none of the mechanism); closing Q5, Q13.
Networks lose responses, so every non-read endpoint that costs money or changes state will be retried by someone. Client-generated keys, enforced by a unique constraint, with the response replayed, is the industry pattern (Stripe, AWS, Google APIs).

### 3. Atomic conditional updates for check-then-act races
**Search:** "check-then-act race condition", "atomic conditional update SQL", "optimistic concurrency control UPDATE WHERE"
**Exposed by:** diagnostic Q11; closing Q11.
Quotas, inventory, seats, coupons, claims: anything with a limit is a check-then-act race. It's the same mechanism as Phase 12's claim and the members work's write skew, and recognising which of the two shapes you have (the condition is on the row being written, vs across other rows) decides whether an `UPDATE … WHERE` is enough or you need a lock.

### 4. Rate-limiting algorithms and their trade-offs
**Search:** "token bucket vs sliding window rate limiting", "fixed window rate limit boundary problem", "Redis Lua rate limiter"
**Exposed by:** diagnostic Q2 and Q3 (both UNKNOWN); closing Q2, Q3.
A standard system-design interview topic, and a real production choice: memory cost vs accuracy vs burst behaviour, plus why the implementation must be atomic.

### 5. Event-sourced ledgers vs counters, and rollups
**Search:** "append-only ledger design", "event log vs counter column", "pre-aggregation rollup tables"
**Exposed by:** diagnostic Q4, Q8; closing Q4, Q8.
Payments, usage, inventory movements and analytics all use the same idea: keep immutable facts and derive totals. Knowing when to sum on read and when to roll up, and how late data is handled, separates a billing system that can be audited from one that can't.

### 6. Degraded modes of a shared dependency (fail-open vs fail-closed, and timeouts that don't cancel)
**Search:** "fail open vs fail closed", "circuit breaker graceful degradation", "request timeout does not cancel operation"
**Exposed by:** diagnostic Q10 (described a design the user didn't choose); closing Q10.
Every dependency goes down eventually. What your system does then (per component, by its job) is a design decision, and "the timed-out command still ran" is the fact most engineers learn in an incident.

### 7. Time in data systems: `timestamptz`, a single clock, half-open intervals
**Search:** "timestamptz vs timestamp postgres", "half-open interval date range query", "clock skew distributed systems"
**Exposed by:** diagnostic Q12 (UNKNOWN); closing Q3, Q8.
Billing periods, reports and rate limits all depend on it, and this project has already shipped the five-hour bug once.

### 8. HTTP semantics for limits: 429 vs 402, `Retry-After`, `RateLimit-*`, backoff with jitter
**Search:** "HTTP 429 Retry-After", "IETF RateLimit header fields", "exponential backoff and jitter"
**Exposed by:** diagnostic Q9; closing Q9.
The contract between your API and every client that will ever call it; getting it wrong produces thundering herds.

---

## Interview questions this phase generates

1. Design usage-based billing for an API. Where is usage recorded, and how do you make sure it's neither lost nor double-counted?
2. What is an idempotency key? Who generates it, how is it enforced, and what should a retry receive?
3. Two requests arrive when a customer has one unit left. Walk through how you guarantee only one succeeds, and what happens if you get it wrong.
4. Fixed window vs sliding window vs token bucket: what does each cost, and when would you choose each?
5. Your rate limiter's store goes down. What should happen, and what's the effective limit with N instances?
6. Why shouldn't a quota counter be the source of truth for billing?
7. What should a 429 response contain, and how should a client back off?
8. How do you define "a month of usage" so that no event is in two months or in none?
9. What's wrong with `UPDATE accounts SET usage = usage + 1` as a meter?
10. A timed-out Redis command: did it run? How does that affect a rate limiter or a lock?

## What's still not understood

The closing quiz wasn't attempted, so this can't be measured from the quiz. What's known:
- The opening diagnostic had **no SOLID topic**. Every mechanism built this phase (the transaction around the meter, idempotency keys, the conditional reservation, the token bucket, the fail-open bucket) was written by Claude, not reasoned through by the user beforehand.
- **Two diagnostic answers described a different system from the one that exists**: Q7 picked the data-losing option, and Q10 described "no rate limit" during an outage when the user's own Phase 14 decision implemented a degraded per-instance limit. Those two (atomicity of side records; degraded modes) are the most likely to still be fuzzy, and are ranked 1 and 6 above.
- The **suggested check**: a five-question re-quiz in the user's own words, covering Q4, Q5, Q7, Q10 and Q11 from above. Offered, not required.

## Known limits, recorded rather than fixed

- **Two simultaneous requests with the same idempotency key both run the pipeline.** The customer is charged once; we may pay Gemini twice. The fix is an "in progress" record taken before the pipeline runs.
- **Two workers racing on one chunk both call Gemini.** It's charged once, paid twice. Rare (stall redelivery only).
- **After a Redis outage, the rate-limit bucket briefly double-counts** the requests made during it (failure case 8).
- **Rate-limit refusals aren't recorded**, so there's no "throttled requests" figure. A counter (not a meter) would do.
- **Rollups:** totals are summed on read. Fine at this scale; Phase 18 is the scheduled rollup.
- **`usage.view` is owner-only** by Claude's call, not the user's; it's one row to change.
- **Embedded chunks are billable** by Claude's call. The user decided the answer rule but was not asked about uploads.
