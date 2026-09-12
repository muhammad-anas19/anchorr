# Phase 2 — Auth & RBAC

## Objective

Real login, sessions/tokens, and role-based access control (Owner/Agent/Viewer), matching the Settings → Team screen from the prototype. This is also where Phase 1's `TenantContextService` design finally gets built — there was no authenticated request to extract a `workspace_id` from until now.

## Why the system needs this

Every dashboard endpoint needs to answer two questions before it does anything else: *who* is making this request, and *which workspace* are they acting within. Phase 1 built the schema (`Membership` rows linking users to workspaces with a role) but deliberately left the enforcement gap open — nothing currently stops a query from crossing tenant boundaries, because there's no authenticated request yet to scope it to. This phase closes that gap for real.

---

## The diagnostic

10 questions asked up front, answered in one batch, scored honestly.

### Q1 — Authentication vs authorization
**Asked:** What's the actual difference between authentication and authorization, and where does each happen in a typical request to a protected endpoint?
**Answer:** "so the authentication is the process of verifying user credentials is the email/username and password matches to what we have in db? and when it is verified than we do authorization like checks what action that user can perform and what permissions it has"
**Score: SOLID.** Correct, complete, and in the right order — verify identity first (authentication), then check what that verified identity is allowed to do (authorization). No gap to teach here.

### Q2 — Why bcrypt, not SHA-256
**Asked:** What does bcrypt actually do differently from something like plain SHA-256, and why does that matter specifically for password storage?
**Answer:** "basically brcypt is cpu heavy it requires more computions time to hash a passport than sha so a attacker with multiple test password like in billion can be use to login in econds while brcypt ttakes years"
**Score: SHAKY.** The "deliberately slow to resist brute force" mechanism is correct — that's real and important. Missing: **salting**. SHA-256 (and most general-purpose hash functions) will produce the exact same output for the exact same input every time, with no built-in per-password randomness. That means two users with the password `"password123"` get identical hashes in the database — and an attacker can precompute a giant table of hash→password mappings once (a "rainbow table") and instantly reverse *any* password that's in it, for *any* user, without ever touching your specific database. bcrypt bakes a random salt into every hash it produces (it's actually stored as part of the output string itself), so the same password hashes differently for every user, and a precomputed rainbow table becomes useless — the attacker would have to brute-force each hash individually, which is exactly where bcrypt's deliberate slowness (its "cost factor") then makes the brute force expensive too. Both properties — salting and slowness — are doing different jobs, and password-hashing-specific mattered.

### Q3 — Session-based auth vs JWT
**Asked:** What's the actual mechanism difference, and what's the real tradeoff for a project like this one?
**Answer:** "so in session based auth we store token in db after login and on every req we have to query db to verify what each req acarry where a jwt is stateless and we dont have to store anywhere also it can carry the imp info like userid role that we can use for verifcation without querying db."
**Score: SOLID.** Correct mechanism on both sides: session auth requires a database (or Redis) lookup on every request to confirm the session is still valid; JWTs are self-contained and verifiable via signature alone, at the cost of the server no longer being the source of truth for "is this still valid" on every single request. No gap to teach here.

### Q4 — Guard lifecycle position
**Asked:** Where does a Guard actually run relative to middleware and interceptors, and what does a Guard return to signal "reject this request"?
**Answer:** "it runs before middleware or interceptor,"
**Score: UNKNOWN.** This has the order backwards. The actual NestJS request pipeline, in order: **Middleware → Guards → Interceptors (pre-handler) → Pipes → Route Handler → Interceptors (post-handler) → Exception Filters (if anything throws, at any stage).** Middleware runs first because it's inherited from the underlying Express/Fastify layer and has no concept of "which controller method will handle this" yet — it just sees raw requests. Guards run next specifically because they *do* have access to execution context (which controller, which handler, what metadata/decorators are on it via `Reflector`) and their entire job is a yes/no gate: a Guard's `canActivate()` method returns (or resolves to) `true` to let the request continue, or `false`/throws an exception (typically `UnauthorizedException` or `ForbiddenException`) to reject it immediately — the route handler never runs at all if a Guard returns `false`.

### Q5 — How a custom `@CurrentUser()` decorator gets its data
**Asked:** Mechanically, where does the data that decorator returns actually come from at runtime?
**Answer:** "so on every req we will get access token fro where we will take userid from payload of token and than we will pass it to currentuser deco and it give us the info about that user"
**Score: SHAKY.** The data flow direction (token → user info available in the controller) is right, but the mechanism of *how* is conflated. A custom parameter decorator like `@CurrentUser()` is built with `createParamDecorator()`, and its factory function receives an `ExecutionContext` — from that, it calls `context.switchToHttp().getRequest()` and reads a property off the raw request object, typically `request.user`. **The decorator itself never touches the JWT or decodes anything** — that work already happened earlier in the pipeline, inside a Guard (per Q4's ordering: Guards run before the request ever reaches parameter resolution). A JWT auth guard verifies the token's signature, decodes its payload, and attaches the result as `request.user` — the `@CurrentUser()` decorator's entire job is just "read `request.user` and hand it to the controller method." This is why Guards and custom decorators are almost always built as a pair: the Guard does the real work and stashes the result on the request; the decorator is just a convenient, typed way to read it back out.

### Q6 — What "request-scoped" means for a NestJS provider
**Asked:** What does "request-scoped" actually mean, and what's the performance tradeoff versus the default (singleton) scope?
**Answer:** "so for every req we will find the workspace id based on userid hats the tradeoff that we have to query db fr every req but using it we can make sure to assign worksace id in every db query wihtout leaking the data of oter workspaces."
**Score: UNKNOWN.** This answers a different question — *what the TenantContextService's business logic does* (look up workspace by user, use it to scope queries) — rather than what request scope *is* as a NestJS dependency-injection concept. The actual answer: by default, every `@Injectable()` provider in NestJS is a **singleton** — Nest constructs it exactly once, ever, when the application boots, and every request shares that same single instance. A **request-scoped** provider (`@Injectable({ scope: Scope.REQUEST })`) is the opposite: Nest constructs a **brand-new instance of it for every single incoming request**, and throws it away when that request finishes. This is what actually makes a `TenantContextService` viable at all — a singleton couldn't hold "the current request's workspace ID" as a property, because every concurrent request would be overwriting the same shared instance's data (a serious bug: user A's workspace ID leaking into user B's request if their requests overlap in time). The real performance tradeoff isn't about database queries — it's that Nest has to build a fresh object (and rebuild anything else in that dependency chain that also isn't a singleton) on every request instead of reusing one object for the app's entire lifetime, which is real but usually small overhead. The db-lookup-per-request cost mentioned in the answer is a separate, valid concern, but it's about the *business logic* the service happens to run, not about what request scope itself costs or means.

### Q7 — Where role checks should live
**Asked:** Where should "is this user allowed to do X in this workspace" live, and why does that choice matter as routes grow?
**Answer:** "so using quard we will get userid and based on that we can chekc its role and than we wcan create a deco for roles and assign it on top of controller like role(owner) now if user has owner role only than it can access that controller."
**Score: SOLID.** This is exactly the standard NestJS RBAC pattern: a `@Roles('owner')` decorator attaches metadata to a route handler (via `Reflector`), and a `RolesGuard` reads that metadata off the current handler and checks it against the authenticated user's role before allowing the request through. Correctly identifies both the "where" (a Guard, not scattered through individual controller methods) and implicitly the "why" (adding a new protected route is then just one decorator, not a repeated inline check).

### Q8 — JWT structure and revocation
**Asked:** What's actually inside a JWT structurally, and can an already-issued token be stopped if a role changes right now?
**Answer:** "every jwt has header that carries algo expiry etc, paylaod that crries nfo about client whi did req like user id and role etch and it can be configured by us, signature a uniqe endoded dignature done by jwt itself , no we cannot revoke user role instantly if the token is already issued becuase it is stateless we dont delete or revode the access token but we can make its expiray less so that it can expry fast and use refersh token to generate new access token, now new access token will have user info eith updated role,"
**Score: SHAKY.** The revocation reasoning is genuinely strong and is the real point of the question: correctly identifies that a stateless JWT *can't* be individually invalidated once issued, and correctly describes the standard mitigation (short-lived access tokens + a refresh token used to mint a new one with up-to-date claims). One structural detail is wrong though: **`exp` (expiry) lives in the payload, not the header.** The header only carries metadata about the token itself — typically `alg` (the signing algorithm, e.g. `HS256`) and `typ` (`"JWT"`). The payload carries the actual claims: `sub`/`userId`, `role`, `iat` (issued-at), and `exp` (expiry) all live there together. Worth being precise about this since "what's in the header vs payload" is exactly the kind of thing that gets asked as a quick follow-up.

### Q9 — User enumeration via login error messages
**Asked:** What's the actual risk of distinguishing "user doesn't exist" from "wrong password," and what should happen instead?
**Answer:** "it make attack surface narrow ecause if we directly tell user dont exixst than attacker will stop trying that specific user and narrow the surface he has to attack, instead we can just sya invalid credentials,"
**Score: SOLID.** Right mechanism and right fix, despite the slightly backwards phrasing ("narrows the attack surface" — more precisely, revealing which usernames exist lets an attacker build a *confirmed-valid* target list, i.e. it helps *them* narrow their effort, which is bad for the defender). The fix — a single generic "invalid credentials" message regardless of which part was wrong — is exactly right and is what matters most here.

### Q10 — Rate limiting login attempts
**Asked:** What actually stops a brute-force attack against the login endpoint, and where would that protection naturally live in Anchor's stack specifically?
**Answer:** "we can apply rate limtng for it like a user can make req to this endpoint 5 times in 1 min"
**Score: SHAKY.** Rate limiting is the right general answer, but the question's second half — *where, specifically, in Anchor's existing stack* — wasn't addressed. Anchor already has **Redis** in the stack (currently just running via `docker-compose.yml`, not yet wired into the app), and Redis is exactly where a rate limiter's counters would live in practice: a fast, shared, TTL-friendly store that every API instance can read/write to enforce something like "at most 5 attempts per email+IP per minute," using an atomic increment-with-expiry (e.g. Redis's `INCR` + `EXPIRE`, or a sliding-window algorithm built on a sorted set). Doing this in application memory instead wouldn't work correctly the moment there's more than one running instance of the API — each instance would count independently, so a limit of "5 per minute" would actually become "5 per minute, per instance," silently multiplying the real limit.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for the rest of this phase's build:

1. **The correct NestJS request pipeline order** (Q4) — Middleware → Guards → Interceptors → Pipes → Handler. Getting this backwards will make debugging "why isn't my guard/decorator seeing what I expect" genuinely confusing once the auth guard and `@CurrentUser()` are both in play.
2. **What request scope actually means in NestJS's DI system, and why `TenantContextService` needs it** (Q6) — this is the single most important concept for this phase's central piece of new infrastructure. Without this being solid, the `TenantContextService` will look like magic rather than a specific, understood mechanism.
3. **The Guard-sets-`request.user`, decorator-just-reads-it-back pattern** (Q5) — needed to actually build `@CurrentUser()` and understand why it has no logic of its own.
4. **Salting, separately from slow-hashing** (Q2) — both matter, they solve different attacks (rainbow tables vs brute force), and bcrypt happens to bundle both.
5. **JWT header vs payload contents, precisely** (Q8) — small detail, easy to get right once flagged, easy to fumble under a follow-up question otherwise.
6. **Rate limiting's actual storage requirement in a multi-instance deployment** (Q10) — ties directly into Redis, which is sitting in the stack unused right now and is about to get its first real job.

---

## Architecture & decisions (as built)

### Repo layout — reorganized mid-phase

Everything above was originally built with each feature owning its own `guards/`/`decorators/` subfolder (`src/auth/guards/`, `src/tenancy/guards/`, etc.). Partway through the phase, the user asked to reorganize to match a pattern from another of their projects instead:

```
Backend/src/
├── common/              cross-cutting building blocks used by more than one module
│   ├── decorators/       current-user.decorator.ts, roles.decorator.ts
│   └── guards/           jwt-auth, login-throttle, workspace, roles — all four guards, regardless of which module "owns" the concept
├── database/             unchanged — entities, migrations, data-source.ts (stays a sibling, not under modules/)
├── modules/              every feature module
│   ├── auth/              controller, service, DTOs, JWT strategy
│   ├── tenancy/            tenant-context.service.ts + tenancy.module.ts only (its guards live in common/ now)
│   └── workspaces/         controller, service, DTOs
├── redis/                unchanged — sibling to modules/, not nested inside auth/
├── app.module.ts
└── main.ts
```

The real design point: **guards and decorators moved to `common/` regardless of which feature "owns" the underlying concept**, because they're consumed across module boundaries (`WorkspaceGuard` is used by `workspaces.controller.ts`, not by anything inside `tenancy/`). Keeping them inside the module that happened to define them first was already becoming awkward — `workspaces.controller.ts` was importing `../tenancy/guards/workspace.guard`, which only worked because of where the file physically happened to sit, not because of any real ownership relationship. `database/` and `redis/` stay as top-level siblings to `modules/`, not nested inside any single module, because both are genuinely shared infrastructure every module can depend on. This is purely a file-organization change — no behavior changed, and the full test suite (still 18/18) and a clean `tsc --noEmit` confirmed nothing broke in the move.

```
Client                    JwtAuthGuard           WorkspaceGuard           RolesGuard         Handler
  │  Authorization: JWT       │                        │                       │                │
  ├──────────────────────────►│ verify signature+exp   │                       │                │
  │                           │ attach request.user     │                       │                │
  │                           ├───────────────────────►│ :workspaceId param    │                │
  │                           │                         │ check Membership     │                │
  │                           │                         │ exists for user+ws   │                │
  │                           │                         │ populate request-    │                │
  │                           │                         │ scoped TenantContext │                │
  │                           │                         │ (workspaceId + role) │                │
  │                           │                         ├──────────────────────►│ @Roles('owner')│
  │                           │                         │                       │ check role     │
  │                           │                         │                       │ matches ────►  │ runs
```

- **JWT access (15 min) + refresh (7 days), rotated on every use.** Chosen over plain Redis-backed sessions specifically because most requests are verified by signature alone — no database or Redis round trip — at the cost of instant revocation being hard (see Q8/C-equivalent reasoning already covered). Matches the prototype's own Settings screen: *"Session lifetime: 7 days · refresh rotation on."*
- **Refresh tokens are themselves JWTs, but the raw token is never stored** — only a SHA-256 hash of it, in the new `refresh_tokens` table. This is a deliberate departure from bcrypt: bcrypt's slowness defends against brute-forcing a *low-entropy* secret (a human password); a refresh token is already ~256 bits of random data, so a fast, unsalted SHA-256 hash is the right tool here — the goal is only "a leaked database dump doesn't hand out working tokens," not "resist guessing," because a token this random can't be guessed either way. This is the same Q2 knowledge applied to a case where the *other* answer (plain hashing) is actually correct.
- **Rotation, not just expiry, on refresh:** every `/auth/refresh` call revokes the token it was given and issues a brand-new one. A stolen refresh token is only usable once before the legitimate user's own next refresh silently invalidates it — proven directly in the integration tests below.
- **`TenantContextService` is genuinely request-scoped** (`@Injectable({ scope: Scope.REQUEST })`), holding `workspaceId` and `role` as plain properties. `WorkspaceGuard` populates it; `RolesGuard` and any future service reads it. Because both guards *depend on* a request-scoped provider, Nest makes them request-scoped too, automatically — a concrete instance of the Q6 gap taught in the diagnostic.
- **Workspace scoping lives in the URL** (`/workspaces/:workspaceId/...`), not a header or a "current workspace" session concept. Explicit, visible in every request log, and trivial to test.
- **Role checks are declarative** (`@Roles(MembershipRole.OWNER)` + a `Reflector`-based `RolesGuard`), exactly matching what the diagnostic's Q7 answer already described correctly — adding a new protected route is one decorator, not a repeated inline check.
- **Login rate limiting is intentionally narrow**: a `LoginThrottleGuard` on `/auth/login` only, backed by Redis (`INCR` + `EXPIRE`, 5 attempts per email+IP per 60s). This is the first real job Redis has had in this project. Phase 15 will build the general per-tenant rate-limiting system this deliberately doesn't try to be.

---

## Data flow: a request to `PATCH /workspaces/1/members/2`

1. Client sends the request with `Authorization: Bearer <accessToken>`.
2. `JwtAuthGuard` (wrapping Passport's `AuthGuard('jwt')`) hands the token to `JwtStrategy`, which verifies its signature against `JWT_SECRET` and checks `exp`. If either fails, the request is rejected with 401 before anything else runs. On success, `JwtStrategy.validate()`'s return value becomes `request.user` (`{ userId }`).
3. `WorkspaceGuard` reads `:workspaceId` from the route and `request.user.userId`, and queries `memberships` for a matching row. No row → 403, immediately, before the handler or `RolesGuard` ever run. A row found → `TenantContextService.workspaceId` and `.role` are set for the rest of this request's lifetime.
4. `RolesGuard` reads the `@Roles(...)` metadata off the specific handler being called (via `Reflector`) and compares it to `TenantContextService.role`. No metadata → allowed through unconditionally (this is why `GET /members` has no role restriction, but `PATCH /members/:userId` does). Mismatch → 403.
5. Only now does `WorkspacesController.updateMemberRole()` actually run, calling `WorkspacesService`.

Register/login/refresh/logout is a separate, simpler flow that never touches `WorkspaceGuard`/`RolesGuard` at all — those endpoints aren't workspace-scoped, they establish *who you are* in the first place.

---

## Migrations: what each table and column actually stores

### `1789089375978-CreateRefreshTokens`

**`refresh_tokens`** — one row per issued (and not-yet-used) refresh token. A row disappears from being "usable" the moment it's rotated or logged out (`revoked_at` gets set), not by being deleted — the row stays for audit purposes.

| Column | Type | Stores |
|---|---|---|
| `id` | integer, PK, auto-increment | The row's own identifier. |
| `user_id` | integer, FK → `users.id` | Whose refresh token this is. Indexed, `ON DELETE CASCADE` — deleting a user deletes their refresh tokens too. |
| `token_hash` | varchar | SHA-256 hash of the raw refresh token — the raw token itself is never stored (see "Architecture" above for why SHA-256, not bcrypt, is correct here). |
| `expires_at` | timestamp | When this token stops being valid, regardless of `revoked_at`. |
| `revoked_at` | timestamp, nullable | `NULL` while the token is still usable; set the instant it's rotated (via `/auth/refresh`) or revoked (via `/auth/logout`). A non-null value here is what makes reuse of an old, already-rotated token fail. |
| `created_at` | timestamp | When this token was issued. |

---

## Code walkthrough

**`src/modules/auth/password.service.ts`** — a thin wrapper around `bcrypt`, `SALT_ROUNDS = 12`. Kept as its own tiny, injectable class specifically so `AuthService` never calls `bcrypt` directly — matches the Q8/DI-decoupling principle from Phase 1's "topics to master," and made swapping to `argon2` later (if ever) a one-file change.

**`src/modules/auth/auth.service.ts`** — the real logic, with no HTTP concerns in it at all (that's the controller's job):
- `register()` checks for an existing email first (real, friendly `409 Conflict` rather than a raw constraint-violation stack trace — though the `users.email` unique constraint is still there as the actual backstop if this check were ever bypassed, per Phase 1's "database constraints as invariant enforcement").
- `issueTokenPair()` is the one place both tokens get minted — a short-lived signed access token, and a longer-lived signed refresh token whose hash gets persisted.
- `refresh()` verifies the refresh JWT's signature and expiry *first*, then separately checks the database row for that token isn't already revoked or past its own `expires_at` — two independent checks, because a JWT can be structurally valid and signed correctly while still being a token this system has decided to no longer honor (post-rotation).
- `hashToken()` is plain `sha256`, deliberately not `bcrypt` (see Architecture above).
- `addDuration()` is a tiny parser for strings like `"15m"`/`"7d"` — exists only because `expiresAt` needs to be stored as a real `Date` in Postgres, while `@nestjs/jwt` itself is happy to accept the string directly.

**`src/modules/auth/strategies/jwt.strategy.ts`** — configures Passport's `passport-jwt` strategy: extract the token from the `Authorization: Bearer` header, don't ignore expiration, verify against `JWT_SECRET`. `validate()` runs only *after* signature and expiry already passed — its return value is what becomes `request.user`.

**`src/common/guards/jwt-auth.guard.ts`** — three lines. All the real work is Passport's; this class exists only so `@UseGuards(JwtAuthGuard)` has a concrete class to reference.

**`src/common/decorators/current-user.decorator.ts`** — reads `request.user` and nothing else. No token parsing here at all (see Q5's correction) — that already happened in the guard.

**`src/modules/tenancy/tenant-context.service.ts`** — deliberately just two mutable properties, no methods. `@Injectable({ scope: Scope.REQUEST })` is the entire mechanism; a new instance exists per request, so there's no cross-request data leakage possible even under concurrent load.

**`src/common/guards/workspace.guard.ts`** — the guard that actually closes Phase 1's C2 gap. Note it's a plain `@Injectable()`, not explicitly scoped — but because its constructor takes `TenantContextService` (request-scoped), Nest silently makes `WorkspaceGuard` request-scoped too. This is exactly the "scope propagates up the dependency chain" behavior worth knowing about DI scopes.

**`src/common/guards/roles.guard.ts`** — reads required roles via `Reflector.get(ROLES_KEY, context.getHandler())` — note `getHandler()`, not `getClass()`; metadata is read off the *specific method* being called, which is what makes per-route (not per-controller) role requirements possible.

**`src/common/guards/login-throttle.guard.ts`** — the only guard in this phase that has nothing to do with authentication or authorization; it's pure abuse-prevention, keyed on `email + IP` so it can't be trivially bypassed by just rotating one of the two.

**`src/redis/redis.module.ts`** — first real use of Redis in this project. Notably implements `OnModuleDestroy` to explicitly `.quit()` the connection — without this, every test file that boots the full `AppModule` leaves an open TCP connection behind, which is exactly what happened the first time this was written (see Failure cases).

---

## Failure cases (tested for real, not hypothetical)

1. **Refresh token reuse after rotation.** Register → refresh (rotates) → attempt to reuse the *original* refresh token again. Rejected with 401. Confirms rotation actually invalidates the old token rather than just issuing an additional valid one.
2. **Logout, then attempt to refresh with the revoked token.** Rejected with 401 — `revoked_at` being non-null is checked independently of `expires_at`.
3. **Cross-workspace access.** A real member of workspace 1 requesting workspace 999's member list gets a real 403 from `WorkspaceGuard` — this is Phase 1's C2 gap, closed and proven, not just designed.
4. **Non-owner attempting an owner-only action.** A `viewer` member gets 403 from `RolesGuard` on `PATCH /members/:userId`, but the *same user* successfully hits `GET /members` on the same controller seconds later — proving the role check is per-route metadata, not an accidental blanket restriction from the shared `@UseGuards` on the controller class.
5. **Forged JWT (wrong secret, otherwise well-formed).** A token with the exact right shape and claims, signed with a different secret, is rejected — proves `JwtStrategy` actually verifies the signature rather than trusting the decoded payload.
6. **Expired JWT, correct secret.** A token signed correctly but with `expiresIn: '-1s'` is rejected — proves expiry is actually enforced, not just present as a claim nobody checks.
7. **Login brute-force.** 5 rapid login attempts with a wrong password all correctly return 401 (real auth failures); the 6th returns 429 before `AuthService.login()` even runs — `LoginThrottleGuard` intercepts it first. Verified directly against Redis: `TTL login-attempts:<email>:<ip>` showed a real, decrementing expiry.
8. **Stale incremental TypeScript build cache silently serving an old route.** After adding the `PATCH /members/:userId` route, a full clean restart of the dev server *still* didn't expose it — `dist/` contained a compiled `workspaces.controller.js` from before the change, and `tsconfig.json`'s `"incremental": true` cache apparently didn't detect the file needed recompiling. Fixed by deleting `dist/` entirely and letting a full rebuild happen. **Lesson: if a change to a controller/route doesn't show up after a restart, before suspecting the code, check whether `dist/` is stale** — this cost real debugging time twice in this phase alone.
9. **Parallel test suites racing on the same database.** Running the full test suite (`jest`, no flags) failed non-deterministically: `schema.integration.spec.ts`'s `TRUNCATE` didn't include the newly-added `refresh_tokens` table (so it failed outright with an FK error the moment any other suite had inserted a row there), and separately, `auth.service.integration.spec.ts` hit a duplicate-key error because a *different* test file's data existed at the moment it ran — Jest runs test **files** in parallel worker processes by default, and every integration/e2e test in this project points at the same real database. This is the exact "known simplification, not yet fixed" flagged (and predicted) in Phase 1's doc, materializing on its own without needing to be forced. Fixed two ways: (a) updated the outdated `TRUNCATE` list, and (b) added `--runInBand` to the `test` script, forcing serial execution. **The deeper fix — a dedicated test database — is still not done**; `--runInBand` just makes the shared-database problem stop mattering by removing the concurrency, at the cost of a slower test run. Revisit before this becomes painful (a CI pipeline that wants parallelism, or simply enough tests that serial execution is too slow).

---

## Tests and why each exists

- **`password.service.spec.ts`** (unit) — hash/compare round-trip, wrong-password rejection, and explicit proof of salting (same password → different hash, twice). No database needed; this is pure logic.
- **`auth.service.integration.spec.ts`** (integration, real Postgres) — register creates exactly one owner membership; duplicate email is rejected; login accepts correct and rejects wrong credentials; refresh rotates and blocks reuse; logout revokes. Tests the *service* layer directly — no HTTP involved — because these behaviors don't depend on routing or guards at all.
- **`test/workspaces.e2e.spec.ts`** (e2e, real HTTP through `supertest`, real Postgres) — this is where guards genuinely need testing through real request objects: unauthenticated access, cross-workspace 403, garbage/forged/expired tokens, and the full owner-vs-viewer RBAC behavior. Nothing here could be meaningfully unit-tested in isolation — the entire point is proving the *chain* of guards behaves correctly together.
- **`test/login-throttle.e2e.spec.ts`** (e2e, real Redis) — 5 attempts through, 6th blocked, verified against the actual shared counter Redis holds.

---

## Reverse-engineering guide — if you open this in six months

1. Start at `src/modules/auth/auth.module.ts` — it's the hub: JWT config, Passport wiring, the login throttle guard, Redis. Everything else in this phase either feeds into it or is protected by something it exports.
2. `src/modules/tenancy/tenant-context.service.ts` plus `src/common/guards/{workspace,roles}.guard.ts` are the smaller, more conceptually important pieces — together they are Phase 1's C2 gap, closed. (Note the split: the request-scoped service lives with its module under `modules/`, but the guards that use it live in `common/guards/` alongside every other guard in the project — see "Repo layout" below for why.)
3. If a protected route is behaving strangely, check the **order** of `@UseGuards(...)` first — `WorkspaceGuard` depends on `JwtAuthGuard` having already run (needs `request.user`), and `RolesGuard` depends on `WorkspaceGuard` having already run (needs `TenantContextService` populated). Wrong order → confusing failures that look like a different bug entirely.
4. If a route change doesn't seem to take effect after a restart, delete `dist/` before doing anything else (see Failure case #8).
5. Run `npm test` inside `Backend/` — 5 suites, 18 tests as of this phase (16 plus the two added for forged/expired tokens). All hit the real native Postgres and real Redis; there's no mocking anywhere in this project yet.

---

## Closing quiz

10 questions, batched, scored honestly. **This came back weaker than the opening diagnostic** (4 SOLID/4 SHAKY/2 UNKNOWN → 0 SOLID/3 SHAKY/7 UNKNOWN here) — worth sitting with rather than glossing over, since several of these were things that got *built and demonstrated working* just hours earlier. Seeing something work and being able to explain the mechanism are genuinely different skills; this is real evidence of that gap, not a discouraging fluke.

### C1 — Guard order and why
**Asked:** What's the actual request pipeline order, and why do Guards need to run after Middleware but before the route handler?
**Answer:** "so guard run after middleware becuse in nestjs middleware is esxoress that start wokring on our req first and than it fun before route handler because teher is no point of routing req if the use is not authenticated."
**Score: SHAKY.** The order itself is right, and "no point running the handler if unauthenticated" is a real, correct reason for *before the handler*. What's missing: **why Guards specifically, and not Middleware, is where auth belongs.** Middleware runs first because it's inherited from the underlying Express layer and has no concept of *which controller method* is about to handle the request — no `ExecutionContext`, no access to `@Roles(...)` metadata via `Reflector`. Guards run immediately after specifically because they *do* get that context — they can see which handler is about to run and what decorators are on it. That's the actual reason auth/authorization logic lives in Guards rather than Middleware, and it's also why Interceptors and Pipes come *after* Guards in the full chain (Middleware → Guards → Interceptors → Pipes → Handler) — none of that was mentioned.

### C2 — Request scope propagation (repeat of opening Q6)
**Answer:** "dont knwo"
**Score: UNKNOWN — same gap as the opening diagnostic's Q6, unchanged despite `WorkspaceGuard` being built and working in front of you since.** Worth re-teaching directly rather than glancing past: NestJS providers are singletons by default — one instance, built once at boot, shared by every request forever. `TenantContextService` is declared `@Injectable({ scope: Scope.REQUEST })`, meaning Nest builds a **brand-new instance of it for every incoming request** and throws it away when that request ends. `WorkspaceGuard` never declared its own scope — but its constructor asks for a `TenantContextService`, and Nest's rule is: **if anything you depend on is request-scoped, you become request-scoped too**, transitively, all the way up the dependency chain. This is why `WorkspaceGuard` (and `RolesGuard`, for the same reason) get a fresh instance built per-request even though neither has `scope: Scope.REQUEST` written anywhere in their own file. Concretely: without this, two requests arriving at nearly the same moment for two different workspaces would fight over one shared `workspaceId` property, and one user could see another's data purely from a timing accident.

### C3 — What `@CurrentUser()` does, precisely
**Answer:** "so current user find the user who requested for resorce from abckedn"
**Score: UNKNOWN.** This restates the *purpose* (get the requesting user) but neither half of the question was answered: the *mechanism* (`createParamDecorator`'s factory function receives an `ExecutionContext`, calls `context.switchToHttp().getRequest()`, and returns `request.user` — nothing else, no decoding, no lookup), and *what breaks without a preceding `JwtAuthGuard`* (nothing populated `request.user`, so it would simply be `undefined` — `@CurrentUser()` would silently hand the controller `undefined` instead of throwing, which is arguably worse than an error: a route that forgets its guard doesn't crash, it just quietly gives every handler a broken `user` object, and the bug shows up downstream wherever `user.userId` gets accessed, several stack frames away from the actual mistake).

### C4 — Why rotation, not just short expiry
**Answer:** "becuase if we dnt rotate refersh token than if the attacker get the refresh token it will remina valid for 7days that is very bad"
**Score: SHAKY.** This argues for a *shorter expiry*, not for rotation specifically — the question was asking what rotation adds *on top of* whatever expiry you pick. The real answer: even with a short expiry, a stolen-but-not-yet-expired refresh token is fully usable by an attacker for its entire remaining lifetime, with **no way to detect the theft happened at all.** Rotation changes this: the moment *either* party (attacker or legitimate user) uses a refresh token, it's immediately revoked and replaced. If the attacker uses it first, the legitimate user's next refresh attempt fails — a concrete, detectable signal that something is wrong (in a more mature system, that failure would trigger revoking every token for that user, not just logging an error). Rotation's value isn't "shorter exposure window," it's **making theft observable** — an expiry-only approach never tells you a theft happened; it just eventually stops mattering.

### C5 — `getHandler()` vs `getClass()`
**Answer:** "dont know"
**Score: UNKNOWN.** `context.getHandler()` returns the specific controller *method* about to run (e.g., `updateMemberRole`); `context.getClass()` returns the controller *class* itself (`WorkspacesController`). `RolesGuard` reads `@Roles(...)` metadata off `getHandler()` specifically because that decorator was placed on one method, not the class — using `getClass()` instead would look for `@Roles(...)` metadata attached to the whole controller (which doesn't exist here), so `reflector.get(...)` would return `undefined` for every route, and `RolesGuard`'s "no required roles → allow" branch would fire unconditionally — silently disabling all role checks in the entire controller, including the owner-only `PATCH`. This is precisely how per-route (not per-controller) authorization becomes possible at all.

### C6 — JWT payload/signature trust (partial repeat of the original Q8)
**Answer:** "it lives in payload becuase when we sign the token using jwt secret we basically include expiry in it"
**Score: SHAKY.** Good — `exp` living in the payload was correctly retained from the original diagnostic's correction. The second half wasn't addressed: `exp` is plain, unencrypted JSON — anyone can base64-decode a JWT's payload and read (or edit) `exp` without ever touching the secret. What actually requires the secret is the **signature**, which covers the header and payload *together* as one unit. Verifying `exp` is only meaningful *because* the signature check first confirms the payload wasn't tampered with — without that, an attacker could simply rewrite `exp` to some far-future date and the token would look "not expired" with zero cryptographic effort. `exp` isn't independently secured; it's trustworthy only as a side effect of the signature covering the whole payload.

### C7 — SHA-256 vs bcrypt for refresh tokens (regression from the design walkthrough)
**Answer:** "so we are rotating refresh token on every new access token so it doesnot req that much security as like password"
**Score: UNKNOWN.** This connects the wrong two ideas — rotation frequency has nothing to do with which hash function is appropriate. The actual reasoning (already in this doc's Architecture section, worth re-reading): bcrypt's deliberate slowness defends against brute-forcing a **low-entropy** secret — a human password, drawn from a small effective space of likely strings. A refresh token is a **high-entropy**, machine-generated random value (effectively unguessable regardless of hash speed) — bcrypt's slowness buys nothing here, because there's no realistic "guess and check" attack to slow down. The only thing hashing a refresh token defends against is a leaked database dump directly handing out valid tokens; a fast SHA-256 hash is entirely sufficient for that, and using bcrypt would just waste CPU on every single refresh with no security benefit. This is the same knowledge as the original Q2 (bcrypt vs SHA-256), applied to a case where the *other* tool is actually correct — and it didn't transfer.

### C8 — Why parallel test suites broke, and what `--runInBand` fixed
**Answer:** "dont know"
**Score: UNKNOWN.** Jest, with no flags, runs separate test **files** as separate worker processes *concurrently* by default — a performance optimization that assumes test files don't interfere with each other. Every integration/e2e test in this project connects to the exact same real, shared native Postgres database (and Redis). When two files' tests ran at the same moment, one file's `TRUNCATE` could wipe rows a *different* file's test had just inserted a moment before asserting against them, or two files' `INSERT`s could collide on a unique constraint neither expected the other to be touching. `--runInBand` tells Jest to run every test file **sequentially, in a single process**, one after another — nothing runs concurrently, so there's no longer a database to race over. It fixes the symptom (test flakiness) by removing the concurrency, not by giving each test its own isolated data — the real fix (a dedicated test database) is still an open item.

### C9 — Stale incremental build cache
**Answer:** "dont know"
**Score: UNKNOWN.** TypeScript's `"incremental": true` build mode keeps a cache (`tsconfig.tsbuildinfo`, sitting in `dist/`) recording which files it already compiled and (roughly) whether they've changed since. It decides "does this file need recompiling" by comparing against that cache rather than reading and re-diffing every file from scratch every time — that's the entire point of incremental builds, to make repeated `nest start` runs fast. In this project's dev environment, that cache became stale relative to the actual file on disk (very likely connected to the same file-timestamp flakiness logged elsewhere in this project's environment notes), so `tsc` trusted the cache's claim that nothing had changed and skipped recompiling a file that very much had changed. The practical lesson: incremental compilation trusts its cache over the actual file content by design — when that assumption breaks, the fix is deleting the cache (`dist/`) to force a full rebuild, not looking for a bug in the code that changed.

### C10 — Redis rate-limiter mechanics
**Answer:** "so on each req we will incr the count in redis"
**Score: UNKNOWN.** "Incr the count" is the first half of the mechanism but the question specifically asked *why the count resets after 60 seconds*, which wasn't addressed at all. The actual sequence, from `LoginThrottleGuard`: on each login attempt, `INCR login-attempts:<email>:<ip>` — Redis creates the key at value `1` if it didn't exist, or atomically increments it if it did. **Only on the very first increment** (when the returned value is exactly `1`, meaning this key didn't exist a moment ago) does the guard also call `EXPIRE ... 60` — attaching a 60-second time-to-live to that key. Every attempt within that 60-second window keeps incrementing the *same* key without resetting its TTL; once 60 seconds pass with no new attempts extending it, Redis deletes the key on its own, and the next attempt after that starts a fresh count at `1` with a fresh 60-second window. The "reset" isn't an action anyone takes — it's Redis's own key-expiration mechanism doing the cleanup automatically.

---

## Topics to master — not just for Anchor, for being a genuinely strong engineer

Combining both quizzes for this phase. Several topics recurred across the opening diagnostic *and* the closing quiz without landing either time — those are ranked highest, since a gap that survives seeing the working code is the strongest signal of all.

### 1. Request-scoped dependency injection and scope propagation
**Search:** "NestJS request scoped providers", "dependency injection scope propagation", "request scope vs singleton scope"
**Exposed by:** opening Q6 (UNKNOWN) and closing C2 (UNKNOWN) — the single most-repeated gap in this phase, unresolved even after `WorkspaceGuard` and `TenantContextService` were built, run, and watched working correctly. The core fact: a provider that depends on a request-scoped provider becomes request-scoped itself, transitively — this is true in NestJS specifically but the underlying idea (a container's lifecycle rules apply transitively through a dependency graph) shows up in every serious DI framework (Spring, .NET's built-in DI, Angular). Not understanding this cold makes concurrent-request bugs (data from one request leaking into another) look like mysterious flakiness instead of an obvious, explainable consequence of scope.

### 2. `ExecutionContext`: how a framework inspects "what's about to run"
**Search:** "NestJS ExecutionContext", "reflection metadata decorators", "getHandler vs getClass Reflector"
**Exposed by:** closing C1 (SHAKY — missing why Guards specifically get this and Middleware doesn't), C3 (UNKNOWN — `@CurrentUser()`'s actual mechanism), and C5 (UNKNOWN — `getHandler()` vs `getClass()`). All three are really the same underlying gap wearing different clothes: NestJS's Guards, decorators, and interceptors all work by inspecting an `ExecutionContext` — an object that exposes *which specific method, on which specific class,* is about to handle this request, plus whatever metadata (`@Roles(...)`, etc.) was attached to it via `Reflector`. Once this clicks, "why does a Guard run where it does" and "how does a custom decorator get its data" and "why `getHandler()` not `getClass()`" stop being three separate facts to memorize and become one mechanism applied three times.

### 3. Matching hash function to secret entropy (bcrypt vs SHA-256)
**Search:** "bcrypt vs sha256 password hashing", "hashing high entropy secrets", "why not use bcrypt for API tokens"
**Exposed by:** opening Q2 (SHAKY) and closing C7 (UNKNOWN — a real regression, substituting an unrelated justification). The rule: slow, salted hashing (bcrypt/argon2/scrypt) earns its cost defending **low-entropy, human-guessable** secrets (passwords) against brute force and rainbow tables. A high-entropy, machine-generated random value (a refresh token, an API key) doesn't benefit from that slowness — it's already unguessable — so a fast hash (SHA-256) is not a shortcut, it's the *correct* engineering choice, and reflexively reaching for bcrypt "because it's more secure" everywhere is itself a mistake (wasted CPU, no actual security gain). This distinction — matching the defense to the actual threat model rather than picking the "strongest-sounding" tool by default — generalizes to security decisions well beyond hashing.

### 4. Token rotation as theft *detection*, not just exposure reduction
**Search:** "refresh token rotation security", "OAuth refresh token theft detection", "token reuse detection"
**Exposed by:** closing C4 (SHAKY — argued for shorter expiry instead of explaining rotation's actual value). Rotation's real contribution is making token theft **observable**: reuse of an already-rotated token is a concrete signal, not a vague increase in safety margin. This generalizes to a broader security-design idea worth having cold: a good mitigation doesn't just make an attack *harder*, it ideally also makes a *successful* attack detectable after the fact.

### 5. Incremental build caches: what they trust, and when to distrust them
**Search:** "typescript incremental compilation tsbuildinfo", "stale build cache debugging", "why isn't my code change showing up"
**Exposed by:** closing C9 (UNKNOWN), and this bit real debugging time twice during this phase's build. The general skill: any tool that claims to skip redundant work (incremental compilers, most caches, memoized build systems) is trusting *some* signal (usually a timestamp or hash) instead of re-deriving truth from scratch — and when that signal is wrong, the tool confidently produces a stale result with no error. "Delete the cache and rebuild clean" belongs in the very first list of things to try whenever a change doesn't seem to take effect, before assuming the code itself is wrong.

### 6. Shared external state across test suites (isolation and concurrency)
**Search:** "jest parallel test execution database", "test isolation shared database", "flaky tests concurrency"
**Exposed by:** closing C8 (UNKNOWN), and this one broke unforced, on its own, exactly as Phase 1's doc predicted it eventually would. Test runners parallelize by default because most unit tests don't share mutable state; the moment tests hit a real shared resource (a database, a cache, a filesystem path), that assumption silently breaks, and the failures look random rather than structural. `--runInBand` is a valid stopgap; understanding *why* it was necessary — not just that it made the red turn green — is what prevents the same class of flakiness reappearing somewhere else later (a CI pipeline, a different shared resource) without being recognized for what it is.

### 7. Fixed-window rate limiting with `INCR` + `EXPIRE`
**Search:** "redis rate limiting incr expire", "fixed window vs sliding window rate limit", "redis atomic counter TTL"
**Exposed by:** opening Q10 (SHAKY) and closing C10 (UNKNOWN — the specific TTL-reset mechanism still wasn't explained even after watching it work via `redis-cli TTL`). The pattern (`INCR` a key, `EXPIRE` it only on the first increment, key vanishes on its own once nobody's incremented it for the window duration) is one of the most common rate-limiting implementations in real systems specifically because it needs no scheduled cleanup job — Redis's own expiration does the resetting. Worth knowing this is called a **fixed window** counter, and that it has a known edge case (a burst right at the window boundary can allow roughly double the intended limit) — not a flaw introduced here, just a property of the pattern worth knowing exists before reaching for it again.

## Interview questions this phase generates

- "Explain what happens if a request-scoped provider is injected into a singleton-scoped provider. Is that even allowed?" (Directly tests topic #1 — the answer is Nest throws at startup; the dependency graph's scope has to be consistent, which is exactly why scope propagates *upward* through dependents rather than being ignored.)
- "Walk me through exactly how a NestJS Guard gets access to the metadata set by a custom decorator like `@Roles(...)`." (Topic #2 — tests `Reflector` + `SetMetadata` + `getHandler()` together as one mechanism.)
- "When would you deliberately choose a fast, unsalted hash over bcrypt? Give a concrete example." (Topic #3 — a great one to have a crisp, confident answer for now given it was a real gap.)
- "A refresh token was just leaked in a log file. Walk through what an attacker can do with it, and what in this system limits the damage." (Topic #4 — tests rotation's actual mechanism under a realistic scenario, not just its definition.)
- "Your test suite passes locally but fails intermittently in CI. What's your process for figuring out why?" (Topic #6 — this phase now has a real, personally-lived example to reach for instead of a generic answer.)

## What I still don't understand

Genuinely open after this quiz, carried forward rather than glossed over:

- **Request-scoped DI (topic #1) and `ExecutionContext` (topic #2)** — taught twice now (original diagnostic + this closing quiz) without landing. These are foundational to essentially every guard/interceptor Phase 3 onward will need, so they need one more deliberate pass — possibly by *building* something with request scope from scratch next time, rather than reading the explanation a third time.
- **The bcrypt-vs-SHA-256 entropy distinction (topic #3)** — actually regressed between quizzes (the opening diagnostic's SHAKY became a wrong, unrelated answer in the closing quiz). Worth flagging specifically to re-test before it comes up again in a context with real stakes (e.g., API key hashing in a later phase).
- **Redis's `INCR`/`EXPIRE` pattern (topic #7)** — was directly observed working via `redis-cli TTL` during this phase's build, and still didn't transfer into an explanation. Worth deliberately re-examining the actual Redis commands next time this pattern is touched (Phase 14's semantic cache, Phase 15's rate limiting) rather than assuming it's understood because it was seen once.

