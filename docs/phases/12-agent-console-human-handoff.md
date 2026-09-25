# Phase 12 — Agent Console: Human Handoff

## Objective

Give a human agent a real, live way to see conversations Phase 10 escalated, claim one, and take over from the LLM in real time — using the exact real-time transport Phase 11 already built, not a new one.

## Why the system needs this

Phase 10 introduced `ConversationStatus.ESCALATED`, but nothing has ever *done* anything with an escalated conversation — it just sits in the table. A customer-support product that escalates to "a human will help you" and then never actually connects a human isn't finished; it's a dead end. This phase closes that loop: an agent needs to see escalated conversations, safely claim one (without two agents colliding), and have their replies reach the customer the same way the LLM's replies already do — over the Phase 11 socket, into the Phase 11 room.

---

## The diagnostic

11 questions, answered in one batch. **Result: 2 SOLID / 7 SHAKY / 2 UNKNOWN.**

### Q1 — What does "presence" mean, and how would you know an agent is actually online right now?
**Answer:** "we can check mark a agent online on login and on logout we will amrk him offline, and he willl be notified for eclated messages"

**Score: SHAKY.** Right shape (a binary online/offline state, agents get notified), wrong mechanism. Login and logout are **authentication** events — they produce or invalidate a JWT — completely separate from whether the agent's browser currently has a live connection open. A JWT issued at login stays valid for 15 minutes (Phase 2) regardless of whether the laptop lid is closed a minute later; "logged in" and "present right now" drift apart almost immediately in practice, since almost nobody explicitly clicks "log out" when they're actually done using something — they just close the tab. **The correct mechanism**: tie presence to the live WebSocket connection itself, exactly the way Phase 11's `WidgetChatGateway` already tracks per-connection state. When an agent's socket connects, mark them online (a Redis set like `online-agents:{workspaceId}`, or an in-memory map — the same pattern as Phase 11's `connections: Map<socketId, WidgetSocketData>`); when that socket disconnects (`handleDisconnect`), mark them offline. "Online" then always means exactly one true thing: there is currently an open, live connection for this agent — nothing else. This is the same mechanism behind Slack's or Discord's green dot: it reflects an active connection to their servers, not whether you logged in at some point today.

### Q2 — What actually goes wrong with a naive "check unclaimed, then update" two-step claim?
**Answer:** "we wll use transaction here for preventing this race condition"

**Score: SHAKY.** Naming "use a transaction" as the fix, without saying *what inside the transaction* actually prevents the race, is a very common and important gap to close precisely. Postgres's default isolation level is READ COMMITTED. Under it, if Agent A's transaction runs `SELECT ... WHERE id = 5` and sees `claimed_by IS NULL`, and at the same moment Agent B's transaction runs the *identical* `SELECT` and *also* sees `claimed_by IS NULL` — because neither has written anything yet — both transactions now believe they're free to claim it, and both proceed to `UPDATE`. Wrapping this two-step sequence in a transaction changes nothing about that outcome: a transaction guarantees your own reads and writes are consistent and atomic as a unit, but it does **not** automatically stop two *separate* transactions from both reading the same "unclaimed" state before either one writes. Preventing the race requires either an explicit lock (`SELECT ... FOR UPDATE`, forcing B to wait until A's transaction finishes) or — the better fit here — making the write itself atomically conditional (Q3/Q4).

### Q3 — What is optimistic concurrency control, and how does it differ from locking?
**Answer:** "dont know"

**Score: UNKNOWN.** Optimistic concurrency control (OCC) means: don't lock anything while you think — proceed as if no conflict will happen, and only discover a conflict at the last possible moment, when you try to actually commit your change. If someone else got there first, your attempt simply fails (affects zero rows), and you find out *after the fact* rather than blocking anyone up front. **Pessimistic** concurrency control is the opposite: you lock the row the instant you start looking at it (`SELECT ... FOR UPDATE`), forcing every other transaction that wants it to physically wait in line until you're done — safe, but it serializes *every* attempt, even in the overwhelmingly common case where only one agent will ever try to claim a given conversation and there was never going to be a conflict at all. OCC avoids paying that cost in the common case, at the price of having to handle "someone beat me to it" as a real, expected outcome rather than something you locked your way out of.

### Q4 — What would make a single `UPDATE` statement itself safe against the double-claim race?
**Answer:** "so instead of chekcing we will directly update is as claimed a=that can akso prevent race condition"

**Score: SHAKY.** "Update directly instead of check-then-act" is the right instinct, but the load-bearing detail is missing: the `UPDATE`'s `WHERE` clause has to encode the check itself, as a condition on the *current* row state — `UPDATE conversations SET claimed_by = $agentId, status = 'claimed' WHERE id = $conversationId AND claimed_by IS NULL`. A single `UPDATE` is always atomic against concurrent writers touching the same row (Postgres internally row-locks for the duration of any write), so if two of these exact statements run at nearly the same instant, only one can actually match `claimed_by IS NULL` — the moment the first one takes effect, the row's `claimed_by` is no longer `NULL`, so the second statement's `WHERE` clause matches zero rows. The critical follow-up (also missing from the answer): you must check *how many rows the statement actually affected* (TypeORM's `UpdateResult.affected`, or a raw query's row count). `affected === 1` means you won the race; `affected === 0` means someone else's claim landed first, and that's exactly how the calling code knows to return a `409 Conflict` instead of a false success.

### Q5 — Should an agent's socket connect to the same namespace Phase 11 built, or a different one?
**Answer:** "yes it will connect to same namespace so that agent can continue from where our llm left"

**Score: SHAKY.** The conclusion is actually right, but for a different, more structural reason than the one given — and this is worth being exact about, since Socket.IO **rooms are scoped per namespace**: a room only exists *within* one namespace, and a socket can only receive events broadcast to a room if that socket is itself connected to that same namespace. Phase 11's `conversation:{sessionId}` room lives inside the `/widget` namespace. If an agent's socket connected to some other namespace (say, `/agent`) instead, it would be structurally impossible for that socket to receive Phase 11's `this.server.to(room).emit('answer', ...)` broadcasts — not a permissions issue, a Socket.IO architectural fact: events emitted into a namespace's room only reach sockets connected to that exact namespace. So the real reason the agent must connect to `/widget` (not "continuing where the LLM left off," which is a customer-experience framing, not the technical constraint) is that it's the *only* way to actually join the same room the customer's socket already sits in. What's still needed, and wasn't addressed: the agent's `handleConnection` path needs completely different authentication logic than the customer's — a real JWT + role check, not a `publicKey`/origin check — which means either branching within the same gateway, or a genuinely separate connection path that still ends up joining rooms on the same namespace/server instance.

### Q6 — How do all online agents find out about a new escalation? Does that need a new kind of room?
**Answer:** "i think yes notifeng is separte fom calling so we will use diferent namespace for notifing agents"

**Score: SHAKY.** Correctly identifies that "notify everyone about a new escalation" is a genuinely different concern than "deliver messages within one specific conversation" — but reaches for the same wrong tool as Q5. Per Q5's explanation, a different *namespace* would make this broadcast **unreachable** by agents connected there for conversation-room purposes, for the identical structural reason. What's actually needed is a new **room**, not a new namespace: something like `agents:{workspaceId}`, which every online agent's socket joins (in the same `/widget` namespace) alongside whichever `conversation:{sessionId}` rooms they're actively viewing. A new escalation broadcasts to `agents:{workspaceId}`; an agent's own reply broadcasts to the one `conversation:{sessionId}` room. Two different rooms serving two different audiences, same namespace, same underlying mechanism Phase 11 already built and tested.

### Q7 — What happens when an agent's tab just closes, with no clean disconnect?
**Answer:** "we will use heartbeat mechanism here ping pong"

**Score: SOLID.** Correct, and worth knowing this doesn't need to be hand-built: Socket.IO already runs its own ping/pong heartbeat internally (`pingInterval`/`pingTimeout`), so `handleDisconnect` fires reliably even after an abrupt network loss or a force-quit browser — not only on a clean, intentional disconnect. This phase doesn't need to invent a heartbeat; it just needs to correctly *react* to the `handleDisconnect` Socket.IO already guarantees will eventually fire, the same way Phase 11's `connections.delete(client.id)` already reacts to it.

### Q8 — How does the customer's widget find out a human is now involved?
**Answer:** "we can send a message in conversation"

**Score: SHAKY.** Right idea, missing the actual delivery mechanism that makes it free. The customer's socket is *already* sitting in `conversation:{sessionId}` — it joined that room the moment it connected, back in Phase 11's `handleConnection`. Once an agent's socket also joins that same room (per Q5's resolution), there is no new addressing logic needed at all: the exact broadcast pattern Phase 11 already wrote and tested — `this.server.to(room).emit(...)` — reaches both sockets, automatically, because a room broadcast goes to every current member with no per-recipient logic. The one real design detail: this should probably be a *distinguishable* event (e.g. `'agent-message'`) rather than reusing the LLM's own `'answer'` event, so the widget's UI can render "Agent Jane" differently from the AI's replies.

### Q9 — Does claiming need a REST endpoint, a WebSocket event, or both?
**Answer:** "yes it needs a rest endont"

**Score: SHAKY.** The conclusion (REST) is right, but the *why*, and the fact that it's actually both, weren't addressed. REST fits the claim **action** itself well: it's a single, discrete state change with a clean success/conflict response — the atomic `UPDATE ... WHERE claimed_by IS NULL` from Q3/Q4 maps naturally onto "200 you got it" or "409 someone beat you to it," exactly the same request/response shape as every other mutating endpoint already in this project (e.g. `PATCH .../members/:userId`). But a REST response only reaches the one agent who made the request — every *other* connected agent's UI still needs to find out the conversation is gone, immediately, without polling. That's the WebSocket's job: after a successful claim, broadcast the result into `agents:{workspaceId}` (Q6) so every other online agent's console updates in real time. Two tools, each doing the part it's actually suited for.

### Q10 — Does this phase need Frontend work, and why would it differ from Phases 1–11?
**Answer:** "dont know"

**Score: UNKNOWN.** Yes — and this is the first phase where it's genuinely required. Every phase so far verified its core behavior through automated tests or direct API calls (a business user hitting `/ask` to manually test the AI counts as "using an API," not "needing a UI"); Phase 11's one human-facing surface was `Widget/` — a separate package built *for end customers*, not the internal Next.js dashboard. Phase 12's actual deliverable is fundamentally different in kind: a human agent needs to *see* a live list of escalated conversations, *claim* one, and *type real-time replies* — there is no way to meaningfully build, demonstrate, or "break-test" that experience through `curl` or an automated Jest suite alone, because the thing being built is the live human experience itself, not a mechanism a script can fully stand in for. This is exactly the condition CLAUDE.md's own rule anticipates: "Frontend, if that phase actually needs a UI" — and Phase 12 is the first phase where that's genuinely true.

### Q11 — What happens if an agent claims a conversation, then goes offline before resolving it?
**Answer:** "than we will make that conversation again claim able"

**Score: SOLID.** Correct end state. Worth connecting explicitly to Q1's corrected presence mechanism for Design: detecting *when* to release the claim requires `handleDisconnect` to check whether the disconnecting agent currently holds any claimed-but-unresolved conversations, and release them — the same `handleDisconnect` hook already responsible for marking the agent offline in the first place.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for actually building this phase's code:

1. **Optimistic concurrency via a conditional `UPDATE` + checking affected rows** (Q3, Q4) — the single mechanism the entire "claim" feature is built on; get this wrong and two agents *will* eventually both believe they own the same conversation.
2. **Presence tied to the live connection, not the auth lifecycle** (Q1, Q7, Q11) — login/logout and connect/disconnect are different lifecycles that happen to often move together but aren't the same thing; conflating them is the single most common mistake in this phase's design.
3. **Socket.IO rooms are scoped per namespace** (Q5, Q6) — directly resolves the exact gap flagged as unmoved across *two* consecutive Phase 11 exposures (its own Q10 and Q11): the reason Phase 11 built room-based broadcasting was precisely so a same-namespace future connection could join in without any rework, and "same namespace, new room" vs. "new namespace" is the whole ballgame for whether that payoff is actually realized here.
4. **REST for the state-changing action, WebSocket for telling everyone else it happened** (Q8, Q9) — a general pattern for any real-time feature with a discrete, conflict-checkable mutation at its core, not just this one claim button.
5. **This is the first phase whose core deliverable is an interactive human experience, not an API mechanism** (Q10) — the concrete trigger condition for when this project's own "Backend first, Frontend only if needed" rule actually fires.

---

## Architecture and decisions

Four increments, matching the design agreed before building:

**Increment 1 — the claimable unit, and the claim itself.** `Conversation` (Phase 9/10) is an immutable per-turn log; there's no single row in it representing "this ongoing session." A new `ConversationSession` table (one row per `sessionId`) is that missing record — `status: open | escalated | claimed | resolved`, `claimedByUserId`, `claimedAt`. Claiming is one atomically-conditional `UPDATE ... WHERE status = 'escalated'`, never a separate check-then-write — the real fix for the two-agents-claim-at-once race (Q2/Q3/Q4), proven with an actual concurrent-request test, not reasoning about it.

**Increment 2 — presence and notification, tied to the live connection.** Presence means "there is currently an open socket for this agent," never "logged in at some point" (Q1) — the same `connections` map pattern `WidgetChatGateway` already used for customers in Phase 11. A new room, `agents:{workspaceId}`, is what every online agent joins for workspace-wide notifications, kept deliberately separate from the per-conversation `conversation:{sessionId}` room (Q6) — but **in the same namespace** as customers, since Socket.IO rooms don't cross namespace boundaries (Q5), which is exactly the mechanism Phase 11's own room-based design was built to make possible without rework.

**Increment 3 — the actual handoff.** An agent's socket joins a claimed session's room only on an explicit `join-conversation` event (never automatically at connect — one agent connection might have several claimed conversations, or none). Once a session is `claimed`, `WidgetChatGateway.handleMessage` stops calling `AnswerService` entirely for that session — no wasted Gemini call, no risk of an AI reply landing right after a human's — and just relays the customer's raw text into the room. `resolve` (the same atomic-conditional-UPDATE shape as claim) moves the session back out of `claimed`, which means the very next customer message automatically falls back to the AI pipeline with zero extra code, since `handleMessage`'s check simply no longer matches.

**A circular-dependency problem, solved with a new leaf module.** `HandoffService` needs to broadcast into `agents:{workspaceId}`, which means reaching the same Socket.IO `Server` instance `WidgetChatGateway` holds. But `WidgetChatModule` already imports `AnswerModule`, which now imports `HandoffModule` — `HandoffModule` importing `WidgetChatModule` back would close that into a real cycle. The fix: a new top-level `src/realtime/` module (sibling to `embedding/`, `generation/`, `redis/`, `queue/` — this project's established pattern for genuinely shared infra), holding just a `RealtimeBroadcaster` service that wraps the `Server` reference. `WidgetChatGateway` populates it once (`afterInit`); `HandoffService` reads from it. Neither module needs to know the other exists.

**Increment 4 — the first real Frontend work in this project.** A minimal Next.js console: `/login` (email/password → JWT, stored in `localStorage`), `/console` (the escalated/claimed queue, a claim button, a live chat panel). No refresh-token rotation on this side — a deliberate scope boundary; a 15-minute token expiring mid-shift means logging back in again, not silent failure. `GET /auth/me` was extended (a small, natural addition, not a new feature) to also return the caller's workspace memberships, since this is the first client that ever needs to discover "which workspace am I in" instead of already having a `workspaceId` in its URL. `main.ts` gained `app.enableCors()` — the first time this project's REST API has ever been called from a real, different-origin browser page instead of `curl`/`supertest`, so Phase 11's kind of CORS problem (Q5) shows up here too, just for REST instead of a WebSocket.

**Two real, previously-undiscovered bugs found while building and testing this phase, not by design:**
1. A `jest --runInBand` run could finish all its tests successfully and still fail to exit ("asynchronous operations that weren't stopped"), silently leaving the real Postgres/Redis connections open. A second test run starting before the first was manually killed then corrupted both runs' results by `TRUNCATE`-ing the same shared tables concurrently — producing failures that looked like real application bugs (wrong 404s, timeouts) but were actually two Jest processes fighting over one database. Fixed by adding `--forceExit` to the test script; the underlying leak itself was never tracked down further, since forcing the exit is the standard, accepted practice for a Nest+Socket.IO+Redis+BullMQ suite where hunting down every open handle isn't worth the cost.
2. A genuine race: a Socket.IO client's `'connect'` event fires the instant the transport handshake completes — it does **not** wait for an `async OnGatewayConnection.handleConnection` hook to finish. A message emitted immediately after `'connect'` could reach the server before `handleConnection`'s own DB lookups and room-join had completed, hitting an "unknown connection" branch that looked, from the outside, like the server had simply forgotten who the caller was. This was **already latent in Phase 11's customer flow** — every "happy path" test there sends a message immediately after `'connect'` — it just never had enough concurrent load to actually trigger the race until Phase 12's heavier test suite surfaced it. Fixed with an explicit `'ready'` event, emitted only after `handleConnection`'s own async work finishes; every client (customer and agent) now waits for `'ready'`, not `'connect'`, before sending anything. See Failure Cases below for the full predict/trigger/result writeup.

## Data flow

**Escalation → claim → live handoff, end to end:**
1. A customer's message escalates (Phase 10's real generation-failure path). `AnswerService.persistAndReturn` calls `HandoffService.recordEscalation(workspaceId, sessionId)`, which upserts a `ConversationSession` row to `status: 'escalated'` and broadcasts `session-escalated` into `agents:{workspaceId}`.
2. Every online agent's console (already connected, sitting in that room) receives the event and refreshes its queue.
3. An agent clicks "Claim." The Frontend calls `PATCH .../handoff/:sessionId/claim`. `HandoffService.claim` runs the atomic conditional `UPDATE`; on success it broadcasts `session-claimed` (for every *other* agent's console) and returns the updated row (for the claiming agent's own UI, via the REST response itself).
4. The claiming agent's socket emits `join-conversation`; the gateway verifies `claimedByUserId` actually matches this agent, then joins them to `conversation:{sessionId}` — the exact room the customer's socket has been sitting in since Phase 11.
5. The next customer message: `handleMessage` sees `status === 'claimed'`, skips `AnswerService` entirely, and relays `customer-message` into the room.
6. The agent replies; `handleAgentMessage` re-verifies the claim, then broadcasts `agent-message` into the same room — reaching the customer's socket with no new addressing logic.
7. The agent clicks "Resolve." `PATCH .../resolve` flips the session to `resolved` and broadcasts `session-resolved`. The *next* customer message no longer matches the `CLAIMED` check in `handleMessage`, so it silently falls back to the AI pipeline.

## Migrations: what each table and column actually stores

**`CreateConversationSessions`** — a new table, `conversation_sessions`:
- `workspace_id` (FK → `workspaces`, `CASCADE`, indexed): which business this session belongs to.
- `session_id` (`varchar`): the same string `Conversation.sessionId` carries — the widget's own `localStorage`-backed id. `UNIQUE(workspace_id, session_id)` together, not a bare unique on `session_id` alone — matches `Document`'s `UNIQUE(workspaceId, contentHash)` precedent, even though a widget-generated UUID colliding across two different workspaces is astronomically unlikely.
- `status` (enum: `open`/`escalated`/`claimed`/`resolved`, default `open`): the state machine this whole phase is built around.
- `claimed_by_user_id` (nullable FK → `users`, `SET NULL`): who owns this conversation right now. Nullable because most rows spend most of their life unclaimed; `SET NULL` (not `CASCADE`) because a session shouldn't be deleted just because the agent who once claimed it later leaves — matches `Document.uploadedByUserId`'s exact precedent from Phase 3.
- `claimed_at` (nullable timestamp): when the claim happened — not currently used for anything beyond display, but cheap to capture now.

This migration hit the *same* recurring `migration:generate` bug Phase 10 first caught and Phase 11 hit twice more: TypeORM's diffing still doesn't understand the Phase 8 HNSW index's `USING hnsw` clause, and tried to silently drop/recreate it as a plain index a fourth time — stripped by hand before running, verified the real index survived intact afterward.

## Code walkthrough

### `Backend/src/database/entities/conversation-session.entity.ts`
The whole claimable-unit model in one file — see the migration breakdown above for what each column means. Worth noting explicitly: this entity is intentionally *not* a state machine class with transition methods — it's a plain TypeORM entity, and all the actual state-transition logic (the conditional `UPDATE`s) lives in `HandoffService`, matching how `Conversation`'s own status enum (Phase 10) works.

### `Backend/src/modules/handoff/handoff.service.ts:38-68` — `claim()`
```ts
async claim(workspaceId: number, sessionId: string, userId: number): Promise<ConversationSession> {
  const result = await this.sessions
    .createQueryBuilder()
    .update(ConversationSession)
    .set({ status: ConversationSessionStatus.CLAIMED, claimedByUserId: userId, claimedAt: () => 'now()' })
    .where('workspace_id = :workspaceId', { workspaceId })
    .andWhere('session_id = :sessionId', { sessionId })
    .andWhere('status = :status', { status: ConversationSessionStatus.ESCALATED })
    .execute();

  if (result.affected === 0) {
    const existing = await this.sessions.findOne({ where: { workspaceId, sessionId } });
    if (!existing) throw new NotFoundException('No such conversation session in this workspace.');
    throw new ConflictException(`This conversation is already ${existing.status}.`);
  }
  // ...broadcast session-claimed, return the updated row
}
```
The entire optimistic-concurrency mechanism is the `WHERE ... AND status = 'escalated'` clause plus checking `result.affected`. If two of these run at nearly the same instant, only one can actually match `status = 'escalated'` — the moment the first commits, the row's status is no longer `'escalated'`, so the second matches zero rows. The `findOne` after a miss exists purely to produce a precise 404-vs-409 error message; it plays no role in correctness.

### `Backend/src/modules/handoff/handoff.controller.ts`
```ts
@Get()
@Roles(MembershipRole.OWNER, MembershipRole.AGENT)
listActive(@Param('workspaceId', ParseIntPipe) workspaceId: number) { ... }
```
**A real bug caught during this phase's own build**: `@Roles(...)` was first applied at the *class* level, above `export class HandoffController`. `RolesGuard.canActivate` reads its metadata via `this.reflector.get(ROLES_KEY, context.getHandler())` — `getHandler()` returns the specific method, never the class — so a class-level `@Roles(...)` is silently ignored by this project's own `RolesGuard` as written. A viewer could reach every handoff endpoint until this was caught by a real, failing RBAC test and fixed by moving `@Roles(...)` onto each individual method, matching every other controller in this codebase.

### `Backend/src/modules/widget-chat/widget-chat.gateway.ts:78-112` — `handleCustomerConnection`
```ts
this.connections.set(client.id, { kind: 'customer', workspaceId: workspace.id, sessionId });
await client.join(conversationRoom(sessionId));

client.emit('ready');
```
`'ready'` is emitted only after the connection is actually tracked and the room joined — seeFailure Cases below for exactly why this line exists and what broke without it.

### `Backend/src/modules/widget-chat/widget-chat.gateway.ts:117-146` — `handleAgentConnection`
The agent branch: verify the JWT by hand (`jwtService.verifyAsync`, the same secret every REST call already uses), look up the real `Membership`, reject `VIEWER`, then track the connection and join `agentsRoom(workspaceId)`. This is `JwtAuthGuard` + `WorkspaceGuard` + `RolesGuard`'s logic, re-implemented here because a WebSocket handshake never runs through Nest's HTTP guard pipeline at all.

### `Backend/src/modules/widget-chat/widget-chat.gateway.ts:161-189` — `handleMessage`, the AI skip
```ts
const session = await this.conversationSessions.findOne({
  where: { workspaceId: connection.workspaceId, sessionId: connection.sessionId },
});
if (session?.status === ConversationSessionStatus.CLAIMED) {
  this.server.to(room).emit('customer-message', { question: dto.question });
  return;
}
const result = await this.answerService.answer(...);
```
One extra `SELECT` per customer message (looking up the session's current status) is the entire cost of this feature. Everything else — the AI pipeline itself, the room broadcast shape — is completely unchanged from Phase 11.

### `Backend/src/modules/widget-chat/widget-chat.gateway.ts:201-224, 236-253` — `handleJoinConversation`, `handleAgentMessage`
Both re-verify `session.claimedByUserId === connection.userId` independently, even though the Frontend should only ever let a claiming agent reach this state — a server never trusts a client's own UI state as its authorization boundary. Both emit an **explicit, named error event** (`join-conversation-error`, `agent-message-error`) rather than `throw new WsException(...)`. This was a real, working-code change made during testing: a thrown `WsException` from inside a bare handler proved inconsistent under load in this session's own testing (see Failure Cases), and an explicit `client.emit(...)` sidesteps relying on the framework's implicit exception-to-event translation entirely — a more concrete, more debuggable design regardless.

### `Backend/src/realtime/realtime-broadcaster.service.ts`, `rooms.ts`
The whole fix for the circular-dependency problem: `RealtimeBroadcaster` holds a `Server | null`, set once by the gateway's `afterInit` lifecycle hook, read by anything (currently only `HandoffService`) that needs to broadcast without depending on the gateway's own module. `rooms.ts` centralizes `conversationRoom()`/`agentsRoom()` so the naming convention has exactly one source of truth across both consumers.

### `Frontend/` — a feature-sliced structure, not everything dumped into `app/`

Restructured mid-increment, on request, away from an initial flat `app/console/page.tsx` + `lib/` layout into three layers:
```
Frontend/
├── app/                     Next.js routing only — every page.tsx is a few lines,
│   ├── login/page.tsx       just composing a feature component inside a shared layout
│   ├── register/page.tsx
│   └── console/page.tsx
├── features/
│   ├── auth/                api.ts (login/register/me) + LoginForm.tsx + RegisterForm.tsx
│   └── handoff/             api.ts, useAgentSocket.ts, ConsoleApp.tsx, WorkspacePicker.tsx,
│                            ConversationQueue.tsx, ConversationChat.tsx
└── shared/                  cross-cutting, feature-agnostic
    ├── api/client.ts        the one fetch() wrapper + ApiError every feature's api.ts calls
    ├── auth/token.ts        localStorage access, matching Widget/src/session.ts's defensive style
    ├── socket/connectAgentSocket.ts
    └── ui/                  Button, TextField, ErrorBanner, AuthLayout
```
`app/*/page.tsx` files are intentionally boring — e.g. `app/console/page.tsx` is exactly `export default function ConsolePage() { return <ConsoleApp />; }`. All real logic lives in `features/`, and only genuinely feature-agnostic code (the fetch wrapper, token storage, the socket connector, generic UI atoms) lives in `shared/` — nothing in `shared/` knows `ConversationSession` or `Membership` exist. This mirrors this project's own Backend convention (`src/common/` for cross-cutting code, `src/modules/<name>/` for features) applied to the Frontend for the first time.

### `Frontend/features/handoff/useAgentSocket.ts`
A custom hook owning the one agent socket connection for a workspace: wires `session-escalated`/`session-claimed`/`session-resolved` into a live `sessions` array, and collects whatever `customer-message`/`agent-message`/`answer` events arrive into `liveMessages`. `ConsoleApp.tsx` is left to handle only orchestration (which conversation is open, calling the REST `claim`/`resolve` endpoints, routing) — it doesn't touch `socket.on(...)` directly at all.

### `Frontend/features/handoff/ConsoleApp.tsx`
The orchestrator: loads `me()` to discover workspace memberships, shows `WorkspacePicker` if there's more than one, otherwise renders `ConversationQueue` + `ConversationChat` side by side, wiring REST calls (`claimConversation`, `resolveConversation`, `getConversationDetail`) to the socket state from `useAgentSocket`. A known, explicitly-accepted simplification: the console assumes one open conversation at a time and never explicitly leaves a Socket.IO room when switching to a different one — acceptable for a minimal, single-conversation-at-a-time internal tool, but a real gap if an agent handles two conversations in parallel in the same browser tab.

### `Frontend/features/auth/RegisterForm.tsx`
Added alongside the restructure — registering already existed as a Backend endpoint (`POST /auth/register`, Phase 2) but had no Frontend surface at all until now. Mirrors `LoginForm.tsx` exactly (same `ApiError` handling, same `setToken` + redirect-to-`/console` on success), plus a `workspaceName` field, since registering *creates* the workspace and makes the caller its owner — there's no separate "create a workspace" step anywhere in this project.

### Addendum — the Frontend expanded past this phase's own scope, on request (2026-09-22)

After Increment 4 itself was done, the user asked for the Frontend to cover *every* already-built backend surface that still had no dashboard page — Phase 2's and Phase 3's own REST endpoints, not new backend work, so this isn't a new phase's worth of scope, just filling in a gap the "Backend first" rule had deliberately left open. Consulted `Anchor_Prototype.html` (extracted per this repo's own convention) for the actual design of each page before building.

- **`features/documents/` (`/documents`, Phase 3's upload/list/delete)** — stat cards (ready/processing/failed/total, computed client-side from the real list, not a separate backend aggregate), a status-badged table, and `UploadButton` using a raw `XMLHttpRequest` (not `fetch`) specifically because `xhr.upload.onprogress` is what makes a real upload percentage possible — `fetch` has no equivalent upload-progress event. Polls the list every 4s, but **only** while at least one document is still `uploaded`/`processing` — there's no push channel for document status the way there is for the widget/agent gateway, so polling is the honest, simple option rather than pretending otherwise.
- **`features/widgetSettings/` (`/widget`, Phase 11's `publicKey`/`allowedOrigins`)** — the domain allowlist (add/remove, owner-only, matching the Backend's own `@Roles(OWNER)` restriction) and a real embed snippet built from the real `publicKey`. The prototype's brand-color/position/bot-name/welcome-message customization was **deliberately left out** — none of it has any backing column on `Workspace`, and building that UI would mean state that looks real but goes nowhere, which this project's own no-mocks philosophy argues against.
- **`features/members/` (`/team`, Phase 2's member list + role change)** — no "Add member" control, since no invite endpoint exists in this codebase at all (`Membership` rows are only ever created via `AuthService.register()`, for the workspace's owner).
- **`features/playground/` (`/playground`, a manual tester for `POST /ask`)** — a real chat interface against the real endpoint, a fresh `crypto.randomUUID()` session per page load (deliberately not persisted like `Widget/`'s own session — this is a staff testing tool, not a real customer), citations rendered directly from the real `AnswerResult.citations` array.
- **New `shared/workspace/` (`WorkspaceContext` + `DashboardShell`)** — "which workspace am I in" and the sidebar nav now exist in exactly one place, shared by all five dashboard pages (the four new ones plus the pre-existing console). `ConsoleApp.tsx` was simplified to consume `useWorkspace()` instead of duplicating its own `me()` call and workspace-picker logic — a genuine DRY cleanup enabled by the new pages needing the identical resolution step.
- **Verified for real against a live Backend instance**, not just type-checked: a full `curl` sequence (register → `/auth/me` → list documents → a real multipart upload of a real PDF fixture → widget-settings `GET`/`PATCH` → members `GET` → a real `/ask` call) matched every `api.ts` function's expected shape exactly, with zero adjustment needed afterward.
- **One real, pre-existing environment anomaly surfaced, unrelated to this work**: the test upload's embedding job sat in Redis as an orphaned hash — present, but in none of BullMQ's wait/active/delayed/failed/completed lists. Traced to genuine queue congestion (dozens of leftover `document-embedding` job keys from the same day's very heavy Jest iteration), not a code defect — the document-processing pipeline itself has already been proven correct by dozens of passing automated tests. Not chased further, since it wasn't blocking the actual Frontend integration check.

### Addendum 2 — the Knowledge page rebuilt to match the prototype exactly, with real backend behind it (2026-09-22)

The user supplied real screenshots of the prototype's Knowledge page and asked for an exact match, backend included, with "Reindex all" explicitly deferred. Three genuinely new backend pieces were needed — this wasn't just a UI reskin:

1. **`Document.readyAt`** (migration `AddReadyAtToDocuments`, nullable timestamp) — set by `DocumentEmbeddingProcessor` the instant every chunk has a real embedding, backing the table's "Last indexed" column.
2. **Real per-document enrichment** — `DocumentsService` now runs two extra queries per list/detail call (`SELECT document_id, COUNT(*) ... GROUP BY document_id` against `document_chunks`, and a batched `SELECT id, email FROM users WHERE id = ANY(...)`), merged in JS rather than an eager ORM relation — a real chunk count and the real uploader email, not placeholders.
3. **A real, live progress endpoint** (`GET .../documents/:documentId/progress`) backed by actual `job.updateProgress()` calls threaded through both processors — `parsing` → `chunking` (with real page/word counts) in `DocumentProcessingProcessor`, `embedding` (real `completed`/`total` updated after every single chunk) in `DocumentEmbeddingProcessor`. This is a direct, hands-on encounter with the exact Redis-only/non-durable `job.updateProgress()` distinction this project's own memory has flagged as a recurring weak spot since Phase 5 — this time built into a real, working feature instead of only discussed.

**Three more real bugs found while verifying this, all fixed for real, not worked around:**
- `findLiveJob` originally matched a "live" job by `documentId` alone, returning whichever came first. Since this project's test convention TRUNCATEs Postgres with `RESTART IDENTITY` between every test (resetting document IDs to 1) while BullMQ's own job history in Redis never resets, a stale job from a completely unrelated earlier test could collide by ID. Fixed by preferring the most recently created match (`job.timestamp`) — a genuine robustness improvement, not merely a test fix.
- `test/document-processing.e2e.spec.ts` paused the real embedding queue in `beforeAll` with no matching `resume()` in `afterAll`. `Queue.pause()` (unlike `Worker.pause()`) is a durable, Redis-persisted **global** pause affecting every worker on that queue name — not scoped to that one test file's app instance. Every run of that file permanently disabled the real embedding queue for the rest of the Redis instance's life. This was the actual root cause of the "orphaned job" anomaly flagged in Addendum 1 above and left unchased at the time. Fixed with the missing `resume()`.
- `DocumentProcessingProcessor.process()` unconditionally enqueued a new embedding job on every successful run, with no deduplication. Under real, observed load, BullMQ's own stall-detection (Phase 4's own taught mechanism) redelivered the processing job to a second worker while the first was still genuinely running, producing two real, independent embedding jobs for the same document. Fixed with a deterministic `jobId: embed-${documentId}` on the `.add()` call — empirically verified with a standalone script (not just reasoned about) that a duplicate add during the original's in-flight window is a true no-op.

**A fourth, purely environmental finding**: this project has never had a separate test database (a standing open item since Phase 2). Running the automated Jest suite and manually `curl`-testing the live dev server in the same session means each silently resets the other's data — worth a fresh `TRUNCATE`/`FLUSHALL` immediately before any manual verification, or waiting until the automated suite has finished running.

New Frontend pieces: `DocumentsFilterBar` (search/status/type, all real client-side filtering over the already-fetched list — no new backend needed for this part), `ProcessingPanel` (polls the new `/progress` endpoint every second, renders a real live checklist — 4 real stages, not the prototype's 5, since this pipeline has no separate "indexing" step distinct from embedding completing), and a full `Sidebar` component matching every section of the actual prototype nav — sections with no backend (Overview, Conversations, Analytics, Evaluations, Usage & cost, Billing, Onboarding) are shown, not hidden, but visibly disabled with a "Soon" tag rather than faked with mock data. `GET /auth/me` was extended a second time (email, alongside the existing memberships) for the sidebar's own user footer — the same "small, natural addition" pattern as its first extension.

### Addendum 3 — the AI Playground rebuilt to match the prototype exactly, with real confidence/timing/token data behind it (2026-09-22)

The user supplied a screenshot of the prototype's AI Playground page and asked for an exact match. Unlike Addendum 2's Knowledge page, the *data* the page needed (a numeric confidence score, response time, token counts, a per-source relevance score, a retrieval inspector panel) didn't exist anywhere in `AnswerResult` yet — Phase 9/10 built `/ask` to return an answer, citations, and a status, nothing more. This required a real `AnswerGenerationProvider`/`AnswerResult` interface extension, not just a Frontend reskin.

1. **`GenerateResult` replaces a bare `string` return from `AnswerGenerationProvider.generate()`** — now `{ text, promptTokens, totalTokens }`, sourced from Gemini's real `response.usageMetadata.promptTokenCount`/`totalTokenCount`. Worth flagging: the SDK's own generated type (`GenerateContentResponseUsageMetadata`) carries a JSDoc comment claiming *"This data type is not supported in Gemini API"* — empirically false, verified with a real call returning fully populated values (`promptTokenCount: 14, totalTokenCount: 107`, etc.). Matches this project's established pattern (Phase 7's and Phase 9's own model-name lookups) of trusting a live API call over the SDK's own stale docs.
2. **`AnswerResult` extended** with `minDistance` (the same real cosine distance Phase 10's threshold already computed internally, now actually surfaced), `promptTokens`/`totalTokens` (`null` whenever generation was never called — the refused-by-threshold branch, matching Phase 10's own short-circuit design), and `retrievedChunks` (every chunk retrieval actually returned, each with its real distance and a real text snippet) — populated in **every** branch (answered/refused/escalated), not just the happy path, so the Frontend's retrieval inspector has real data to show even for a refusal. `Citation` also gained a real per-citation `distance`, so a "Sources" pill can show a real relevance percentage instead of just a filename.
3. **Confidence, response time, and per-source scores are all honest transformations of real data, never a separate fabricated number**: confidence = `1 - minDistance` (clamped 0–1) — the same reasoning Phase 10 already used internally for its threshold, now just exposed; response time is measured client-side with `performance.now()` around the real `fetch` call, not simulated; a source's relevance percentage is `1 - citation.distance`, the same transform applied per-chunk.
4. **Two new Frontend components**: `ChatTurn.tsx` (per-turn rendering — the confidence/timing/token summary line, source pills with real scores, and a refused-state amber treatment with two buttons: "Keep chatting" is real and dismissive, "Talk to an agent" is deliberately inert/disabled with a tooltip explaining why — this Playground is a **staff preview of what a customer sees**, not a live escalation surface, and Phase 10's state machine has no manual-escalation-from-refusal path to call into honestly) and `RetrievalInspector.tsx` (a right-hand panel showing the last turn's real retrieved chunks, ranked, with real snippets and scores — `Search mode: Vector`, not `Hybrid`, since Phase 13's hybrid search doesn't exist yet; the real Gemini model name, not the prototype's fictional one; no fabricated `Cache` tile, since Phase 14's caching layer doesn't exist yet).
5. **Six existing test files' stub generation providers updated** for the `GenerateResult` shape change (`generate: async () => 'text'` → `generate: async () => ({ text: 'text', promptTokens: null, totalTokens: null })`) — a mechanical but necessary consequence of widening a shared interface that seven different test files' fakes implement.
6. **Verified for real against the live Backend**, not just type-checked: a fresh workspace, a real headless-Chrome-generated PDF (the same fixture-generation technique Phase 5's tests use) uploaded and fully processed, then two real `/ask` calls — one grounded question (real `answered` response with a real citation, `distance: 0.311`, `totalTokens: 741`) and one off-topic question (real `refused` response, `minDistance: 0.549` correctly above the 0.45 threshold, `promptTokens`/`totalTokens` correctly `null` since generation was never invoked, `retrievedChunks` still populated with the one real chunk that was retrieved but judged too weak) — confirming the refused branch's field population, not just the happy path.
7. Full backend suite re-run clean after the interface change: **21 suites, 112/112 tests**. Frontend `tsc --noEmit` and `next build` both clean, including the two new pages (`/playground`'s existing route, now backed by the new components).

## Failure cases actually tested

1. **Two agents claiming the same escalated session at the same instant — predicted and confirmed.** Predicted: exactly one `PATCH .../claim` succeeds, the other gets `409`, because the atomic conditional `UPDATE`'s `WHERE status = 'escalated'` can only ever match once. Triggered for real with `Promise.all` firing two genuinely concurrent HTTP requests at the same row — confirmed `[200, 409]`, and the database ends up with exactly one `claimed_by_user_id`, never a race-condition double-claim.
2. **A client disconnecting before an agent's reply arrives — inherited and re-verified from Phase 11's pattern**, now exercised through the handoff path too (a claimed session's customer message relayed live, an agent's message requiring a real, current claim).
3. **The `'connect'`-before-`'ready'` race — a real bug, found by testing, not predicted in advance.** While testing "an agent cannot join a conversation they have not claimed," the exact same test occasionally passed in isolation and failed when run as part of the full suite. Debugging with direct server-side logging showed `this.connections.get(client.id)` returning `undefined` — the agent's own client had already received `'connect'` and emitted `join-conversation`, but the server's `handleAgentConnection` (an `async` function doing real DB lookups) hadn't finished populating the `connections` map yet. **Root cause, once found**: NestJS's Socket.IO adapter does not wait for an `async handleConnection` to resolve before the transport-level handshake completes and the client's own `'connect'` fires. **Fix**: an explicit `'ready'` event, emitted by the server only once its own async setup is actually done; every test (and the real Frontend) now waits for `'ready'`, never `'connect'`, before sending anything. Re-ran the full suite after the fix: the previously-intermittent test passed consistently across multiple full runs.
4. **A class-level `@Roles(...)` decorator being silently ignored — a real bug, found by a real, failing RBAC test.** `HandoffController` originally declared `@Roles(OWNER, AGENT)` once, at the class level, assuming it would apply to every route the way `@UseGuards(...)` does at the class level. A viewer-role test expecting `403` got `200` instead. Traced to `RolesGuard` reading `context.getHandler()` (method-level metadata only) — moved the decorator onto each individual method, matching every other controller in this project, and the test passed.
5. **An exception thrown from inside a bare `@SubscribeMessage` handler (no `@UsePipes`/`@UseGuards`) not reliably reaching the client as an `'exception'` event under real, sequential multi-test load.** Rather than chase the exact framework internals further, switched `handleJoinConversation`/`handleAgentMessage`'s "you haven't claimed this" case to an explicit `client.emit('join-conversation-error'/'agent-message-error', ...)` instead of `throw new WsException(...)` — deterministic, and arguably better API design (a named event beats a generic one) regardless of the original mechanism's reliability.
6. **A stale, never-exited Jest process corrupting a fresh test run's data via concurrent `TRUNCATE`s — found by real, confusing test failures that turned out to have nothing to do with this phase's code.** `Get-CimInstance Win32_Process` showed a `jest --runInBand` process from hours earlier still alive and holding the real Postgres connection. Fixed the immediate corruption by killing it; fixed the underlying cause by adding `--forceExit` to the test script.

## Tests and why

- `test/handoff.e2e.spec.ts` (12 tests) — the REST claim/resolve/list/detail surface: a real generation failure creating a real `ConversationSession` row; no duplicate row on a second escalation; claim/resolve happy paths; 404s for a nonexistent session; 409s for an already-claimed/already-resolved session; the real two-simultaneous-claims race; RBAC (viewer excluded); cross-workspace isolation.
- `test/agent-realtime.e2e.spec.ts` (7 tests) — agent connection auth: valid JWT succeeds, viewer rejected, forged JWT rejected, no-membership rejected, real-time `session-escalated`/`session-claimed` broadcasts received, cross-workspace broadcast isolation.
- `test/agent-handoff-conversation.e2e.spec.ts` (5 tests) — the actual takeover: join + agent-message reaching the customer live, customer messages relayed without ever calling the AI once claimed (proven with a generation provider that throws if called at all), an agent rejected from joining/messaging a conversation they haven't claimed, and resolve hand — the conversation genuinely goes back to the AI for the next message.
- `src/modules/auth/auth.service.integration.spec.ts` (+1 test) — `me()` reports every workspace a user belongs to, with their role in each.
- All real — Postgres, Redis, real `socket.io-client` connections, only the LLM generation call substituted (to stay fast/deterministic/independent of Gemini's daily quota — retrieval/embedding stay real wherever a test needs a genuine `ConversationSession` to exist).

## Reverse-engineering guide

Start at `Backend/src/modules/handoff/handoff.service.ts` — every state transition this whole phase cares about (`claim`, `resolve`, `recordEscalation`) lives in this one file, and the atomic-`UPDATE` pattern in `claim`/`resolve` is the single idea the rest of the phase is built around. From there, `Backend/src/modules/widget-chat/widget-chat.gateway.ts` is where that state actually gets *used* in real time — `handleMessage`'s status check is the one line where Phase 9-11's AI pipeline and Phase 12's human handoff actually meet. `Backend/src/realtime/` is small and easy to miss but explains *why* `HandoffService` can broadcast at all without a circular import — read it before adding any other cross-module broadcast need. On the Frontend, `features/handoff/ConsoleApp.tsx` is the orchestrator to start from — it composes everything else in `features/handoff/`; `useAgentSocket.ts` next, since it owns the entire WebSocket half of the contract. `test/agent-handoff-conversation.e2e.spec.ts` is the most complete executable specification of the actual handoff behavior — read it before changing any of `handleMessage`/`handleJoinConversation`/`handleAgentMessage`.
