# Phase 11 — Public Widget + Real-Time Chat

## Objective

Build the first thing an actual end customer (not a logged-in business user) ever interacts with: an embeddable chat widget a business drops into their own website, talking to Anchor over a real-time WebSocket connection, authenticated by a public API key rather than a login — and, per the debt this project has carried since Phase 1, doing all of that without ever exposing a raw, guessable integer ID to that untrusted, unauthenticated surface.

## Why the system needs this

Everything built since Phase 2 (auth, tenant scoping, retrieval, grounded answers, escalation) has been reachable only by a *logged-in business user* hitting a REST API. Nothing in this project has ever served an actual *customer* of one of Anchor's business customers. This phase is where Anchor's product becomes something an end user (someone who has never heard of Anchor, doesn't have an account, and shouldn't need one) can actually use — which means confronting, for the first time, an API surface that has to assume every caller might be hostile, since there's no login wall filtering out casual abuse the way there has been everywhere else in this project.

---

## The diagnostic

11 questions, answered in one batch. **Result: 6 SOLID / 3 SHAKY / 2 UNKNOWN — the strongest opening diagnostic of the entire project so far.** Worth noting the pattern before the Q&A: the strongest answers here are the ones closest to general full-stack web development (WebSockets, CORS, Socket.IO rooms) — the user's own stated area of existing strength — while the RAG/vector-search-specific phases (5-10) consistently started much weaker. This is a real, useful signal about where teaching effort has paid off already versus where it's still needed.

### Q1 — Why can't the widget use the same JWT auth as the dashboard?
**Answer:** "so widget is going to be inserted in website where user are nor authenticated so they dont do login or isgnup thing wo we cannot check access token for their req"

**Score: SOLID.** Exactly right — the widget's end user has no Anchor account at all, so there's no login session or JWT to check in the first place. This isn't a missing feature to add later; it's a fundamentally different kind of caller than everything built so far.

### Q2 — What does a public API key + domain allowlist actually protect against, and what doesn't it protect against?
**Answer:** "dont know"

**Score: UNKNOWN.** Worth being precise here, since this is genuinely a *weaker* security mechanism than everything built earlier in this project, not a like-for-like replacement for a JWT. **What it protects against:** casual, opportunistic misuse — someone finding the key (e.g., copy-pasted into a public forum post, or scraped from a random webpage) and trying to use it from a domain the business never authorized. It also gives Anchor visibility into which domains are actually using a given key, useful for spotting misconfiguration. **What it does NOT protect against:** a motivated attacker directly hitting the API (not through a browser at all — a script, `curl`, anything) can set an `Origin`/`Referer` header to *any value it wants*, including a fake claim of being an allowed domain. Browsers enforce CORS honestly (Q5); a bare HTTP client doesn't have to. So domain allowlisting is a **deterrent against casual misuse**, not a cryptographic guarantee — it raises the bar, it doesn't eliminate determined abuse. This is exactly why rate limiting (Q8) matters as a real, separate backstop, not a nice-to-have.

### Q3 — What's the real risk of exposing a raw integer workspace ID here, and what's the actual fix?
**Answer:** "we are going to expose workspace id so attacher can prediect workspace dont know the fix"

**Score: SHAKY.** The risk half is right — correctly identifies that sequential integer IDs are guessable/enumerable (workspace 1, 2, 3...). The fix wasn't landed. **The actual fix**: add a new column to `Workspace` — call it `publicId` — a long, random, unguessable string (a UUID v4, or an equivalent securely-generated random token) generated once when the workspace is created. The widget's public-facing API and embed script use *only* this random token to identify which workspace they belong to — **never** the raw auto-increment `id`. Internally, the very first thing the backend does with an incoming `publicId` is look up the real `Workspace` row (`WHERE public_id = $1`) and then proceeds using the real internal integer `id` for everything downstream (joins, foreign keys, all of it) — the random token exists *only* at the one boundary where an external, untrusted party gets to say which workspace they mean. This is a deliberately narrow, targeted fix — **not** a project-wide switch to UUID primary keys (which was explicitly, knowingly rejected back in Phase 1) — exactly the kind of minimal, scoped debt repayment the original decision anticipated needing.

### Q4 — Why WebSockets instead of repeatedly calling the existing REST `/ask` endpoint?
**Answer:** "using websocket we can do bidirection work so we dont have to req again when llm has generated our answer instead server will itself send it to client"

**Score: SOLID.** Exactly right — the push-vs-poll distinction, and correctly tied to the real reason it matters here: the server can proactively send a message to an already-connected client, which is exactly the shape Phase 12's eventual human-agent messages will need too (an agent's reply has to reach the customer without the customer's browser needing to ask "any updates?" on a timer).

### Q5 — What is CORS, and why does the widget need real CORS configuration?
**Answer:** "CORS is cross origin resource sharing it means the user website cannot req our backend if we dont allow the domain they are req from"

**Score: SOLID.** Correct definition and correctly applied — nothing built before this phase has ever needed real cross-origin configuration, because a JWT-authenticated dashboard is presumed to run on Anchor's own domain (or a domain configured once, not one-per-business). The widget runs on *every business's own website*, a genuinely different domain per customer, which CORS has to actually be configured to allow.

### Q6 — What's a Socket.IO "room," and why does workspace-scoping matter here?
**Answer:** "room is absically a thing in sockets whihc means if we want to start converation between two users we will add them in single room o that when ever person A send any message it will be sent to all the users in that room thats how real time thing works, and we must have to scope user based on workspace because if any peron who does not belong to that workspavce can also get the messages"

**Score: SOLID.** Correct mechanism (a room is a named broadcast group — a message sent "to a room" reaches everyone currently joined to it, not every connected client) and correctly identifies *why* it matters here: without deliberate workspace-scoped rooms, a message meant for one business's customer could leak to a socket connection belonging to an entirely different workspace — the exact same tenant-isolation concern that's shaped this project since `WorkspaceGuard` in Phase 2, now appearing in a new transport.

### Q7 — Does the widget need real multi-turn conversation memory?
**Answer:** "yes with every message we must have to send previos 5 messages by retriveing them fromdb so that llm can has enough context"

**Score: SOLID.** Correct call, and a reasonable concrete mechanism (recent message history retrieved and included as context). Worth flagging directly for the Design step: Phase 10's `Conversation` entity currently models **one row per single question**, with no column linking sequential turns together into one ongoing session — building "the last 5 messages" requires a real schema addition (something identifying which turns belong to the *same* conversation), not just a query change. This is exactly the kind of real, load-bearing detail worth resolving explicitly in Design rather than discovering mid-build.

### Q8 — Does this phase need its own rate limiting, ahead of Phase 15's full system?
**Answer:** "dont think so"

**Score: SHAKY** — a defensible guess, but without engaging with the real tradeoff. Worth weighing directly: this is the **first genuinely public, unauthenticated-by-login endpoint** in the entire project — protected only by an API key that is, by definition, visible to anyone who views the widget's own embedded script on a public webpage. Without *any* throttle, a single careless or malicious actor who copies that key can hit the endpoint directly (bypassing the widget UI entirely) and generate an unbounded number of real, billed Gemini calls (both embedding and generation) on a business's behalf. Phase 2 already established a real precedent for exactly this situation: a deliberately narrow, Redis-backed stopgap (the login throttle) built *ahead* of Phase 15's eventual full rate-limiting system, specifically because the risk was concrete and immediate, not because Phase 15 didn't exist. The same reasoning applies here and is worth deciding explicitly in Design, not defaulted away.

### Q9 — What does "a separate widget build target" actually mean?
**Answer:** "basically widget will craete a sciot that user can integarte in his site"

**Score: SHAKY** — describes what the *business* experiences, not what makes the *build process* genuinely different. Real answer: the widget's source code gets compiled into a **single, small, self-contained JavaScript file** (via a bundler in "library" mode) that a business references directly (`<script src="...">`), fundamentally unlike the Backend (a long-running server process never shipped to a browser at all) or a future Next.js Frontend (a full application with its own routing and pages, meant to be visited directly rather than embedded inside someone else's page). Three concrete things that make this build different: **bundle size matters enormously** (this script loads alongside a business's *own* JavaScript — bloat directly hurts a page that isn't even Anchor's own), it needs to be **defensively isolated** from whatever else is running on the host page (no global variable collisions, self-contained styling), and its output is a **static file for a CDN**, not a server that needs deploying and running continuously.

### Q10 — What (if anything) should this phase build to make Phase 12's human handoff possible later?
**Answer:** "dont know"

**Score: UNKNOWN.** Real answer, directly extending Q6's room design: scope Socket.IO rooms around a **stable identifier a human agent's future connection could also join** — a conversation/session ID, not just a workspace ID. Concretely, if this phase's rooms are keyed like `conversation:${id}`, then Phase 12 can later have an agent's own socket connection join that *exact same room* and emit into it, reaching the customer with zero rework of this phase's transport layer. What this phase should explicitly **not** build: any agent-facing UI, presence tracking, or claiming mechanism — that's entirely Phase 12's job, the same scope-discipline lesson Phase 10 already applied to its own relationship with Phase 12.

### Q11 — Does the widget give an end customer any persistent identity across a reload?
**Answer (final, after an initial "don't know"):** "yes their should e somethig that can persist conversation on refresh or reload but for soeme time not always"

**Score: SOLID.** Correct, and the caveat ("not always," "for some time") shows real, nuanced thinking — the right shape is a temporary, expiring session identifier (e.g., stored in the browser, valid for some limited window) that lets a conversation resume across a page reload without requiring a permanent, account-like identity for an anonymous end customer who never signed up for anything.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for actually building this phase's code:

1. **Client-visible credentials are a deterrent, not a secret — rate limiting is the real backstop** (Q2, Q8) — the single idea connecting this phase's two weakest answers: an API key sitting in public HTML was never going to be a strong secret, and pretending the allowlist alone solves the abuse problem would leave a real, immediate cost risk unaddressed.
2. **A narrow, targeted ID-obfuscation fix, not a project-wide PK migration** (Q3) — directly closes out the debt CLAUDE.md has carried since Phase 1, and demonstrates that "the original decision had a known tradeoff" doesn't mean the eventual fix has to be as sweeping as reversing the original decision entirely.
3. **Multi-turn conversation requires a real schema change, not just a smarter query** (Q7) — a concrete, load-bearing detail this phase's Design step has to resolve explicitly (how do sequential turns get linked together) rather than assume falls out of existing tables for free.
4. **Room scoping designed for a consumer that doesn't exist yet** (Q6, Q10) — a genuinely different, more forward-looking instinct than most of this project's earlier "don't build ahead" lessons: the point isn't to build Phase 12's feature now, it's to shape *this* phase's design so Phase 12 doesn't require reworking it later.
5. **Bundle size and host-page isolation as real constraints unique to embeddable widgets** (Q9) — a build/deployment concern this project has never faced before, since nothing shipped so far has ever run inside someone else's webpage.

---

## Architecture and decisions

Four increments, each independently buildable and testable, matching how the design was proposed and agreed:

**Increment 1 — Public identity, not the raw PK.** `Workspace` gets two new columns: `publicKey` (a `randomUUID()`, generated once in `AuthService.register()`, unique, and the *only* identifier the widget surface is ever allowed to know about — directly resolving Q3/Phase 1's debt without touching the PK itself) and `allowedOrigins` (a `text[]`, empty by default). A small owner-only `GET/PATCH /workspaces/:workspaceId/widget-settings` endpoint lets a business view its `publicKey` (to paste into their embed snippet) and manage its `allowedOrigins` — `PATCH` is `@Roles(OWNER)`-gated because changing the allowlist is a real security control, not a cosmetic setting.

**Increment 2 — Multi-turn memory, via schema, not a smarter query (Q7).** `Conversation` (Phase 10) gets a nullable, indexed `sessionId`. `AnswerService.answer()` takes an optional `sessionId` and, only once it's confirmed it's actually going to call the LLM (a refused/escalated turn never needed history), fetches the last 5 rows sharing that `(workspaceId, sessionId)` pair and folds them into the system prompt as a labeled "previous turns" section. Scoped by `workspaceId` *and* `sessionId` together — the same tenant-isolation discipline `WorkspaceGuard` has enforced since Phase 2, just enforced by a `WHERE` clause instead of a guard, since there's no guard on this path at all (Q1).

**Increment 3 — The transport (Q4, Q5, Q6, Q10).** A new `WidgetChatModule` with one Socket.IO gateway on the `/widget` namespace. Connection auth is a handshake payload (`{ publicKey, sessionId }`), not a header or a JWT — WebSocket handshakes don't carry `Authorization` the way REST does, and there's no JWT to send here in the first place (Q1). `handleConnection` does three things in order: (1) look up the real `Workspace` by `publicKey`, disconnecting immediately if none matches; (2) check the real `Origin` header against that workspace's `allowedOrigins`, **failing closed** if the list is empty (a business that hasn't configured anything yet gets zero allowed origins, not every origin — a deliberate, explicit choice, not an oversight); (3) join the socket to room `conversation:{sessionId}` (Q6, Q10 — the exact room a future Phase 12 agent connection can join later with zero transport rework). The one message event (`message`) calls `AnswerService.answer()` and broadcasts the result to the whole room (`server.to(room).emit('answer', ...)`) rather than replying only to the sender — the room, not the individual socket, is the unit of delivery.

**Increment 4 — The widget itself (Q9).** A genuinely separate `Widget/` package: vanilla TypeScript, `socket.io-client` as its only runtime dependency, bundled by `esbuild` in library mode into one 44.5kb `dist/widget.js` — no framework, no build step a business ever has to run themselves. Three files: `session.ts` (a `localStorage`-backed session id with a 24h expiry — Q11's "resumable but not forever"), `socket.ts` (a thin wrapper around `socket.io-client`, mirroring the gateway's own `{publicKey, sessionId}` handshake), `ui.ts` (a floating bubble + chat panel rendered inside a **Shadow DOM**, so none of the host page's CSS can reach in and none of the widget's own styles can leak out — the concrete answer to Q9's host-page-isolation concern, not just a stated principle).

**A real, explicit design choice worth naming directly: rate limiting was built now, not deferred to Phase 15 (Q8).** `WidgetRateLimitGuard` mirrors `LoginThrottleGuard`'s exact shape (Redis `INCR` + `EXPIRE`, a fixed window) but keys on `publicKey` rather than IP+email — the credential itself, since that's the thing that's necessarily visible in a public page's HTML and the thing an abuser would actually copy.

## Data flow

A customer's message, end to end:
1. Browser loads a business's page, which includes `<script src=".../widget.js">` and calls `window.Anchor.init({ publicKey, serverUrl })`.
2. The widget reads (or creates) a `sessionId` from `localStorage`, opens a Socket.IO connection to `${serverUrl}/widget` with `auth: { publicKey, sessionId }`.
3. `WidgetChatGateway.handleConnection` resolves `publicKey` → real `Workspace`, checks `Origin` against `allowedOrigins`, joins `conversation:{sessionId}`.
4. Customer types a question; the widget emits `message: { question }`.
5. `WidgetRateLimitGuard` checks/increments the Redis counter for this `publicKey`.
6. `handleMessage` calls `AnswerService.answer(workspaceId, question, sessionId)` — which runs Phase 8's retrieval, Phase 10's confidence check, optionally Increment 2's history fetch, and Phase 9's grounded generation, exactly as it does for the dashboard's own `/ask` endpoint.
7. The result is persisted to `conversations` (now carrying `sessionId`) and broadcast to room `conversation:{sessionId}` — reaching the customer's own socket (and, from Phase 12 onward, any agent socket that later joins the same room).

## Migrations: what each table and column actually stores

**`AddPublicKeyAndAllowedOriginsToWorkspaces`** — two new columns on the existing `workspaces` table:
- `public_key` (`varchar`, `UNIQUE`, `NOT NULL`): a random, unguessable per-workspace token, generated once at registration. This is the *only* workspace identifier the public widget surface is ever given — never the integer `id`. Looking one up immediately resolves to the real internal `id` for every downstream query; the random value never appears in a join or a foreign key anywhere.
- `allowed_origins` (`text[]`, default `'{}'`): the list of exact origins (`scheme://host[:port]`, no path) this workspace's widget is permitted to run from. Empty by default — a brand-new workspace's widget accepts connections from nowhere until its owner explicitly configures at least one origin.

**`AddSessionIdToConversations`** — one new column on the existing `conversations` table:
- `session_id` (`varchar`, nullable, indexed): groups sequential turns of the same widget conversation together. `NULL` for anything asked outside the widget (e.g. the dashboard's own manual test-the-AI calls via `/ask` with no `sessionId`) — there's no ongoing session to group those into. Client-generated (the widget's own `localStorage` value), never assigned by the server.

Both migrations hit the same real, recurring bug: `migration:generate`'s diffing still doesn't understand the Phase 8 HNSW index's `USING hnsw` clause, and tried to silently drop and recreate it as a plain (non-HNSW) index both times. Caught and hand-stripped from the generated `up`/`down` methods before running, exactly as Phase 10 first did — now three phases running into the identical tool limitation.

## Code walkthrough

### `Backend/src/database/entities/workspace.entity.ts`

```ts
// The only identifier ever exposed to the public widget surface — never `id`. Generated
// once at workspace creation (see AuthService.register), the same pattern Phase 3 already
// used for Document.storageKey: a random value set in application code, not a DB default.
@Column({ name: 'public_key', unique: true })
publicKey: string;

// Domains the widget is allowed to run on for this workspace. A real, checked allowlist
// (Phase 11's design), not a strong secret on its own — see the phase doc's Q2 for why.
@Column({ name: 'allowed_origins', type: 'text', array: true, default: '{}' })
allowedOrigins: string[];
```
Two new columns, sitting between `name` and `createdAt`. `publicKey` is what the widget hands the backend to say "I belong to this workspace"; `allowedOrigins` is the allowlist checked against it. Both live on `Workspace`, not a separate table, since there's exactly one of each per workspace.

### `Backend/src/modules/auth/auth.service.ts:41`

```ts
const workspace = await this.workspaces.save({ name: dto.workspaceName, publicKey: randomUUID() });
```
`publicKey` is generated the moment a workspace is created — never lazily, never on first widget use. A workspace that has never touched the widget feature still has a valid, usable `publicKey` sitting in the database from day one.

### `Backend/src/modules/workspaces/workspaces.controller.ts:31-44`

```ts
@Get('widget-settings')
getWidgetSettings(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
  return this.workspacesService.getWidgetSettings(workspaceId);
}

@Patch('widget-settings')
@Roles(MembershipRole.OWNER)
updateWidgetSettings(
  @Param('workspaceId', ParseIntPipe) workspaceId: number,
  @Body() dto: UpdateAllowedOriginsDto,
) {
  return this.workspacesService.updateAllowedOrigins(workspaceId, dto.allowedOrigins);
}
```
`GET` is open to any member (same tier as `GET .../members`) — reading your own `publicKey` to paste into an embed snippet isn't sensitive. `PATCH` is `@Roles(OWNER)`-gated, matching the pattern `PATCH .../members/:userId` already established in Phase 2 — changing which domains can use your widget is a real security-relevant action, not a cosmetic setting.

`Backend/src/modules/workspaces/dto/update-allowed-origins.dto.ts`:
```ts
const ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;

export class UpdateAllowedOriginsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: '...' })
  allowedOrigins: string[];
}
```
Rejects anything with a path or trailing slash at the validation layer, before it ever reaches the database — origins are compared byte-for-byte against the browser's `Origin` header later, and that header never contains a path.

### `Backend/src/database/entities/conversation.entity.ts:28-35`

```ts
@Index()
@Column({ name: 'session_id', type: 'varchar', nullable: true })
sessionId: string | null;
```
Indexed because `fetchRecentHistory` (below) filters by it on every widget message; nullable because the dashboard's own manual `/ask` calls have no session to belong to.

### `Backend/src/modules/answer/answer.service.ts`

```ts
// :34
async answer(workspaceId: number, question: string, sessionId: string | null = null): Promise<AnswerResult> {
```
`sessionId` defaults to `null` — every existing caller (the dashboard's `/ask` endpoint, all of Phase 9/10's tests) keeps working unchanged; only the widget gateway ever passes a real one.

```ts
// :60
const history = sessionId ? await this.fetchRecentHistory(workspaceId, sessionId) : [];
```
This line only runs *after* the confidence short-circuit at `:47` has already decided the LLM is actually going to be called — a refused or escalated turn returns before ever reaching this line (Q8's answer, confirmed correct).

```ts
// :90-97
private async fetchRecentHistory(workspaceId: number, sessionId: string): Promise<Conversation[]> {
  const rows = await this.conversations.find({
    where: { workspaceId, sessionId },
    order: { createdAt: 'DESC' },
    take: 5,
  });
  return rows.reverse();
}
```
`WHERE workspace_id = ? AND session_id = ?` — both conditions together, so one workspace's history can never bleed into another's prompt even if two workspaces somehow shared a `sessionId` string. `DESC` + `take: 5` gets the 5 *most recent* rows; `.reverse()` puts them back in chronological (oldest-first) order for the prompt, since a transcript should read top-to-bottom in the order it happened, not in query order.

### `Backend/src/modules/widget-chat/widget-chat.gateway.ts` — the entire public contract in one file

```ts
// :48-75
async handleConnection(client: Socket): Promise<void> {
  const publicKey = client.handshake.auth?.publicKey as string | undefined;
  const sessionId = client.handshake.auth?.sessionId as string | undefined;
  const origin = client.handshake.headers.origin;

  if (!publicKey || !sessionId) {
    client.disconnect(true);
    return;
  }

  const workspace = await this.workspaces.findOne({ where: { publicKey } });
  if (!workspace) {
    client.disconnect(true);
    return;
  }

  if (!origin || !workspace.allowedOrigins.includes(origin)) {
    this.logger.warn(`Rejected widget connection for workspace ${workspace.id}: origin "${origin}" not allowed`);
    client.disconnect(true);
    return;
  }

  this.connections.set(client.id, { workspaceId: workspace.id, sessionId });
  await client.join(conversationRoom(sessionId));
}
```
Three checks, in order, each an immediate `disconnect(true)` on failure: missing credentials → unknown `publicKey` → disallowed (or absent) `origin`. Only after all three pass does the socket get tracked and joined to its room. Note `workspace.id` (the real integer PK) is what gets stored for later use — `publicKey` did its one job (identifying *which* workspace) and is never needed again for the rest of the connection's lifetime.

```ts
// :89-103
@UseGuards(WidgetRateLimitGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: (errors) => new WsException(errors) }))
@SubscribeMessage('message')
async handleMessage(@ConnectedSocket() client: Socket, @MessageBody() dto: WidgetMessageDto): Promise<void> {
  const connection = this.connections.get(client.id);
  if (!connection) {
    client.disconnect(true);
    return;
  }

  const result = await this.answerService.answer(connection.workspaceId, dto.question, connection.sessionId);
  this.server.to(conversationRoom(connection.sessionId)).emit('answer', result);
}
```
The rate-limit guard runs *before* this method body — a throttled caller never reaches `answerService.answer()` at all, so a copied, abused key can't run up real Gemini costs past the 20/minute ceiling. The final line is a room broadcast, not `client.emit(...)` — see Q6/Q11 in the closing quiz below for exactly why that distinction matters.

### `Backend/src/modules/widget-chat/widget-rate-limit.guard.ts`

```ts
const key = `widget-messages:${publicKey}`;
const count = await this.redis.incr(key);
if (count === 1) {
  await this.redis.expire(key, WINDOW_SECONDS);
}
if (count > MAX_MESSAGES) {
  throw new WsException('Too many messages. Please slow down.');
}
```
Identical shape to Phase 2's `LoginThrottleGuard` (`INCR` then `EXPIRE`-only-on-the-first-hit, a classic fixed-window counter), just keyed on `publicKey` instead of `email:ip`, and throwing `WsException` (the WS-context equivalent of `HttpException`) instead.

### `Widget/src/session.ts`, `socket.ts`, `ui.ts`, `index.ts`

`session.ts`'s `getOrCreateSessionId()` reads a `{ sessionId, expiresAt }` JSON blob from `localStorage`, returning the stored id only if `expiresAt > Date.now()`; otherwise it mints a fresh `crypto.randomUUID()` and stores it with a new 24h expiry. Every `localStorage` call is wrapped in `try/catch` — private browsing or a user with storage disabled shouldn't crash the widget, just lose cross-reload resumption.

`socket.ts`'s `connectWidgetSocket()` is a thin wrapper: it opens `io('${serverUrl}/widget', { auth: { publicKey, sessionId } })` and wires the gateway's `answer`/`exception`/`connect_error` events to two callbacks (`onAnswer`, `onError`) the caller provides.

`ui.ts`'s `buildWidgetUI()` calls `host.attachShadow({ mode: 'open' })` and appends a `<style>` element containing `:host { all: initial; }` before building the bubble/panel/message-list DOM inside that shadow root — see Q10 in the closing quiz for exactly what this buys over a plain `<div>`.

`index.ts` is the one public entry point: `window.Anchor.init({ publicKey, serverUrl })` gets a `sessionId` from `session.ts`, builds the UI from `ui.ts`, opens the socket from `socket.ts`, and wires `ui.onSubmit(...)` → `sendQuestion(socket, question)` and the socket's `onAnswer` callback → `ui.appendMessage('assistant', ...)`. Nothing outside this file is ever called directly by a business embedding the widget.

## Failure cases actually tested

1. **Disallowed origin — predicted and confirmed.** A connection whose `Origin` header isn't in the workspace's `allowedOrigins` is disconnected immediately by the server (`widget-chat.e2e.spec.ts`, "rejects a connection from an origin not on the workspace's allowlist").
2. **Unconfigured workspace fails closed — predicted and confirmed.** A workspace with an empty `allowedOrigins` (the default for every newly registered workspace) accepts connections from *no* origin, not every origin, until its owner explicitly configures at least one.
3. **Origin-checking is a header check, not a cryptographic guarantee — the concrete proof behind Q2.** Every "accepts a connection" test in this suite uses `socket.io-client` running in Node — not a real browser — setting an arbitrary `Origin` header via `extraHeaders`. That a non-browser test client can successfully claim to "be" an allowed origin and get through *is itself* the demonstration: nothing here cryptographically verifies where a connection actually came from, it only checks what the caller claims in a header it fully controls. A real browser is honest about this header; a bare script never has to be.
4. **A client disconnecting before its answer arrives — predicted and confirmed.** Predicted: the in-flight `AnswerService.answer()` call keeps running to completion server-side even after the triggering socket is gone (a JS promise doesn't get cancelled just because nobody's listening anymore), and Socket.IO's `.to(room).emit()` against a now-empty room (nobody left to broadcast to) is a documented no-op, not a throw. Triggered for real with an artificially slowed generation provider: emitted a message, disconnected immediately, waited past the artificial delay, then opened a *new*, unrelated connection and confirmed it got a normal, correct answer — proving the server didn't crash, leak the dead connection's state, or degrade for the next real customer.
5. **Rate limit firing for real — predicted and confirmed.** 20 real round trips succeed; the 21st receives a real `WsException` ("Too many messages...") via Socket.IO's `exception` event, backed by a real Redis `INCR`/`EXPIRE`, not a mock.
6. **Cross-session leakage — predicted and confirmed.** Two sockets, same workspace, different `sessionId`s: a message sent on one session is never delivered to the other, proving the room-per-session scoping (not just room-per-workspace) actually holds.

## Tests and why

`test/widget-chat.e2e.spec.ts` (7 tests) — the gateway's entire public contract, all against a real Postgres, real Redis, and a real `socket.io-client`, with only the LLM generation call substituted (to keep tests fast, deterministic, and independent of the day's Gemini quota — retrieval/embedding stay real):
- the happy path (connect, ask, get a real routed answer)
- disallowed origin rejected
- unknown public key rejected
- empty allowlist fails closed
- session-to-session isolation
- the mid-flight disconnect survival case
- the 20/minute rate limit

`test/answer.e2e.spec.ts` (+2 tests) — proves multi-turn history actually reaches the prompt (a prior same-session turn's question/answer text is asserted present in the captured system prompt) and that a *different* session's history never leaks in.

Existing suites (`document-embedding.processor.spec.ts`, `document-processing.e2e.spec.ts`, `schema.integration.spec.ts`) needed real fixture fixes: each built a `Workspace` row directly (bypassing `AuthService.register()`), which broke once `public_key` became `NOT NULL` — a concrete, expected consequence of tightening the schema, not a bug in the new code.

## Reverse-engineering guide

If this phase is reopened in six months: start at `Backend/src/modules/widget-chat/widget-chat.gateway.ts` — it's the entire public contract in one file. `handleConnection` is where every security decision in this phase actually lives (public key lookup, origin check, room join); `handleMessage` is where the existing Phase 8-10 pipeline gets reused unchanged via `AnswerService`. From there, `Backend/src/modules/answer/answer.service.ts`'s `fetchRecentHistory`/`buildSystemPrompt` show how multi-turn memory was bolted onto an already-working single-turn flow without changing its core logic. `Widget/src/index.ts` is the widget's one public entry point — everything else (`session.ts`, `socket.ts`, `ui.ts`) is a dependency of it. `test/widget-chat.e2e.spec.ts` is the most complete executable specification of the whole phase's intended behavior — read it before changing the gateway.

---

## Closing quiz

11 questions, re-asked in light of the actual built code, answered in one batch. **Result: 2 SOLID / 6 SHAKY / 3 UNKNOWN** — a real drop from the opening diagnostic's 6/3/2, echoing a pattern this project has seen before (Phase 2's closing quiz, most sharply): watching something work and being able to explain its exact mechanism are genuinely different skills, and this phase's closing quiz leaned much more on the specific "why," not just the general shape.

### Q1 — Why does the widget authenticate over a handshake payload instead of anything resembling Phase 2's JWT flow?
**Answer:** "beacuse on side there will be no login or acces token thing"

**Score: SOLID.** Correct and consistent with the opening diagnostic's Q1 — there's no logged-in user on this side at all, so there's no access token to check in the first place.

### Q2 — What exactly does `Workspace.publicKey` protect against, and what does it not?
**Answer:** "they use to prevent id guess attacks"

**Score: SHAKY.** Half right, and worth being precise about which half: `publicKey` (Q2) genuinely does prevent ID-*enumeration* — `WidgetChatGateway.handleConnection` (gateway.ts:58) looks a workspace up by `publicKey`, never by iterating `id`s, so nobody can discover "workspace 1, 2, 3... exist" by guessing. But that's actually closer to Q3's original concern (the raw-integer-ID risk) than a full answer to what `publicKey` does and doesn't protect. What's missing: `publicKey` alone verifies nothing about *who* is connecting — it's "know this string, get treated as this workspace's widget," full stop. If a `publicKey` leaks (copied out of a public page's HTML — it's not a secret, it's meant to be embedded), anyone who has it can attempt to use it from anywhere; what actually stops that is the layer built *alongside* `publicKey` in this same phase — `allowedOrigins` (checked at gateway.ts:67) and the rate limiter — not `publicKey` itself. `publicKey` solves "which workspace," not "is this really allowed."

### Q3 — Why keep both `Workspace.id` and `publicKey` instead of switching the whole table to a random-token PK?
**Answer:** "so this is for ancho to abckend req flow and publicksy is for widget to backend flow"

**Score: SHAKY.** There's a real, correct instinct here — internal flows and the public widget flow do use different identifiers — but the actual reasoning wasn't landed. Three concrete reasons to keep both: (1) every foreign key in this schema (`Membership.workspaceId`, `Document.workspaceId`, `Conversation.workspaceId`, and more) already references the integer `id` — switching the whole table's PK would mean touching every join and every index across the schema for a problem that exists at exactly one boundary; (2) integer PKs are cheaper — smaller, and naturally sequential for B-tree index locality, where random UUIDs fragment insert order; (3) this is literally CLAUDE.md's own Phase 1 decision playing out as designed: "auto-increment integers, chosen knowingly despite the enumeration-risk tradeoff... debt to repay at Phase 11" — the plan was always a scoped mitigation at the one exposed boundary, not reversing the original call.

### Q4 — Why does the gateway check `Origin` itself instead of relying on `cors: { origin: true }`? What's different about a WebSocket handshake's CORS?
**Answer:** "so in webaokcte handshake we jst validate first time when FE send us http req with urgrade to socket req while in rest callas we validate on every req"

**Score: SHAKY.** True but answering a different question — once-at-handshake vs. every-request is a real difference, but not *why* `handleConnection` has to manually check `Origin`. The actual answer: browsers block a cross-origin `fetch`/`XMLHttpRequest` response from reaching JS code unless the server's CORS headers explicitly allow it — that blocking is a `fetch`/XHR-specific browser behavior. A WebSocket handshake (technically an HTTP request with an `Upgrade: websocket` header) is **not** subject to that same browser-enforced blocking at all — a browser will happily let page JavaScript open a WebSocket to any origin and read whatever comes back, regardless of what CORS policy the server declares. `cors: { origin: true }` on `@WebSocketGateway` only affects Socket.IO's HTTP-polling fallback transport (real XHR under the hood) — it does nothing for the actual WebSocket transport's ability to connect. That gap is exactly why `handleConnection` (gateway.ts:51, 67) manually reads `client.handshake.headers.origin` and checks it by hand — there's no browser-level gate to lean on the way there is for a REST call.

### Q5 — Why fail *closed* on an empty `allowedOrigins` rather than fail *open*?
**Answer:** "dont knwo"

**Score: UNKNOWN.** Real answer: `allowedOrigins` defaults to `'{}'` for every newly registered workspace, and `publicKey` exists from the same moment (`auth.service.ts:41`) — so the instant someone registers, they have a fully valid, usable `publicKey`, before they've ever configured anything. If an empty allowlist meant "no restriction configured, so allow everything," every brand-new workspace's widget would be silently usable from *any* website in the world until its owner remembered to lock it down — a real, immediate exposure window with zero upside. Failing closed instead means the widget simply doesn't work anywhere until the owner deliberately adds a real origin — a one-time setup step traded for eliminating that whole window. This is the same instinct behind a firewall that denies all traffic by default until rules explicitly permit it, rather than the reverse: an unconfigured or misconfigured "allow" default is one of the most common real categories of access-control bug.

### Q6 — Why broadcast the answer to the whole room instead of sending it directly to the sender's socket?
**Answer:** "so that sender ca also see what he messges"

**Score: SHAKY.** True — a room broadcast does reach the sender, since they're a member of the room they just joined. But that's not *why* a room was used at all: `client.emit('answer', result)` would *also* reach only the sender, just as directly. The real reason is Q10/Q11's forward-compatibility: this exact line (gateway.ts:102) will keep working unchanged once Phase 12 gives a human agent their own socket connection into the *same* room — the agent just joins `conversation:{sessionId}` and starts receiving the identical broadcasts the customer already gets. If this code instead targeted `client` directly, a Phase 12 agent joining the room would receive nothing, because the message was addressed to one specific socket, not the room — and this file would need editing just to add a second recipient.

### Q7 — What actually happened, and why didn't it crash, when a client disconnected before its answer arrived?
**Answer:** "so after sending message client hit send message event and disconnected now server will do all its processing but since cient is disconnect it cannot se the answer"

**Score: SHAKY.** Correctly describes *what* happens (processing continues; the disconnected client never sees the result) but not *why nothing broke* — the actual mechanism asked for. Two real facts, not luck: (1) Node's event loop doesn't tie a running `async` function's lifetime to any particular caller being present — once `handleMessage` calls `await this.answerService.answer(...)` (gateway.ts:97), that promise chain keeps executing exactly as scheduled; nothing cancels it just because the triggering socket disconnected (that would require deliberately building something like an `AbortController`, which this phase didn't). (2) When that promise resolves and reaches `this.server.to(room).emit('answer', result)` (gateway.ts:102), Socket.IO's room broadcast is designed to tolerate a room with zero members — it looks up who's currently in the room and sends to each of them; zero recipients means it does nothing further, not an exception. Both are documented, deliberate behaviors this test relied on, not things the project got lucky with.

### Q8 — Why is history only fetched after the confidence check already decided to call the LLM?
**Answer:** "because there is no point of retriveig history from Database when we are not going to req llm api it will costuse extra database query"

**Score: SOLID.** Exactly right, and matches the actual code (`answer.service.ts:60` runs after the short-circuit at `:47`) — a refused or escalated turn never pays for a query whose only purpose is building a prompt that's never going to be sent.

### Q9 — Why key the rate limiter on `publicKey` rather than IP address or socket id?
**Answer:** "because we have to implement it on whole workspace widgte not allowing single person to do 20 req per minutue"

**Score: SHAKY.** The guard doesn't actually reason about "the whole workspace" at all — `widget-rate-limit.guard.ts` reads `client.handshake.auth?.publicKey` directly, with no workspace lookup involved. The real reason to key on `publicKey`: it's the one credential that's visible, by construction, to anyone who views the source of a page the widget runs on — meaning it can be copied and reused from a different machine, a different IP, a script instead of a browser. If the throttle were keyed on IP instead, someone who copied the key could route requests through many different IPs (proxies, a botnet, serverless functions) and each one would get its own fresh 20/minute allowance — the IP was never the real identity of the abuser, the copied key is. Keying on the key itself means every use of that one key shares the same bucket, no matter how many machines it's used from.

### Q10 — What would actually go wrong if the widget's UI weren't rendered inside a Shadow DOM?
**Answer:** "dont know"

**Score: UNKNOWN.** Real answer, two concrete failure directions: (1) *the host page could break the widget* — without a Shadow DOM, the widget is just a `<div>` in the same global CSS cascade as the host page. A rule the business's own site already has, like `button { all: unset; }` or a global `div { margin: 0 !important; }`, would apply to the widget's elements too, since nothing stops it — potentially breaking the send button or collapsing the panel's layout. (2) *the widget could break the host page* — this project's class names (`.message`, `.panel`, `.input` in `ui.ts`) are generic enough to plausibly collide with class names the host page already uses for unrelated elements, silently applying the widget's fixed positioning, colors, and `z-index: 999999` to random parts of the business's own site. A Shadow DOM (`host.attachShadow({ mode: 'open' })`) creates a genuinely separate DOM subtree with its own isolated style scope — CSS inside it can't leak out, and CSS outside it can't reach in — a real, browser-enforced boundary, not a naming convention like BEM that only reduces collision *probability*. `:host { all: initial; }` goes one step further and resets properties that *do* normally inherit across a shadow boundary (font, color, line-height) back to browser defaults, so the widget always renders as designed regardless of what the host page sets globally.

### Q11 — What's still missing for Phase 12, and what did this phase build now to make it easier later?
**Answer:** "dont know"

**Score: UNKNOWN.** Still missing: presence tracking (which agents are online), a claim mechanism (which agent picks up an escalated conversation, including the race of two agents claiming the same one), an entire agent-facing console UI, and a way for an agent's reply to reach the customer live — none of which exist yet. What this phase already built to make that last piece trivial: the room-per-session design. `conversationRoom(sessionId)` (gateway.ts:25-27) and the join at `handleConnection` (gateway.ts:74) mean a future agent connection just has to `.join()` that same room string, and `this.server.to(room).emit(...)` (gateway.ts:102) — the exact line already written and tested in this phase — delivers an agent's messages to the customer with zero changes to this file. The alternative (Phase 11 emitting directly to the customer's own socket reference) would force a real rewrite in Phase 12 just to add a second recipient. This is the same underlying gap as the opening diagnostic's Q10 — flagged there as UNKNOWN, and still UNKNOWN here after the code was actually built, not just designed. Worth treating as a standing, not-yet-landed weak spot rather than assuming the build experience alone fixed it.

---

## Topics to master

Ranked by leverage, combining gaps from both the opening diagnostic and the closing quiz, reframed as transferable software-engineering skills rather than Anchor-specific trivia:

### 1. Same-origin policy and why WebSocket handshakes are exempt from CORS enforcement
**Search:** "does CORS apply to websockets", "websocket cross origin security browser", "why can a website open a websocket to any origin"
**Exposed by:** Q4 (opening diagnostic SOLID on REST CORS; closing quiz SHAKY on the WebSocket-specific exemption)
**Why it matters beyond this project:** Any engineer building a real-time feature (chat, live dashboards, collaborative editing, live notifications) alongside a REST API eventually assumes "I configured CORS" protects both transports equally — it doesn't. WebSocket connections need their own, explicit server-side origin check; there's no browser-enforced gate to lean on the way there is for `fetch`/XHR.

### 2. Fail-closed vs. fail-open defaults in security-relevant code
**Search:** "fail closed vs fail open", "secure by default design", "default deny vs default allow access control"
**Exposed by:** Q5 — UNKNOWN in the closing quiz, and the underlying reasoning was never explicitly asked in the opening diagnostic either, so this is a genuinely fresh, unaddressed gap, not a regression.
**Why it matters beyond this project:** A huge share of real access-control incidents trace back to a control that silently becomes permissive when unconfigured, misconfigured, or in an error state — an empty allowlist, a failed permission check that defaults to "allow," a feature flag with no explicit off-state. Asking "what should happen when nothing has been configured yet, or when this check itself fails" is a question that applies to permissions, rate limits, and feature flags everywhere, not just one `allowedOrigins` array.

### 3. Shadow DOM as real DOM/CSS encapsulation, vs. naming-convention isolation (BEM, CSS Modules)
**Search:** "shadow dom vs css modules", "attachShadow mode open explained", "web component style encapsulation"
**Exposed by:** Q10 — UNKNOWN in the closing quiz.
**Why it matters beyond this project:** Anyone building an embeddable widget, a browser extension's content script, or a component meant to drop into an unknown host page runs into this exact problem. Knowing that Shadow DOM is a genuine, browser-enforced boundary — not a convention that only reduces collision odds — is the difference between "should be fine" and "actually guaranteed," and it's a skill that transfers directly to any third-party-embeddable product.

### 4. Designing today's code so tomorrow's consumer doesn't require a rewrite
**Search:** "designing for extensibility software", "forward compatible api design", "publish subscribe pattern future consumers"
**Exposed by:** Q6 (closing quiz SHAKY) and Q11/opening-Q10 (UNKNOWN in *both* the opening diagnostic and the closing quiz — the single gap that's persisted across this entire phase without moving).
**Why it matters beyond this project:** The room-broadcast-instead-of-direct-emit choice here is one instance of a broader, senior-level instinct: recognizing which small, cheap decisions made now (broadcast to a named group vs. a specific recipient) avoid an expensive rewrite later, without over-engineering for a feature that doesn't exist yet. This is the exact judgment call that separates code that merely satisfies today's ticket from code a team doesn't regret in two sprints.

### 5. Internal surrogate keys vs. public-facing tokens (obfuscated-ID pattern)
**Search:** "surrogate key vs natural key api design", "obfuscated id pattern", "why does stripe use cus_xxx instead of an integer id"
**Exposed by:** Q3 — SHAKY in the closing quiz, and the opening diagnostic's Q3 only landed the risk half, not the fix's actual reasoning.
**Why it matters beyond this project:** This exact pattern (a fast, simple, sequential internal PK for every join, plus a separate random public-facing identifier at the one boundary untrusted parties touch) is how most real production APIs handle this tradeoff (Stripe's `cus_xxx`, GitHub's repo slugs). Recognizing when a small, targeted addition beats reversing an entire architectural decision is a transferable judgment call, not an Anchor-specific fact.

### 6. A running async operation outlives the connection that triggered it
**Search:** "javascript promise continues after disconnect", "does closing a websocket cancel a pending request", "node.js abortcontroller cancel async operation"
**Exposed by:** Q7 — SHAKY; correctly described the observed behavior without landing the mechanism.
**Why it matters beyond this project:** Any server handling a slow operation (an LLM call, a payment, a long query) triggered by a connection that might drop mid-flight needs to reason about this exactly. The default in Node (and most async runtimes) is that in-flight work keeps running unless something explicitly cancels it — real cancellation (an `AbortController`, a cancellation token) has to be built deliberately. Assuming "the client left, so the work stopped" is a common, incorrect assumption.

### 7. Credential-based rate limiting vs. IP-based rate limiting
**Search:** "rate limit by api key vs ip address", "why rate limit on credential not ip", "distributed rate limiting shared secret"
**Exposed by:** Q9 — SHAKY; named a true-but-different reason (workspace-wide limiting) instead of the actual one (the credential itself is the thing that gets copied and reused).
**Why it matters beyond this project:** Any system exposing an API key, token, or other client-visible credential has to decide what identity to throttle on. IP-based limiting is trivially defeated by anyone with access to multiple IPs (which is cheap and common); keying on the credential itself closes that gap, because every use of a given key — from anywhere — shares one bucket. This is the same reasoning behind API providers like Stripe or OpenAI rate-limiting per API key rather than per source IP.

## Interview questions this phase generates

- "Your API needs both a public, embeddable widget and an authenticated dashboard. Walk me through how you'd design the widget's authentication, and why it can't just reuse the dashboard's login flow."
- "Explain why configuring CORS on a REST endpoint doesn't automatically protect a WebSocket endpoint the same way."
- "You're adding a public API key to a product. What can that key alone actually guarantee, and what do you still need on top of it?"
- "Describe a time — real or hypothetical — where a security control should fail closed rather than fail open, and what would go wrong with the opposite choice."
- "How would you design a real-time chat feature today so that adding a second type of participant (e.g., a human agent) later doesn't require rewriting the message-delivery code?"
- "What happens, mechanically, if a client disconnects while the server is still processing their request? Does the work stop? Why or why not?"
- "Why might rate-limiting by API key be more effective than rate-limiting by IP address for a publicly embeddable product?"
- "What's the actual difference between Shadow DOM and just using carefully-namespaced CSS classes?"

## What's still not understood

Three topics went UNKNOWN on both the *concept* and its *concrete application in this codebase* — not partial gaps, genuine first exposures that didn't land:
- **Fail-closed vs. fail-open reasoning** (Q5) — never explicitly taught before this phase; a good candidate for direct re-exposure early in Phase 12, which will introduce its own new access-control surface (agent claiming) where the same question will recur.
- **Shadow DOM / real style encapsulation** (Q10) — a one-off concept for this project (no other phase touches the DOM at all), so there's no natural later phase that will re-exercise it; worth a standalone follow-up if the Frontend (Next.js dashboard) ever needs similar embeddable-widget-style isolation.
- **Designing for a future consumer via room/broadcast scoping** (Q11, same gap as the opening diagnostic's Q10) — this is the one item that's persisted, unmoved, across *two* full exposures now (opening diagnostic and closing quiz), unlike Phase 5's `job.updateProgress()` pattern (three exposures) but heading the same direction if left unaddressed. **Phase 12 is the direct, concrete test of whether this ever lands** — it will require literally implementing the agent-joins-the-room mechanism this topic describes, so treat Phase 12's own diagnostic score on this exact idea as the real signal, not this phase's.