# Team management, RBAC and invitations

**What this covers:** the work in commit `10a6ede` (merged as `8ddcf06`) that turned "a workspace is
whoever registered it" into a real team: a database-driven permission system, a full member
lifecycle (role change, remove, leave, transfer ownership), and an email-based invitation flow with
its own accept page.

This is not a numbered phase from `docs/PHASES.md` — it is feature work sitting on top of Phase 2
(auth + tenant scoping) and Phase 12 (agent console). Backend first, then the Frontend on top.

> **Honesty note on verification:** every claim below was read out of the code in this repo, and the
> role→permission table was read out of the live database. I did **not** re-run the Jest suite while
> writing this, so where I describe a test, I am describing what the test file asserts, not a run I
> watched go green.

---

## 1. Why this work exists

Before it, Anchor had exactly one way for a person to exist in a workspace: `POST /auth/register`
created a user, a workspace and an `owner` membership, all at once. There was no way to add a second
person. Authorization was `@Roles(OWNER, AGENT)` — a hardcoded list of role names on each route.

That has three concrete problems:

1. **No way in.** A real customer-support product is used by a team, not one person.
2. **Role lists don't scale.** `@Roles(OWNER, AGENT)` reads as "whoever can do this", which is a
   permission wearing a role's clothes. Adding a role means editing every controller; changing what
   an agent may do means finding every decorator that mentions `AGENT`.
3. **No way out.** Nothing removed a member, and nothing cleaned up after a removal — an agent who
   left still held claimed conversations, and their open WebSocket kept working.

So three separate subsystems came out of it, and it is worth keeping them separate in your head:

| Subsystem | Answers | Lives in |
|---|---|---|
| **Permissions (RBAC)** | "May this role do this?" | `permissions` + `role_permissions` tables, `PermissionsGuard` |
| **Membership lifecycle** | "Who is in this workspace, and what happens when that changes?" | `WorkspacesService` |
| **Invitations** | "How does someone who is not a member become one?" | `InvitationsService` + `InvitationAcceptanceService` |

---

## 2. The mental model in one page

```
                          ┌──────────────────────────────────────────┐
                          │  BOOT                                    │
                          │  PermissionsService.onModuleInit()       │
                          │  SELECT * FROM role_permissions          │
                          │  → in-memory Map<role, Set<permission>>  │
                          │  (refuses to boot if code/db disagree)   │
                          └──────────────────────────────────────────┘
                                             │
   REQUEST:  PATCH /workspaces/7/members/12  │ reads from that Map
             Authorization: Bearer <jwt>     ▼
   ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐   ┌────────────┐
   │ JwtAuthGuard   │ → │ WorkspaceGuard │ → │ PermissionsGuard │ → │ Controller │
   │ who are you?   │   │ are you a      │   │ does your role   │   │            │
   │ (401 if not)   │   │ member of 7?   │   │ hold the ONE     │   │            │
   │                │   │ (403 if not)   │   │ permission this  │   │            │
   │                │   │ puts your role │   │ route declares?  │   │            │
   │                │   │ in TenantCtx   │   │ (403 if not)     │   │            │
   └────────────────┘   └────────────────┘   └──────────────────┘   └────────────┘
```

Three sentences that carry most of it:

- **A role is no longer checked against a list in code; it is looked up in a table.** Changing what
  an agent can do is a row in `role_permissions`, not a code change.
- **A route with no `@RequirePermission` is denied for everyone.** The old guard *allowed* such a
  route for every member. This one fails closed and logs an error naming the handler.
- **On the accept side, the invitation token *is* the authorization.** There is no membership to
  check — becoming a member is the point — so everything about the token (256 bits of entropy,
  stored only as a SHA-256 hash, single use, 7-day expiry, bound to one email address) is what
  stands in for a guard.

---

## 3. Migrations: what each table and column actually stores

Four migrations, in this order.

### 3.1 `1790664022185-NormalizeUserEmails`

No new table. Three things to `users`:

1. **Refuses to run** if two existing accounts collapse to the same lowercase address — merging them
   means deciding whose password, memberships and history survive, which is a human's call, not a
   migration's.
2. `UPDATE users SET email = lower(trim(email))` — every stored address becomes canonical.
3. Adds `CHK_users_email_normalized CHECK (email = lower(trim(email)))`.

**Why this had to happen before invitations:** an invitation grants access to an *email address*.
Acceptance compares `users.email` to `invitations.email`. If `Anas@x.com` and `anas@x.com` can both
exist, that comparison is meaningless.

A side effect worth knowing: because every stored email is now lowercase, the pre-existing plain
`UNIQUE` on `users.email` is *in effect* case-insensitive — no functional index needed.

The application normalizes on the way in too (`normalizeEmail()` via `@Transform` in `RegisterDto`,
`LoginDto`, `CreateInvitationDto`). The `CHECK` is defence in depth: it catches a bulk import, a
`psql` session, or a future service that forgets.

`normalizeEmail()` is deliberately **trim + lowercase only** — no Gmail-style dot-stripping or
`+tag` removal. Those rules are true for `gmail.com` and false for most other domains; applying them
everywhere would merge addresses belonging to different people.

### 3.2 `1790740000000-CreatePermissions`

**Table `permissions`** — the catalogue of permissions that exist at all.

| Column | Type | Stores |
|---|---|---|
| `key` | `varchar(64)` PRIMARY KEY | The permission string itself, e.g. `documents.manage`. Keyed by the string rather than an integer id so `role_permissions` rows read meaningfully in `psql` and code can reference a key with no lookup. |
| `description` | `text` | Human wording, shown in the invite dialog's role picker — e.g. "Upload and delete knowledge-base documents". |

**Table `role_permissions`** — the entire RBAC policy, one row per grant.

| Column | Type | Stores |
|---|---|---|
| `role` | `memberships_role_enum` | Which role holds the grant. **Roles are deliberately not a table** — reusing the existing membership enum means a row here can only name a role a membership can actually hold. |
| `permission_key` | `varchar(64)`, FK → `permissions.key` `ON DELETE CASCADE` | Which permission. Cascade means removing a permission from the catalogue takes its grants with it. |
| PRIMARY KEY | `(role, permission_key)` | A role holds a permission at most once, and the PK index (role first) is exactly the scan "load every permission for this role" needs. |

Seeds 10 permissions and their grants. Values are written out literally rather than imported from
the `Permission` enum — **a migration must replay identically forever**, and an import would make
this file's meaning change every time the enum does.

### 3.3 `1790750000000-CreateInvitations`

**Table `invitations`** — one row per invitation ever sent.

| Column | Type | Stores |
|---|---|---|
| `id` | `SERIAL` PK | Internal id. Never seen by the invitee — only by members managing invitations. |
| `workspace_id` | `integer` FK → `workspaces`, `CASCADE` | Which workspace. Deleting the workspace deletes its invitations. |
| `email` | `varchar(320)` + `CHECK (email = lower(trim(email)))` | The invited address, normalized, so it can be compared to `users.email`. |
| `role` | `memberships_role_enum` | The role they get on acceptance. |
| `token_hash` | `varchar(64)` UNIQUE | **SHA-256 hex of the emailed token. The token itself is stored nowhere.** Also the lookup key on every preview/accept. |
| `status` | `invitations_status_enum` (`pending`/`accepted`/`revoked`), default `pending` | The *stored* lifecycle. |
| `invited_by_user_id` | `integer` FK → `users`, `SET NULL` | Who sent it. `SET NULL` because the invitation is a fact about the workspace, not about the inviter — same reasoning as `documents.uploaded_by_user_id` in Phase 3. |
| `expires_at` | `timestamptz` | `now() + '7 days'` at creation, **reset on every resend**. |
| `send_count` | `integer`, default 1 | How many times it has been sent, so the UI can say "send #3". |
| `last_sent_at` | `timestamptz` | When the most recent send happened. |
| `accepted_at` / `accepted_by_user_id` | `timestamptz` / FK `SET NULL` | When, and by which account. |
| `revoked_at` | `timestamptz` | When it was revoked. |
| `created_at` | `timestamptz` | Row creation; the list is ordered by it. |

**`expired` is not a stored status.** It is derived at read time:

```sql
CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status::text END
```

Storing it would need a scheduled job flipping rows at the right moment, and until that job ran, a
stored `pending` would be a lie. Deriving it is always right. The cost: to *filter* on it, the query
must compute the `CASE` in a subquery before the `WHERE` can see it — which is exactly what
`InvitationsService.list()` does.

**Constraints, and what each is actually for:**

- `CHK_invitations_status_fields` — timestamps must agree with the status: `accepted` requires
  `accepted_at` and forbids `revoked_at`, and so on. No code path can leave an `accepted` invitation
  with nobody recorded as accepting it.
- `UQ_invitations_pending_email` — a **partial** unique index:
  `UNIQUE (workspace_id, email) WHERE status = 'pending'`. A plain `UNIQUE(workspace_id, email)`
  would be wrong: it would forbid ever re-inviting someone whose earlier invitation was accepted
  (and who later left) or revoked. The `WHERE` limits uniqueness to rows where a duplicate actually
  means something. **This index, not the pre-check in the service, is what guarantees one pending
  invitation per address** — the same two-layer lesson as Phase 3's duplicate upload.
- `IDX_invitations_workspace_created` — serves the list endpoint's "one workspace, newest first".

Every timestamp here is `timestamptz`, unlike the older tables — an absolute instant, so it cannot
repeat Phase 13's five-hour bug (JS local time written into a naive `timestamp` column).

### 3.4 `1790760000000-AddMembershipLifecyclePermissions`

Inserts `workspace.leave` and `workspace.transfer_ownership`, granting **leave to all three roles**
and **transfer_ownership to `owner` only**.

Granting "leave" to everyone explicitly, rather than exempting the route from the permission check,
keeps deny-by-default uniform, and turns a future policy like "members of managed workspaces can't
leave on their own" into a row deletion instead of a code change.

This migration is also the template for every future permission: **add the key to the `Permission`
enum AND insert it here.** Deploying the enum change without the migration makes the app refuse to
boot (§4.2) rather than silently 403 the new route for everyone.

### 3.5 `1790770000000-AddEmailDeliveryToInvitations`

Three columns on `invitations`, written by the email worker:

| Column | Stores |
|---|---|
| `email_status` `varchar(16)` + CHECK in (`queued`,`sent`,`failed`) | Where the *email* is, as distinct from where the *invitation* is. |
| `email_sent_at` `timestamptz` | When the mail server accepted it. |
| `email_last_error` `text` | The last error — including intermediate retry errors, so the UI can say "retrying (attempt 2 of 5)" rather than looking stuck. |

**What "sent" honestly means:** the recipient's mail server returned SMTP 250 — *accepted the
message*. That is the most a plain SMTP sender ever learns. Not "in the inbox", not "read"; spam
placement, later bounces and opens are invisible over SMTP. Hence the UI wording "sent to mail
server". Transactional providers (SES, Postmark, Resend) report those via webhooks — the natural
next step.

### 3.6 The live policy, as the database holds it right now

```
 owner  | 12 | documents.manage, documents.view, handoff.view, handoff.work, knowledge.query,
        |    | members.invite, members.manage, members.view, widget.manage, widget.view,
        |    | workspace.leave, workspace.transfer_ownership
 agent  |  7 | documents.manage, documents.view, handoff.view, handoff.work, knowledge.query,
        |    | members.view, workspace.leave
 viewer |  4 | documents.view, knowledge.query, members.view, workspace.leave
```

Note what a **viewer** is: read-only on documents and the team, plus the ability to ask questions in
the playground. They cannot work conversations, upload, invite, or see widget settings.

---

## 4. The permission system

### 4.1 The four pieces

| File | Role |
|---|---|
| `src/common/permissions/permission.enum.ts` | The 12 keys, as a TypeScript enum. The only place code names a permission. |
| `src/common/decorators/require-permission.decorator.ts` | `@RequirePermission(Permission.X)` — sets route metadata. |
| `src/modules/tenancy/permissions.service.ts` | Loads `role_permissions` into memory at boot; answers `has(role, permission)`. |
| `src/common/guards/permissions.guard.ts` | Reads the metadata, asks the service, throws 403. |

**One permission per route, deliberately.** "Requires A or B" is how role lists crept in before
(`@Roles(OWNER, AGENT)` was really "whoever can do this"). If a route genuinely needs two different
capabilities, that is usually a sign it is doing two things.

### 4.2 `PermissionsService` — why it caches, and why it refuses to boot

```ts
async onModuleInit() { await this.reload(); }   // one query at boot, then a Set lookup per request
```

The check runs on **every** workspace request, and the policy changes rarely — a migration or an
admin edit, not user traffic. Loading once at boot turns a per-request query into a `Set.has()`.

The cost is staleness, and it is stated plainly in the code: an edit to `role_permissions` takes
effect when `reload()` runs — on the next boot, or when whatever made the edit calls it. **With
several API instances, each holds its own copy**, so a runtime edit would need a broadcast (Redis
pub/sub) to reach them all. No runtime edit path exists yet, so boot-time loading is the whole story
for now.

The important part is `assertNoDrift()`:

- **Permission in code but missing from the database → throw, refuse to boot.** Without this check
  nothing would error. `has()` would simply return `false` for every role, and the feature it guards
  would 403 for everyone, owners included. That is the silent-degradation shape this project keeps
  meeting (Phase 13's tsquery colon, Phase 13's `GREATEST` clamp): *the failure is not an exception,
  it is a wrong answer.* Refusing to boot turns it back into a loud failure, at deploy time, instead
  of a support ticket next week.
- **Permission in the database but not in code → warn only.** An orphan row grants nothing, since no
  code checks it — typically the leftover of a permission removed from code before its cleanup
  migration ran.

### 4.3 `PermissionsGuard` — deny by default, and the Phase 12 bug it fixes

```ts
const required = this.reflector.getAllAndOverride<Permission | undefined>(
  PERMISSION_KEY, [context.getHandler(), context.getClass()],
);
if (!required) { this.logger.error(`${cls}.${handler} has no @RequirePermission — denied by default.`); throw new ForbiddenException(...); }
if (!this.permissions.has(this.tenantContext.role, required)) throw new ForbiddenException(...);
```

Two changes from the old `RolesGuard`, both of which are real bugs it had:

1. **`getAllAndOverride([handler, class])` instead of only `getHandler()`.** Phase 12's
   `HandoffController` put `@Roles(OWNER, AGENT)` at the class level, and it was **silently never
   enforced** because the old guard only read handler metadata. Now class-level works, with the
   method's own declaration winning where both exist.
2. **A route with no decorator is denied, not allowed.** Under the old guard, forgetting `@Roles` on
   a new route made it open to every member and nothing would ever notice. Now forgetting it makes
   the route fail closed for everyone — which the first test, or the first click, notices
   immediately. A route meant to be open to every member says so explicitly with a permission every
   role holds (that is what `workspace.leave` granted to all three roles is for).

It runs **after** `WorkspaceGuard`, which has already proved membership and put the caller's role
into the request-scoped `TenantContextService`. The guard itself does no database work.

### 4.4 The route → permission map

| Route | Permission |
|---|---|
| `GET /workspaces/:id/members` | `members.view` |
| `GET /workspaces/:id/roles` | `members.view` |
| `PATCH /workspaces/:id/members/:userId` | `members.manage` |
| `DELETE /workspaces/:id/members/:userId` | `members.manage` |
| `POST /workspaces/:id/leave` | `workspace.leave` |
| `POST /workspaces/:id/transfer-ownership` | `workspace.transfer_ownership` |
| `POST/GET/DELETE /workspaces/:id/invitations…` | `members.invite` (class-level) |
| `GET/PATCH /workspaces/:id/widget-settings` | `widget.view` / `widget.manage` |
| `POST /workspaces/:id/documents`, `DELETE …/:documentId` | `documents.manage` |
| `GET …/documents`, `…/:documentId`, `…/progress` | `documents.view` |
| `POST /workspaces/:id/ask`, `…/retrieve` | `knowledge.query` |
| `GET /workspaces/:id/handoff/*` (queue, stats, presence, turns…) | `handoff.view` |
| `PATCH …/handoff/:sessionId/claim`, `…/resolve` | `handoff.work` |
| `POST /invitations/preview`, `/accept`, `/accept-signup` | **none** — token-authorized, see §6 |

### 4.5 The same permission on the WebSocket

`WidgetChatGateway.handleAgentConnection()` verifies the JWT by hand (a WebSocket handshake cannot
run through Nest's HTTP guard pipeline), loads the membership, and then asks the *same* service:

```ts
if (!membership || !this.permissions.has(membership.role, Permission.HANDOFF_WORK)) {
  client.disconnect(true); return;
}
```

Not a hardcoded "not a viewer" check — so granting or revoking `handoff.work` changes the REST
routes and the socket at once.

On success the socket joins **two** rooms: `agents:{workspaceId}` (everyone's console, for queue
notifications) and `agent:{workspaceId}:{userId}` (this one person's sockets, across all their open
tabs). The second one exists so that "cut this person off right now" is a single room operation —
see §5.3.

---

## 5. Member lifecycle

All of this is `WorkspacesService`. Four operations, and they share two helpers.

### 5.1 The shared helpers

```ts
export async function lockWorkspace(manager, workspaceId) {
  const rows = await manager.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  if (rows.length === 0) throw new NotFoundException('Workspace not found.');
}

export async function assertAnotherOwnerRemains(manager, workspaceId) {
  const owners = await manager.count(Membership, { where: { workspaceId, role: OWNER } });
  if (owners <= 1) throw new ConflictException('A workspace must always have at least one owner…');
}
```

**Why a lock here, when Phase 12's claim needed only a conditional `UPDATE`?** This is the single
most transferable idea in this whole body of work, so it is worth slowing down on.

Phase 12's claim condition (`status = 'escalated'`) lives on **the very row being updated**, so one
`UPDATE … WHERE` is atomic — Postgres takes a row lock as part of the write, and a second concurrent
update re-evaluates the `WHERE` after the first commits and matches nothing.

"Is there another owner?" is a condition **across other rows**. Two owners demoting each other at
the same instant would each count 2 owners, each pass the check, and leave the workspace with zero
owners. That is **write skew**, and no single-row conditional update prevents it. Locking the
workspace row with `FOR UPDATE` serialises every ownership-affecting change in that workspace: the
second transaction waits for the first to commit, so its count is correct.

The rule of thumb to carry: *a conditional UPDATE protects an invariant about one row; an invariant
about a set of rows needs a lock on something all of them agree to take.*

`releaseClaimedSessions()` is the third helper — it hands someone's claimed conversations back:

```sql
UPDATE conversation_sessions
SET status = 'escalated', claimed_by_user_id = NULL, claimed_at = NULL
WHERE workspace_id = $1 AND claimed_by_user_id = $2 AND status = 'claimed'
RETURNING session_id
```

Back to `escalated` rather than `open`: these customers asked for a human and are still waiting.
`escalated_at` is deliberately left alone, so the queue shows how long they have **really** been
waiting (and priority keeps rising) instead of restarting their clock. Resolved sessions keep their
`claimed_by_user_id` — that is history ("who handled this"), not access.

### 5.2 The four operations

**`updateMemberRole(workspaceId, targetUserId, role)`**
Lock workspace → find the membership (404 if not a member) → if demoting the last owner,
`assertAnotherOwnerRemains` → save → **if the new role does not hold `handoff.work`, release their
claimed sessions**. A demotion agent→viewer takes away the ability to answer, so their claimed
conversations would otherwise belong to nobody who can work them.

**`removeMember(workspaceId, actorUserId, targetUserId)`**
Refuses `actor === target` with a 400 pointing at `leave()` — same effect, different decision, and
leaving must not require `members.manage`. Otherwise delegates to `endMembership(…, 'removed')`.

**`leave(workspaceId, userId)`** → `endMembership(…, 'left')`.

**`endMembership`** is the shared body: lock workspace → find membership → last-owner check →
`DELETE` the membership → release claimed sessions → after commit, broadcast.

**`transferOwnership(workspaceId, actorUserId, targetUserId)`**
Promotes the target to owner and steps the current owner down to agent **in one transaction**.

Why this exists when an owner can already promote someone: done as two separate role changes there
is a window between them, and a failure in between leaves either two owners (harmless but not what
was asked) or — in the other order — a second step refused by the last-owner check, stranding you.
One transaction has no in-between for anyone to observe or get stuck in.

It also re-reads the actor's own membership *inside* the lock and refuses with 409 if they are no
longer an owner. `PermissionsGuard` proved that when the request arrived; the lock is what makes it
still true at write time.

### 5.3 What happens to an open socket when access is cut

This is the part that is easy to forget, and it is in `RealtimeBroadcaster`:

```ts
revokeRoom(room, event, payload) {
  this.server.to(room).emit(event, payload);   // tell them why, first
  this.server.in(room).disconnectSockets(false); // then end every socket in the room
}
```

**Why it is needed:** a WebSocket's authorization happens **once, at connect**. REST is re-checked on
every request (`WorkspaceGuard` reads `memberships` every time), so removing a member ends their
REST access instantly — but an already-open socket would keep receiving the workspace's events, and
keep sending, for as long as that tab stays open.

Details that matter:

- The event is emitted **before** the disconnect, on the same connection, so the client sees the
  reason.
- `disconnectSockets(false)` disconnects from this namespace only and sends a proper disconnect
  packet. A *server-initiated* disconnect is one `socket.io-client` does **not** auto-reconnect
  from — which a merely dropped connection would be.
- It targets `agent:{workspaceId}:{userId}`, so all of that person's tabs go at once (and, once a
  Redis adapter exists, their sockets on other API instances too).

`afterAccessReduced()` fires this **after the transaction commits, never inside it**: a broadcast
cannot be rolled back, so telling agents "this session is back in the queue" before the commit is
final would be telling them something that might not become true.

### 5.4 The race between "claim a conversation" and "remove the member"

`HandoffService.claim()` now opens with:

```ts
await lockMembershipForShare(manager, workspaceId, userId);
```

which is `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`, inside the
claim's own transaction.

The problem it solves: `WorkspaceGuard` checked membership when the request arrived, but a removal
can commit between that check and the claim's `UPDATE`. That would leave a conversation claimed by
someone no longer in the workspace — and **invisible to the removal's own cleanup**, because it
wasn't claimed yet when `releaseClaimedSessions()` ran.

`FOR SHARE` is a *read* lock: any number of agents can hold it at once (two claims don't block each
other), but it blocks a `DELETE`/`UPDATE` of that membership row until the holding transaction ends.
So exactly one of two orders happens:

- **claim locks first** → the removal waits → the removal then sees the just-claimed session and
  cleans it up;
- **removal commits first** → this `SELECT` finds no row → the claim is refused with a 403.

What can no longer happen is the in-between: a claim finishing *after* the removal's cleanup.

---

## 6. Invitations

Two services, deliberately apart:

- **`InvitationsService`** — the inviter's side. Caller is an authenticated member with
  `members.invite`. Create, list, get, resend, revoke.
- **`InvitationAcceptanceService`** — the invitee's side. Caller holds a token and may not have an
  account at all. Preview, accept, accept-with-signup.

Different caller, different authorization model, nothing in common but the table.

### 6.1 The token

```ts
function generateToken() { return randomBytes(32).toString('base64url'); }   // 43 chars
export function hashToken(t) { return createHash('sha256').update(t).digest('hex'); }
```

32 random bytes = **256 bits from the OS CSPRNG**. Guessing one is not a rate-limiting problem, it
is a physics problem — which is also *why SHA-256 is the right hash here and bcrypt would be wasted
effort*. Slow hashing exists to protect **low-entropy** secrets (passwords) from offline guessing; a
256-bit random token has nothing to guess. Same reasoning as Phase 2's refresh tokens.

**The token exists in exactly two places: the invitee's inbox, and nowhere else.** The database has
only its SHA-256. No API response ever returns it — not create, not resend. If the API returned it,
anyone with `members.invite` could skip the email and accept on the invitee's behalf, and the
email-ownership check would mean nothing.

Two places it deliberately avoids travelling:

- **In the email link it is a URL fragment**: `https://app/invite#token=…`. Browsers never send the
  fragment to any server — not in the request to our Frontend, not in the `Referer` header to
  third-party scripts, not into any access log along the way. The page reads it with JavaScript.
- **In API calls it is a POST body**, never a path or query string — `POST /invitations/preview`,
  not `GET /invitations/:token`. Bodies are not written to access logs, proxies or browser history
  the way URLs are.

### 6.2 Creating one — `InvitationsService.create()`

```
assertWithinCeiling(inviter, role)      role ceiling (below)
consumeSendQuota(workspaceId)           50 sends / hour / workspace
SELECT … memberships JOIN users         already a member? → 409
INSERT INTO invitations …               partial unique index → 409 on a concurrent duplicate
sendInvitationEmail(id, token)          enqueue, after the row is committed
return getSummary(…)                    never contains the token
```

**The role ceiling.** `ROLE_RANK = { viewer: 1, agent: 2, owner: 3 }`; you cannot invite (or manage
an invitation for) a role above your own. Only owners hold `members.invite` today, so **it never
binds yet** — but the day agents are granted `members.invite` (a one-row change), this is what stops
an agent inviting an owner and thereby promoting themselves by proxy.

The distinction worth keeping: **permissions answer "may you invite?"; the ceiling answers "whom, at
what level?"** — a check on the *data*, which a route-level permission cannot see.

**Rate limits.** Invitations send email on our behalf, which makes them a spam vector: register a
free workspace, then invite ten thousand strangers from our domain. That burns the sending domain's
reputation, and then real invitations land in spam *for every customer*. So:

- 50 sends per workspace per hour (`consumeSendQuota`), and
- 3 resends of **one** invitation per hour.

Both use Phase 14's `FixedWindowRateLimiter` — one atomic Lua `INCR`+`EXPIRE`, 250 ms Redis timeout,
and fail-open to a weaker per-instance counter rather than to no limit at all.

**Ordering of the email enqueue.** It happens *after* the row is committed. The reverse order could
email a link to an invitation that then failed to save. What it still does not cover, and the code
says so: Redis being down right at that point leaves a saved invitation whose email never went out —
recoverable (the inviter sees it pending and resends), not silent. The full fix is a transactional
outbox, which this project does not need yet.

### 6.3 Reading the list

`SUMMARY_COLUMNS` / `SUMMARY_FROM` are shared by every read, so list and single-row responses have
one shape. The list query:

```sql
SELECT *, count(*) OVER()::int AS "total" FROM (
  SELECT <summary columns, including the derived status CASE> FROM invitations i
  LEFT JOIN users inviter … LEFT JOIN users accepter …
  WHERE i.workspace_id = $1
) s
WHERE ($2::text IS NULL OR s.status = $2)
  AND ($5::text IS NULL OR s.email ILIKE $5 ESCAPE '\')
ORDER BY s."createdAt" DESC, s.id DESC
LIMIT $3 OFFSET $4
```

Three things to notice:

- **The subquery exists because the filter is on the derived status** — the `CASE` has to be
  computed before the outer `WHERE` can see it. The inner `WHERE workspace_id` still uses the index.
- **`count(*) OVER()`** answers "how many in total" in the same query as the page itself. When the
  page is empty there is no row to carry it, so an out-of-range page reports 0.
- **Search wildcards go in the bound value**, via `containsPattern()` + `ESCAPE '\'` — not
  concatenated into the SQL. Same discipline as the handoff queue's search.

### 6.4 Resend — and why it rotates the token

```sql
UPDATE invitations
SET token_hash = $3, expires_at = now() + '7 days', last_sent_at = now(), send_count = send_count + 1,
    email_status = 'queued', email_sent_at = NULL, email_last_error = NULL
WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
RETURNING id
```

The old token was never stored, only its hash — so it **cannot** be resent even in principle. And
that is the point: a resend usually means "I lost it" or "it went to the wrong place", and in both
cases the previous link should stop working.

The `status = 'pending'` condition is not decoration: the row may have been accepted or revoked
between the permission check and this statement, and a resend must not resurrect it. Zero rows
affected → 409.

### 6.5 Accepting — the single-use guarantee

Everything funnels through one conditional `UPDATE`:

```sql
UPDATE invitations
SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $2
WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
RETURNING id, workspace_id, role
```

Of any number of concurrent accepts with the same token, the first to take the row lock matches the
`WHERE`; the rest re-evaluate it after that commit, find `status = 'accepted'`, and match nothing.
Same shape as Phase 12's claim — the condition lives on the very row being written, so a plain
`UPDATE` is atomic and no explicit lock is needed. It also closes the race with a concurrent revoke
or resend: whichever commits first wins.

On a miss it does a second read purely to produce a precise error:

- no such token → **404** "not valid. If it was resent, use the most recent email."
- `accepted` → **409** (a conflict with current state)
- `revoked` or expired → **410 Gone** ("it existed and is no longer usable", which is what 410 means)

**One message for "no such token", whatever the reason** — never "this token existed but was
replaced". The most common real cause is clicking an older email after a resend.

### 6.6 The two accept paths

**Existing account — `acceptAsExistingUser(token, userId)`** (behind `JwtAuthGuard`):

```ts
const [invitation] = await manager.query('SELECT email FROM invitations WHERE token_hash = $1', …);
const [user]       = await manager.query('SELECT email FROM users WHERE id = $1', …);
if (user.email !== invitation.email) throw new ForbiddenException(
  `This invitation was sent to ${invitation.email}, but you are signed in as ${user.email}…`);
await this.consume(manager, tokenHash, userId);
await this.joinWorkspace(manager, consumed, userId);
```

**The email binding is the whole security model of the accept side.** Without it, whoever the link
reaches joins the workspace — an invitee who forwards it to a colleague, a shared mailbox, a link
pasted into a ticket. The invitation grants access to a *person*, identified by the address it was
sent to, not to "whoever holds this URL". Slack, GitHub and Google Workspace all enforce the same
match.

**No account — `acceptWithSignup(token, password)`**: creates the account, joins, and signs them in,
in one step. Two structural details worth internalising:

1. **The pre-check read happens outside the transaction**, and bcrypt runs outside it too. bcrypt
   takes ~250 ms *on purpose*; inside the transaction it would hold the row locks the `INSERT`s take
   for that entire time. The read is advisory only — the transaction re-checks everything that
   matters.
2. **The user `INSERT` and the invitation consume are in the same transaction.** If `consume()`
   throws (revoked or expired a moment ago), the whole transaction rolls back *including the user
   just inserted* — so a dead invitation never leaves an orphan account behind.
3. **Tokens are issued after commit.** Tokens for a user whose transaction then rolled back would be
   tokens for nobody.

Note there is **no email field** in `AcceptWithSignupDto`. The account is created with the address
the invitation was sent to — which is the address that just proved it received the email.

`joinWorkspace()` uses `INSERT … ON CONFLICT (workspace_id, user_id) DO NOTHING` and reports
`alreadyMember: true` if a row was already there. **An invitation never changes an existing role** —
their current role is kept.

### 6.7 `preview` and the enumeration question

`preview` returns `accountExists: boolean` so the page can choose "sign in to accept" vs "create
your password". Revealing whether an address has an account is normally an enumeration leak — but
here it is revealed *only* to someone holding a 256-bit token that already names that address, so
there is nothing left to enumerate. Worth noting as an example of a rule that is contextual, not
absolute.

Previewing does **not** consume the invitation. It is a pure read.

---

## 7. The email subsystem

`src/email/` is new, and is structurally a twin of `StorageAdapter` (Phase 3) and
`EmbeddingProvider` (Phase 7): features depend on an interface, and swapping providers is one new
class plus one line in the module.

```
InvitationsService.sendInvitationEmail()
        │ EmailService.enqueue(message, tag)
        ▼
  BullMQ queue "email"  ── attempts: 5, exponential backoff 10s/20s/40s/80s
        │                  removeOnComplete: true (the payload contains a live token)
        ▼                  removeOnFail: { age: 24h }
  EmailProcessor (concurrency 2)
        │ EMAIL_SENDER.send(message)        ← SmtpEmailSender | ConsoleEmailSender
        ▼
  EmailDeliveryEvents.report(tag, outcome)
        │ (handler registered by InvitationsService at OnModuleInit)
        ▼
  UPDATE invitations SET email_status … WHERE id = $1 AND token_hash = $2
```

### 7.1 Why it is a queue at all

SMTP to Gmail takes 1–3 s and fails transiently (rate limits, TLS resets, a hiccup). Retrying inside
the HTTP request would make the inviter wait for all of it. The queue retries with backoff instead —
Phase 4's machinery, reused.

Delivery is **at-least-once**, as it has been since Phase 4: if the worker dies after SMTP accepted
the message but before the job is marked complete, the job is redelivered and the email is sent
twice. For an invitation that is harmless — both copies carry the same token — which is why no
dedupe is attempted.

### 7.2 `EmailDeliveryEvents` — the direction of the dependency

`EmailModule` must not know that invitations exist. So features register a handler by tag type:

```ts
this.deliveryEvents.register('invitation', (ref, outcome) => this.recordDelivery(…));
```

and the worker reports into it. **Features → email, never back.**

`report()` **never throws**, and this is a genuinely subtle point: delivery bookkeeping is a side
effect of sending, not part of it. If recording "sent" failed and that error reached the worker, the
job would be marked failed and **retried — and the retry would send the email a second time**. The
email already went out; the only acceptable consequence of a bookkeeping failure is a stale status,
logged.

### 7.3 Why the delivery update matches on `token_hash` too

```sql
UPDATE invitations SET email_status = 'sent', … WHERE id = $1 AND token_hash = $2
```

A resend rotates the token and queues a new email. If the **old** email's job finishes (or fails)
after that, its report must not overwrite the status of the new one. The hash identifies *which
send* a report is about. (There is a test for exactly this: "ignores a delivery report for a token
that has since been rotated".)

### 7.4 Sender selection, and the boot-time refusal

```
SMTP_HOST set          → SmtpEmailSender (real delivery)
unset, not production   → ConsoleEmailSender (prints the message, including the link, to the log)
unset, production       → throw at boot, refuse to start
```

The last rule is the important one. Silently falling back to "print it" in production would look
like a working system — invitations "sent", no errors — while no email ever arrives and **every
token lands in the logs**. Logs are read by far more people and systems than an inbox is, and a
logged token is a usable token. Failing at boot makes a missing config a deploy error.

`MAIL_FROM` is also validated at boot: `"Anchor"` alone is a display name, not a sender. Caught
there, rather than as a rejected or rewritten message on the first real send.

Same shape in `InvitationsService`'s constructor for `FRONTEND_URL` — and note the `|| undefined`
rather than `??`: a key present in `.env` with no value (`FRONTEND_URL=`) arrives as an **empty
string**, which `??` treats as a real value. Links would silently become `/invite#token=…` with no
host at all.

### 7.5 HTML escaping in the email body

`invitation-email.ts` escapes the workspace name and inviter email before interpolating them into
HTML. These are **user-controlled text going into a language with its own syntax** — the same
injection shape as SQL injection. Unescaped, a workspace named
`<a href="https://evil.example">Click to verify your account</a>` turns our own, legitimately-sent,
SPF/DKIM-passing invitation into a phishing email from our domain.

The plain-text part needs no escaping — it is never interpreted. Both parts are always sent: some
clients show only plain text, and spam filters score HTML-only mail worse.

### 7.6 Config

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465          # 465 = TLS from the first byte; 587 = plaintext then STARTTLS
SMTP_USER=…
SMTP_PASS=…            # a Gmail App Password in development
MAIL_FROM=Anchor <you@gmail.com>
FRONTEND_URL=http://localhost:3000
```

Gmail is fine for learning and wrong for production: ~500 recipients/day and it sends from a personal
address. Production wants a transactional provider on the product's own domain with SPF/DKIM/DMARC,
so mail authenticates as coming from that domain and lands in inboxes rather than spam.

---

## 8. The API surface

### Inviter's side — `/workspaces/:workspaceId/invitations` (all require `members.invite`)

| Method | Path | Does |
|---|---|---|
| `POST` | `/` | Create + email. Body `{ email, role }`. 409 if already a member or already pending; 403 above your ceiling; 429 over quota. |
| `GET` | `/` | Offset-paginated list. Query: `page`, `pageSize`, `status` (incl. `expired`), `search`. |
| `GET` | `/:invitationId` | One invitation (the invite dialog polls this while the email is queued). |
| `POST` | `/:invitationId/resend` | Rotate token, reset expiry, re-queue email. 409 unless pending. |
| `DELETE` | `/:invitationId` | Revoke. 409 unless pending. |

Every response is an `InvitationSummary`, **never containing the token**. Actions on another
workspace's invitation id return **404, not 403** — a 403 would confirm it exists.

### Invitee's side — `/invitations` (no workspace, no permission)

| Method | Path | Auth | Does |
|---|---|---|---|
| `POST` | `/preview` | none | Body `{ token }` → workspace name, invited email, role, inviter, expiry, derived status, `accountExists`. Does not consume. |
| `POST` | `/accept` | `JwtAuthGuard` | Accept as the signed-in user; 403 unless signed in as the invited address. |
| `POST` | `/accept-signup` | none | Body `{ token, password }` → creates the account, joins, returns tokens. |

### Member lifecycle — `/workspaces/:workspaceId`

| Method | Path | Permission |
|---|---|---|
| `GET` | `/members` (paginated, `search`, `role`) | `members.view` |
| `GET` | `/roles` (the role→permission matrix) | `members.view` |
| `PATCH` | `/members/:userId` | `members.manage` |
| `DELETE` | `/members/:userId` | `members.manage` |
| `POST` | `/leave` | `workspace.leave` |
| `POST` | `/transfer-ownership` | `workspace.transfer_ownership` |

`GET /auth/me` was extended to return, per membership, the **permission keys** that role holds — not
just the role name. That is what the Frontend renders from.

---

## 9. Frontend

### 9.1 Structure

```
app/team/page.tsx        → <DashboardShell><TeamPage /></DashboardShell>
app/invite/page.tsx      → <AcceptInvitation />          (outside the shell, on purpose)

features/team/TeamPage.tsx                 stat tiles, tabs, Leave, Invite — composes the two below
features/members/MembersTab.tsx            table, role select, transfer, remove
features/members/api.ts                    members + lifecycle calls, ROLE_RANK
features/invitations/InvitationsTab.tsx    table, status tabs, resend/revoke, details
features/invitations/InviteDialog.tsx      4-step wizard: Who → Role → Review → Sent
features/invitations/AcceptInvitation.tsx  the invitee's page
features/invitations/InvitationProgress.tsx  3-segment progress bar for a table cell
features/invitations/lifecycle.ts          one invitation row → timeline stages
features/invitations/api.ts                both sides' HTTP calls

shared/ui/Modal.tsx, Stepper.tsx, Timeline.tsx, IconButton.tsx   new generic pieces
shared/workspace/preferredWorkspace.ts                           new
```

`app/invite/page.tsx` sits **outside `DashboardShell`** because the person opening it is usually not
a member of any workspace yet, and may not have an account at all.

`TeamPage` lives in its own feature folder so `members/` and `invitations/` — which know nothing
about each other — never have to import one another.

### 9.2 `can()` — and what it is not

```ts
// WorkspaceContext
can: (permission) => current.permissions.includes(permission)
```

The comment in the code is the thing to remember: **this is what the UI shows or hides, never what
stops anyone.** Every one of these is checked again on the server for every request. Hiding a button
only spares the user a click that would 403.

The Frontend's `ROLE_RANK` mirrors the server's, used only to grey out roles above your own in the
invite form. The server enforces the same ceiling regardless of what the client says.

### 9.3 `TeamPage`

- **Counts come from the server**: four `pageSize: 1` requests whose `total` is the real count over
  the whole workspace — not a count of whatever page happens to be loaded.
- Invitation-related tiles and the tabs only render when `can('members.invite')`; a viewer sees the
  members list and nothing else.
- **Leave** does a full `window.location.assign('/')` after clearing the preferred workspace — a
  full navigation, not a client-side one, so every cached piece of that workspace's state (the
  shell's memberships, an open agent socket) is dropped rather than reused.

### 9.4 `MembersTab`

- Role is a `<select>` for everyone but yourself, when you have `members.manage`; otherwise a badge.
- **Refetch on both success and failure** after a role change: success moves the row (the list is
  ordered by role), failure puts the select back to the value the server actually holds.
- Transfer ownership does a `window.location.reload()` on success — *your own* permissions just
  changed, and the shell reads them once from `/auth/me`.
- Both destructive actions go through `ConfirmDialog`, with bodies that say what actually happens
  ("Conversations they had claimed go back to the queue").

### 9.5 `InvitationsTab`

- Tabs are the four statuses plus All; `expired` is filterable even though it is never stored.
- **A self-stopping poll**: while any row on the page is `pending` + `emailStatus === 'queued'`, it
  refetches every 2 s so rows move to "sent"/"failed" on their own. The effect's dependency is
  `anySending`, so it stops by itself once nothing is in flight.
- An open details dialog is kept in step with the list rather than frozen at the moment it opened.

### 9.6 `InviteDialog` — a 4-step wizard

Who → Role → Review → Sent. Two details worth copying elsewhere:

- **Errors send you back to the step that can fix them**, with the server's own wording: 409
  (already a member / already invited) → step 0; 403 (role above your own) → step 1.
- **Step 4 follows the email**, polling `GET /invitations/:id` every second, **bounded at 45
  attempts**. It polls because the worker reports into the database and there is no push channel to
  the inviter's browser. After the bound it says "still queued" rather than polling forever.

The role picker's descriptions come from `GET /workspaces/:id/roles` — i.e. from `role_permissions`
itself — so what the dialog says a role can do is the policy that is actually enforced, not a
hand-written blurb that drifts.

### 9.7 `AcceptInvitation` — the invitee's page

States it distinguishes: `loading` / `missing` (no token in the URL) / `invalid` / `ready`, crossed
with viewer: `checking` / `signed-in-match` / `signed-in-other` / `signed-out`. That cross product is
what decides whether step 2 shows "Accept", a password field to sign in, or a create-password form.

Three things in it that are not obvious:

1. **It listens for `hashchange`, not just mount.** Going from `/invite#token=A` to `/invite#token=B`
   — a second link pasted into the same tab — changes only the fragment, which the browser treats as
   the **same document**: no reload, no remount. Reading the token once on mount showed invitation
   A's details with invitation B's link. *The code notes this was found by screenshot.*
2. **After joining, `history.replaceState(null, '', '/invite')`** — the token is spent, so it comes
   out of the address bar and out of that history entry. (`replaceState` never fires `hashchange`,
   so this does not re-trigger the effect above.)
3. **404/409/410 re-preview the invitation**, so if it was accepted, revoked or expired while the
   page sat open, the page updates to show the new state instead of just printing an error.

On success it calls `setPreferredWorkspace(workspaceId)` so the dashboard opens the workspace they
just joined rather than a picker.

### 9.8 `access-revoked` on the agent socket

```ts
agentSocket.on('access-revoked', (payload) => {
  notifyError(new Error(payload.reason === 'role-changed'
    ? 'Your role changed and no longer includes the agent console.'
    : 'You no longer have access to this workspace.'), 'Access revoked.');
  window.setTimeout(() => window.location.assign('/'), 1500);
});
```

Without handling it, the console would sit there looking live on a dead socket. The full navigation
re-reads `/auth/me`, so the app reflects the new access.

---

## 10. Failure cases and races, and what protects each

| Scenario | Protection | Where |
|---|---|---|
| Two invites to the same address at the same instant | Partial unique index `UQ_invitations_pending_email` → one 409 | migration + `isUniqueViolation` catch |
| Same link accepted twice | Conditional `UPDATE … WHERE status='pending' AND expires_at > now()` | `consume()` |
| Two sign-ups racing on one link | `users.email` UNIQUE; second `INSERT` waits, then 409 | `acceptWithSignup` |
| A dead invitation leaving an orphan account | User INSERT and consume share one transaction | `acceptWithSignup` |
| Accept vs. revoke/resend at the same moment | Same conditional UPDATE; whichever commits first wins | `consume()` |
| Forwarded invitation link | Email binding: signed-in address must equal the invited address | `acceptAsExistingUser` |
| Old email's delivery report overwriting a resent one | `WHERE id = $1 AND token_hash = $2` | `recordDelivery` |
| Bookkeeping failure causing a duplicate email | `report()` never throws | `EmailDeliveryEvents` |
| Two owners demoting each other → zero owners | `lockWorkspace` (`FOR UPDATE`) + `assertAnotherOwnerRemains` | `WorkspacesService` |
| Claim landing after a removal's cleanup | `lockMembershipForShare` (`FOR SHARE`) inside the claim's transaction | `HandoffService.claim` |
| Removed member's socket still live | `revokeRoom()` → emit reason, then `disconnectSockets(false)` | `RealtimeBroadcaster` |
| Demotion leaving conversations stranded | `releaseClaimedSessions` when the new role lacks `handoff.work` | `updateMemberRole` |
| Broadcasting a change that then rolls back | Broadcasts happen after commit, never inside | `afterAccessReduced` |
| A new route shipped with no permission decorator | Deny by default + logged error | `PermissionsGuard` |
| A permission added to code but not the DB | Boot refuses with a message naming the missing keys | `assertNoDrift` |
| Redis down during a rate-limit check | Fail open to a weaker per-instance counter, 250 ms timeout | `FixedWindowRateLimiter` |
| Workspace name used for phishing in the email | HTML escaping of all user-controlled text | `invitation-email.ts` |
| Production deploy with no SMTP configured | Boot refuses | `EmailModule.createSender` |

**Known gaps, stated rather than hidden:**

- **No transactional outbox.** Redis down between the invitation's commit and the enqueue leaves a
  saved invitation whose email never went out. Recoverable by resending, and visible as `queued`.
- **`PermissionsService` caches per instance.** A runtime edit to `role_permissions` would need a
  Redis pub/sub broadcast to reach every API instance. No runtime edit path exists yet.
- **`AgentPresenceService` is in-process** (pre-existing) — correct for one instance, must move to
  Redis the moment this API runs more than one.
- **"Sent" is SMTP-accepted, not delivered.** Bounces, spam placement and opens need a provider with
  webhooks.

---

## 11. Tests

Four new files. What each is really pinning down:

**`test/permissions.e2e.spec.ts`** — a **table-driven matrix**: for every (role × permission) pair it
issues a real request and asserts CAN or cannot. Plus three behavioural tests:

- `/auth/me` reports each membership's permissions;
- **a `role_permissions` change takes effect with no code change, once reloaded** — this is the
  proof that the table, not the code, is the policy;
- **the app refuses to load when a permission in code is missing from the database.**

**`src/common/guards/permissions.guard.spec.ts`** — a unit test, three cases: deny with no
decorator, enforce a class-level permission (*the case the old `RolesGuard` silently ignored*), and
let a method-level one override the class-level one.

**`test/invitations.e2e.spec.ts`** (~35 tests) — creation and the never-returned token; the 7-day
expiry measured by the **database** clock; case-insensitive duplicate refusal; **exactly one of
several concurrent invitations to one address succeeding**; re-inviting once an earlier invitation
is no longer pending; refusing to invite an existing member; the role ceiling binding even for an
agent explicitly granted `members.invite`; token rotation on resend killing the old link; the resend
cap; revoke idempotence; **404-not-403 for another workspace's invitation**; derived-`expired`
filtering and pagination; HTML escaping in the email.
Then an `accepting` block: preview without consuming; single use; wrong-account refusal that leaves
the link usable for the real invitee; 410 for expired/revoked with **no account created**; two
concurrent accepts; two concurrent sign-ups leaving exactly one account; malformed token rejected
before touching the database.
Then an `email delivery tracking` block: queued → sent; reset to queued on resend; **a report for a
rotated token ignored**; `report()` never throwing.

**`test/member-lifecycle.e2e.spec.ts`** — removal ending REST access immediately *with the same
unexpired token*; claimed conversations going back to the queue **keeping the original wait time**;
the live socket cut off with a reason while other agents are told the conversation is back; last-owner
protection on both removal and leave; self-removal redirected to `leave()`; demotion releasing
conversations only when the new role loses `handoff.work`; ownership transfer atomicity; and the
race test — **a removal waiting for an in-flight claim, then releasing what it claimed**, plus a
claim from someone removed a moment ago being refused.

Notice the pattern in the ones that matter most: they are not "does the happy path work", they are
**"does the invariant survive two things happening at once"** — which is the only way a conditional
UPDATE or a `FOR SHARE` lock can be shown to earn its place.

---

## 12. Reverse-engineering guide (reopening this in six months)

Read in this order:

1. **`src/common/permissions/permission.enum.ts`** — 12 lines, tells you every capability that
   exists.
2. **`src/database/migrations/1790740000000-CreatePermissions.ts`** — the seeded policy, and the
   shape of the two tables.
3. **`src/common/guards/permissions.guard.ts`** then **`src/modules/tenancy/permissions.service.ts`**
   — how a request is judged, and why the app can refuse to boot.
4. **`src/modules/invitations/invitations.service.ts`** — the inviter's side; start at `create()`,
   then `resend()`.
5. **`src/modules/invitations/invitation-acceptance.service.ts`** — the invitee's side; start at
   `consume()`, which is the whole single-use guarantee.
6. **`src/modules/workspaces/workspaces.service.ts`** — bottom of the file first
   (`lockWorkspace`, `assertAnotherOwnerRemains`, `releaseClaimedSessions`), then the four public
   methods that use them.
7. **`src/email/email.module.ts`** — the sender selection and the boot-time refusals.
8. Frontend: **`features/team/TeamPage.tsx`** (composition), then
   **`features/invitations/AcceptInvitation.tsx`** (the only genuinely stateful screen).

**To change what a role can do**, you do *not* edit a controller: insert or delete a
`role_permissions` row (in a migration) and restart. To add a **new** permission: add it to the enum
*and* insert it in a migration — one without the other stops the app at boot, deliberately.

**To test the email path locally** with no SMTP: leave `SMTP_HOST` unset and read the link out of the
server log (`ConsoleEmailSender` prints it). With Gmail: set `SMTP_HOST=smtp.gmail.com`,
`SMTP_PORT=465`, an App Password in `SMTP_PASS`, and `MAIL_FROM="Anchor <you@gmail.com>"`.

---

## 13. Interview questions this work generates

1. Why store a permission catalogue in the database instead of an enum in code — and what does that
   buy you *operationally*?
2. Why does `PermissionsService` refuse to boot on drift rather than just logging? What class of bug
   is it converting into what other class?
3. Why does a route with no permission decorator get denied instead of allowed?
4. Phase 12's claim needed only a conditional `UPDATE`. Ownership changes need `SELECT … FOR UPDATE`.
   What is the difference between the two invariants?
5. What is write skew, and which of the operations here could produce it?
6. Why `FOR SHARE` on the membership row during a claim, and not `FOR UPDATE`?
7. Why is the invitation token hashed with SHA-256 rather than bcrypt, when passwords are the other
   way around?
8. Why does the emailed link put the token in the URL **fragment**, and why does the API take it in a
   POST body?
9. Why is `expired` derived rather than stored, and what does that cost at query time?
10. Why is `UNIQUE(workspace_id, email)` wrong, and what does the partial index change?
11. Why does resend rotate the token instead of re-sending the old one? (Two reasons — one is that it
    *couldn't* even if it wanted to.)
12. Why must `EmailDeliveryEvents.report()` never throw?
13. Why does the delivery-status update match on `token_hash` as well as `id`?
14. Why does removing a member need a WebSocket-level action at all, when REST is re-checked per
    request?
15. Why are broadcasts emitted after the transaction commits rather than inside it?
16. What does "sent" actually mean over SMTP, and what would it take to know more?
17. Why is `accountExists` in the preview response not an enumeration vulnerability here?
18. Why does bcrypt run *outside* the acceptance transaction?

---

## 14. What is deliberately not built

- **Custom roles per workspace.** Roles are an enum, not a table, so a workspace cannot define its
  own. Making `roles` a table is the natural next step real products take; `role_permissions` is
  already shaped for it.
- **A runtime admin UI for the permission matrix.** `GET /roles` is read-only; editing is a
  migration. Adding editing needs the cache-invalidation broadcast mentioned above.
- **Bounce/open tracking**, which needs a provider with webhooks rather than raw SMTP.
- **A transactional outbox** for the invitation email enqueue.
- **Invitation reminders** (a scheduled "you still haven't accepted" nudge).
- **Bulk invite** (paste 20 addresses). The per-workspace send quota already anticipates it.
- **Domain-based auto-join** ("anyone with an `@acme.com` address can join"), a different trust model
  from per-address invitations.
