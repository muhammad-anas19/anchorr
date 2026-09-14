# Phase 3 — Knowledge Base CRUD + File Upload & Storage

## Objective

Let a workspace upload a document (PDF/DOCX), store it durably, and manage it via CRUD — matching the prototype's Knowledge screen. Introduces multipart file upload handling and a storage adapter interface (local disk now, swappable for S3 later).

## Why the system needs this

Anchor's entire product depends on customers' documentation existing somewhere the AI can read it. Before any parsing, chunking, or embedding can happen (Phases 5-7), there has to be a real, tenant-scoped place for uploaded files to land, a database record tracking what exists and its lifecycle, and a storage layer that won't need to be rewritten the day this moves off a single server's disk.

---

## The diagnostic

10 questions asked up front, answered in one batch, scored honestly.

### Q1 — What multipart/form-data actually is
**Asked:** What's actually different about `multipart/form-data` encoding versus a plain JSON body, and why can't a file just be sent as a JSON field?
**Answer:** "we set file in binary becase it is not a text data and we use multipart it means that send file in blocks if at any point we get any error we dont have to start senfind from part1 we can resume where it broke."
**Score: UNKNOWN.** This describes resumable/chunked uploads (a real but *different* concept — e.g. the `tus` protocol, or HTTP range requests) — not what multipart/form-data actually is or does. A standard multipart upload is still one single, atomic HTTP request; if it fails partway, the whole thing has to be resent, there's no automatic resume built into the format. What multipart/form-data actually does: it lets **one request body contain multiple distinct parts** — each with its own headers (`Content-Disposition`, `Content-Type`) — separated by a boundary string the client picks and declares in the outer `Content-Type: multipart/form-data; boundary=...` header. This is *why* it exists: JSON is a text format, and raw binary bytes (a PDF's actual content) can't be embedded in JSON directly — you'd have to base64-encode it first, which both bloats the payload by roughly a third and forces the whole request to be buffered as one text blob before anything can be parsed. Multipart lets a request mix ordinary text fields and raw binary file data side by side, each part self-describing its own type, with no encoding tax on the binary part.

### Q2 — Where the uploaded file's data actually lives before the handler runs
**Asked:** By the time your controller method runs, where does the uploaded file's data physically live, and what determines that?
**Answer:** "so we write file on disk than execute uplaod route and if we got any validation error or etc we than delete it again (thats one of the drawback of storing files on disk)"
**Score: SHAKY.** Gets one real path right but presents it as the only path. `multer` (which NestJS's `FileInterceptor` wraps) supports different **storage engines**, configured explicitly: `memoryStorage()` buffers the entire file into RAM and hands your handler a `Buffer` at `file.buffer`; `diskStorage(...)` has multer itself stream the incoming bytes straight to a directory you configure, handing your handler a `file.path` pointing at where it already landed — **neither behavior is automatic**, it's a config choice made when `FileInterceptor` is set up. The "delete it again on validation failure" concern is real for disk storage specifically, but it's a consequence of *choosing* disk storage, not an inherent property of file uploads in general.

### Q3 — Storage adapter interface
**Asked:** Why put file storage behind an interface now, when there's only one backend (local disk) to support?
**Answer:** "so that in future if we want to migrate from toring on disk to cloude we dont have to edit evey controller or servce"
**Score: SOLID.** Exactly right, and consistent with the same DI/swappability reasoning from earlier phases — the point of the interface is that everything calling it (`save`, `read`, `delete`) never needs to change when what's behind it does.

### Q4 — Trusting a client-declared Content-Type
**Asked:** How much can you trust a client's declared `Content-Type` (e.g. `application/pdf`), and what could go wrong if your code assumes it matches the actual file content?
**Answer:** "we normally validate based on content type only, not by veifying the data in it that can cuase sql or command injection attack if our code is poortly written, so we must make sure our code is perfect if we dont want to verify internal content so that ever content in file shuld be treated as sting/text not commands"
**Score: UNKNOWN.** SQL/command injection is a different attack class entirely (about unsanitized data reaching a query or shell command) — not the actual risk here. The real risk: `Content-Type` is just a label the *client* chooses to send; nothing stops someone from uploading an executable, script, or malformed file while declaring it `application/pdf`. If your code trusts that label — to decide how to render/serve/parse the file, or to skip deeper checks — you can end up storing and later serving something dangerous under a false identity (e.g. a browser might execute an uploaded HTML/JS file if it's ever served back with the wrong assumptions in play), or Phase 5's PDF parser could simply crash on a file that isn't really a PDF. The actual mitigation is **content sniffing** — checking the file's real "magic bytes" (its first few bytes, which reliably identify true file type regardless of what the client claims) — rather than trusting the declared header.

### Q5 — Using the client's original filename directly
**Asked:** What could go wrong if the client's original filename were used directly as (part of) the storage path, and what's the general class of attack this is?
**Answer:** "so if file name is direclt being stored it can cause command or sql indection attack as i sail and also if to users have same file name so it becomes had for us to retrienve sso we use uuid fo storing files in disk but but keep file name in db for future retrivals"
**Score: SHAKY.** **The fix is exactly right** — generate a random identifier (UUID) for the actual storage filename/key, keep the human-readable original name only as metadata in the database. But the vulnerability being defended against is misdiagnosed (SQL/command injection again) rather than named correctly: this is **path traversal**. A filename like `"../../../etc/passwd"` or `"..\\..\\config\\secrets.json"`, used unsanitized inside something like `path.join(uploadDir, originalFilename)`, can walk the resulting path *outside* the intended upload directory entirely — potentially overwriting arbitrary files the server process can write to, or reading files outside the upload directory on the retrieval side. The filename-collision problem you also raised (two users' files sharing a name) is real too, and the UUID fix solves both problems at once — but it's worth being able to name the security one precisely.

### Q6 — File size limits
**Asked:** Where should a maximum file size actually be enforced, and what happens to a server that doesn't enforce one at all (or only checks size after fully reading the file)?
**Answer:** "so limit depends on what content we are asking from user usally it should be 5-10mbs for this type pf application, so it is poor that we store file before validating it that can cause our server hight bandwdth and our server will become fie sernver not code hahahah."
**Score: SHAKY.** The core instinct is right — validating *after* fully accepting an oversized upload is already too late, the damage (memory/bandwidth/disk exhaustion) is done by the time your code gets to check. What's missing is the actual mechanism: `multer` accepts a `limits: { fileSize }` option at configuration time, which makes it **abort the incoming stream the moment it exceeds the limit**, before ever fully buffering or writing the rest of the file — the limit has to be declared where the upload is *received*, not checked afterward in application code, or a malicious (or just careless) large upload can still exhaust server resources before your own validation code ever runs.

### Q7 — Reusing Phase 2's tenant-scoping
**Asked:** What did Phase 2 already build that a new tenant-scoped resource like `Document` should reuse, rather than reinventing?
**Answer:** "we can use workpace guard or tenantcontext service"
**Score: SOLID.** Correct and precise — `WorkspaceGuard` (verifying membership + populating context) and `TenantContextService` (holding the resolved `workspaceId`/`role` for the rest of the request) are exactly the pieces `Document` should sit behind, the same way `Membership` already does.

### Q8 — Modeling `status` before any processing logic exists
**Asked:** What's the architectural reason to model a document's `status` lifecycle now, before the thing that changes it (Phases 4-7) is built?
**Answer:** "so it is better for ux that he can know in which status his document is instead of just saying uploaded or not uploaded, also when we say processing we say user to be patient we are processing and creating script based on your data."
**Score: SHAKY.** The UX benefit named is real but secondary. The more load-bearing reason: **defining the shape of the data now means later phases only ever have to write to an existing column, never migrate the schema again to add the concept of "status."** `Document.status` starting at `'uploaded'` and eventually being driven through `'processing'` → `'ready'`/`'failed'` by Phases 4-7 means every phase after this one builds against a stable, already-decided contract — the API response shape, anything the Frontend eventually reads, and any code that queries "give me all ready documents" all get written once, against an enum that won't change shape later. This is a general pattern: model the states a domain concept will eventually have, even before the logic that drives every transition exists yet.

### Q9 — Why nest the route under `/workspaces/:workspaceId/documents`
**Asked:** What's the actual reasoning behind nesting a resource under its parent this way, beyond "it looks tidy"?
**Answer:** "its a good architecture decision becuse we are user many to amny relation between user na dworkspace and using this approach we can know in whihc workspace user whant to uplaod nstead upoading it to all workspace that user belongs t."
**Score: SHAKY.** The instinct that *which workspace* has to be specified somehow is correct, but "instead of uploading to all workspaces" isn't quite the failure mode — without the URL parameter, you'd need some *other* way to specify the target workspace (a body field, a header), not an ambiguous upload to everywhere. The stronger reasons for nesting specifically in the URL: it makes the resource's dependency on its parent structurally explicit (a `Document` cannot exist without a `Workspace` — the URL shape mirrors that), and critically, it's what makes `WorkspaceGuard` work at all — the guard reads `:workspaceId` straight off the route params, so nesting isn't just a style choice, it's the mechanism the authorization check depends on. It's also simple consistency with the pattern Phase 2 already established for `Membership`.

### Q10 — Detecting duplicate uploads
**Asked:** If the exact same file were uploaded twice, what should happen, and what would the system need to notice they're the same file?
**Answer:** "we can sor original file anme n db to check if it is already uploaded"
**Score: SHAKY.** Filename matching is a real, simple signal, but a weak one — two completely different files can share a name, and the *same* file content can be uploaded under two different names, neither of which filename-matching would catch correctly. The standard, more robust technique: compute a **content hash** (e.g., SHA-256) of the file's actual bytes at upload time and compare against hashes already stored for that workspace — this catches true duplicates regardless of filename, and doesn't false-positive on unrelated files that happen to share a name.

---

## Topics you must know before moving on

Ranked by how load-bearing each is for this phase's build:

1. **What multipart/form-data actually is, and that it isn't inherently resumable** (Q1) — this is the encoding every file upload in this phase rides on; the confusion with chunked/resumable upload protocols needs to be cleared up before writing the actual upload handler, or the mental model of what's happening on the wire will be wrong.
2. **Path traversal, named correctly, distinct from SQL/command injection** (Q5, and the same confusion recurred in Q4) — this specific vulnerability class showed up twice with the wrong name attached. The *fix* you already know (UUID-based storage keys); the *name* and *mechanism* of what you're defending against still need to land.
3. **Multer's storage engines (`memoryStorage` vs `diskStorage`) as an explicit configuration choice, not a given** (Q2) — needed to actually configure the upload interceptor correctly and reason about memory/disk tradeoffs.
4. **Enforcing limits at the point of ingestion, not after** (Q6) — a specific instance of a broader principle (validate as early as possible, before resources are already spent) that will recur constantly in backend work.
5. **Designing a schema/enum for states a system will eventually have, before the logic exists** (Q8) — the UX angle you named is real but not the main reason; the schema-stability angle is the one worth internalizing for future phases, several of which will fill in exactly this kind of pre-modeled lifecycle.
6. **Content hashing for true duplicate detection** (Q10) — filename-based matching is a common first instinct; knowing when it's insufficient (and reaching for a content hash instead) is a small, concrete, broadly useful pattern.

---

## Architecture & decisions (as built)

```
Client                JwtAuthGuard   WorkspaceGuard   RolesGuard   DocumentsController        DocumentsService              StorageAdapter
  │ multipart POST        │               │               │              │                          │                            │
  ├──────────────────────►│ verify JWT     │               │              │                          │                            │
  │                       ├──────────────►│ check Membership              │                          │                            │
  │                       │               │ populate TenantContext        │                          │                            │
  │                       │               ├──────────────►│ @Roles(owner,agent) check                │                            │
  │                       │               │               ├─────────────►│ multer buffers file       │                            │
  │                       │               │               │              ├─────────────────────────►│ sniff magic bytes           │
  │                       │               │               │              │                          │ (reject if not PDF/DOCX)    │
  │                       │               │               │              │                          │ sha256(bytes)               │
  │                       │               │               │              │                          │ check existing hash (409?)  │
  │                       │               │               │              │                          ├───────────────────────────►│ save(uuid, buffer)
  │                       │               │               │              │                          │◄──────────────────────────┤
  │                       │               │               │              │                          │ insert Document row         │
  │                       │               │               │              │                          │ (catch unique-violation:    │
  │                       │               │               │              │                          │  delete file, throw 409)    │
```

- **`multer`'s `memoryStorage()`, not `diskStorage()`.** Given a 50 MB cap, buffering the whole file in memory is simple and avoids ever having a half-written temp file on disk to clean up. This is a deliberate choice, not the only option — `diskStorage()` would matter once uploads get large enough that buffering everything in RAM becomes a real concern (not the case yet).
- **Storage key is always a fresh `randomUUID()`, never derived from the client's filename.** This isn't just a mitigation for path traversal (Q5) — it makes the vulnerability class structurally impossible, since user input never touches path construction at all. The original filename is kept purely as display metadata in `original_filename`.
- **MIME type is the sniffed value, not the client-declared one.** `mime_type` in the database is whatever `sniffMimeType()` determined from the actual bytes — the `Content-Type` header the client sent is never even read (Q4).
- **Duplicate detection is enforced at two layers, deliberately.** An app-level `findOne` check gives a fast, friendly 409 in the common case (one request at a time). The `UNIQUE(workspace_id, content_hash)` **database constraint** is the real backstop — proven necessary, not theoretical, by the concurrent-upload test in Failure Cases below, where the app-level check alone was provably insufficient.
- **`onDelete: 'SET NULL'` on `uploaded_by_user_id`, not `CASCADE`.** A document belongs to the *workspace*, not to the uploader — if that user's account is later removed, the document (and the business value of the fact that it's in the knowledge base) shouldn't disappear with them. This is a deliberate contrast with `Membership`/`RefreshToken`'s `CASCADE`, which really are per-user artifacts with no independent meaning.

## Data flow: `POST /workspaces/1/documents` with a file attached

1. `JwtAuthGuard` → `WorkspaceGuard` → `RolesGuard` run in that order (unchanged from Phase 2) — by the time the controller method runs, the request is authenticated, scoped to a workspace the caller actually belongs to, and role-checked.
2. `FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 50MB } })` runs next, parsing the multipart body. If the file exceeds the size limit, multer aborts and Nest translates it into a `413` before the controller method is ever entered.
3. `DocumentsController.upload()` hands the buffered file to `DocumentsService.upload()`.
4. `sniffMimeType(buffer)` checks magic bytes; `null` → `422 Unprocessable Entity` immediately, storage is never touched.
5. `sha256(buffer)` is computed; an app-level `findOne` for that `(workspaceId, contentHash)` pair returns early with `409` if a match exists.
6. A `randomUUID()` storage key is generated and the buffer is written via `StorageAdapter.save()`.
7. The `Document` row is inserted. If this fails on the unique constraint (the concurrent-upload case), the just-written file is deleted and a `409` is returned instead of a raw database error.

## Migrations: what each table and column actually stores

### `1789319175816-CreateDocuments`

**`documents`** — one row per uploaded file, scoped to exactly one workspace.

| Column | Type | Stores |
|---|---|---|
| `id` | integer, PK, auto-increment | The document's identifier. |
| `workspace_id` | integer, FK → `workspaces.id`, indexed, `ON DELETE CASCADE` | Which workspace this document belongs to. Deleting a workspace deletes its documents (the whole point of a workspace going away). |
| `uploaded_by_user_id` | integer, FK → `users.id`, nullable, `ON DELETE SET NULL` | Who uploaded it, for display/audit — but the document survives if that user's account is later deleted (see Architecture above). |
| `original_filename` | varchar | The human-readable filename the client sent — **display metadata only**, never used to construct a storage path. |
| `storage_key` | varchar, unique | A `randomUUID()` — the actual key `StorageAdapter` uses to locate the file. Bears no relationship to the original filename. |
| `mime_type` | varchar | The type **as determined by sniffing the file's actual bytes**, not the client's declared `Content-Type`. |
| `file_size_bytes` | integer | Size of the uploaded content, in bytes. |
| `content_hash` | char(64) | SHA-256 hex digest of the file's bytes — the real duplicate-detection mechanism. |
| `status` | enum (`uploaded`/`processing`/`ready`/`failed`), default `uploaded` | Phase 3 only ever sets `uploaded`; Phases 4-7 will drive the rest of this lifecycle. |
| `failure_reason` | varchar, nullable | Reserved for Phase 5+ (e.g. "the file appears to be a scan with no extractable text," matching the prototype) — unused so far. |
| `created_at` | timestamp | Upload time. |

Table-level constraint: `UNIQUE(workspace_id, content_hash)` — the same file's content cannot exist twice in one workspace, enforced by Postgres itself, not just application logic (see Failure Cases).

## Code walkthrough

**`src/database/entities/document.entity.ts`** — the entity described above. Note `uploadedByUserId`/`failureReason` both needed explicit `type:` on their `@Column()` decorators (`integer`/`varchar`) — the same TypeScript-reflection gap from Phase 1/2 (a `T | null` union collapses to `Object` at runtime, which TypeORM can't map to a Postgres column type without help).

**`src/modules/documents/mime-sniffer.ts`** — a deliberately tiny, dependency-free magic-byte check. Since only two file types are supported, hand-rolling this avoids pulling in a library (`file-type` or similar) for something this small — a real judgment call, not a default; if a third file type were added, revisit whether a proper library earns its place.

**`src/modules/documents/storage/storage-adapter.interface.ts`** + **`local-disk-storage.adapter.ts`** — the interface is three methods (`save`/`read`/`delete`); `LocalDiskStorageAdapter` is the only implementation, reading its base directory from `STORAGE_DIR` in `.env`. Wired into `DocumentsModule` via `{ provide: STORAGE_ADAPTER, useClass: LocalDiskStorageAdapter }` — swapping to an S3 adapter later means writing one new class and changing one line in the module, nothing else.

**`src/modules/documents/documents.service.ts`** — the core logic, deliberately ordered: sniff → hash → check-then-save → insert-with-catch. The `try/catch` around the final `documents.save()` specifically catches Postgres error code `23505` (unique violation) and translates it into the same `ConflictException` the app-level check produces — this is what makes the concurrent-upload race behave correctly instead of surfacing a raw 500 (see Failure Cases).

**`src/modules/documents/documents.controller.ts`** — `@Roles(MembershipRole.OWNER, MembershipRole.AGENT)` on `upload`/`remove` only; `list`/`getOne` have no `@Roles()` at all, so `RolesGuard`'s "no metadata → allow" branch (from Phase 2) lets any member through — viewers can browse but not mutate.

**`src/modules/documents/documents.module.ts`** — imports `TypeOrmModule.forFeature([Document, Membership])`, not just `[Document]`. The `Membership` import exists **solely** because `WorkspaceGuard` is transitively request-scoped (depends on `TenantContextService`) and needs `Repository<Membership>` reconstructable within *this* module's own context at request time — see Failure Cases for how this was actually discovered, not just asserted.

## Failure cases (tested for real, not hypothetical)

1. **Disguised file type.** A file named `totally-a-real.pdf` containing plain text (no PDF magic bytes) was rejected with `422` — the client's claimed extension/type was never trusted.
2. **Duplicate upload under a different filename.** The same PDF content, uploaded a second time with a completely different filename, was rejected `409` — proving detection is content-based, not filename-based. A genuinely different file's content was still accepted normally afterward.
3. **True concurrency on duplicate content.** Two requests carrying identical file content were fired *simultaneously* (`Promise.all`, not sequentially). **Predicted first:** both would pass the app-level "does this hash already exist" check (since neither had committed yet), both would write their own file to disk, and then race on the database insert — one winning, one hitting the unique constraint and cleaning up its own orphaned file. **Actual result matched exactly**: one request got `201`, the other `409`, exactly one row exists in `documents`, exactly one file exists on disk. This is the same lesson as Phase 1/2's "database constraints are the real safety net" — here it wasn't theoretical, the app-level check was directly, provably insufficient under real concurrency, and the `UNIQUE` constraint is what actually prevented a duplicate.
4. **Oversized upload.** A ~51 MB file (over the 50 MB limit) was rejected `413` by multer before `DocumentsService` ever ran — confirming the limit is enforced at ingestion, not after the fact (Q6).
5. **Viewer RBAC.** A `viewer` member was blocked (`403`) from both uploading and deleting, while still able to list documents — same pattern proven in Phase 2, now exercised against a second resource.
6. **Delete removes both the database row and the physical file.** Verified directly by listing the storage directory's contents after a delete — not just asserting the API returned success.
7. **Request-scoped DI failure, discovered for real, not staged.** `DocumentsModule` initially only imported `Document` via `TypeOrmModule.forFeature` (plus `TenancyModule`). The app failed to boot: *"Nest can't resolve dependencies of the WorkspaceGuard... make sure MembershipRepository is available in the DocumentsModule context."* This is a live, unplanned instance of Phase 2's still-flagged-weak topic (request-scoped DI): because `WorkspaceGuard` is transitively request-scoped, Nest has to rebuild its entire dependency chain fresh, per request, from whichever module is actually consuming it — and `Repository<Membership>` wasn't available in `DocumentsModule`'s own scope. Fixed by adding `Membership` to `DocumentsModule`'s own `TypeOrmModule.forFeature(...)` call, alongside `Document`. **This is exactly the kind of concrete, hands-on encounter that's supposed to make this topic finally stick** — worth revisiting in the closing quiz.
8. **A third recurrence of the same test-isolation bug.** Adding `documents` (which references `workspaces`/`users`) broke three *other* test files' `TRUNCATE` statements that didn't yet know it existed — the identical failure mode from Phase 2, now happening a third time with a new table. Fixed by adding `documents` to each affected `TRUNCATE` list. This is a standing maintenance cost of the "known simplification" (shared dev database across all test files) flagged since Phase 1 — every new referencing table requires updating every other test file's cleanup statement, and nothing currently enforces that this gets done. **Still not the real fix** — a dedicated test database remains the actual solution, now overdue across three phases of evidence that it keeps recurring.

## Tests and why each exists

- **`mime-sniffer.spec.ts`** (unit) — the four magic-byte cases: real PDF, real DOCX-shaped ZIP, unrecognized content, and an empty buffer. No database or HTTP involved; pure logic.
- **`test/documents.e2e.spec.ts`** (e2e, real HTTP + real Postgres + real disk) — every case in Failure Cases above is a real test here, not a manual check: valid upload, disguised-type rejection, duplicate rejection (renamed file), the concurrency race, list/get/delete with actual filesystem verification, viewer RBAC, and the oversized-file rejection.

## Reverse-engineering guide — if you open this in six months

1. Start at `src/modules/documents/documents.service.ts` — `upload()` is the one method worth reading closely; everything else is straightforward CRUD.
2. `src/modules/documents/storage/` — two files, an interface and its only implementation. If storage ever needs to move to S3, this is the only place a new class needs to be written; `documents.module.ts`'s provider wiring is the only other thing that changes.
3. If `DocumentsModule` (or any future module using `WorkspaceGuard`) fails to boot with a "can't resolve dependencies... available in `<Module>` context" error, it's almost certainly this: add `Membership` to that module's own `TypeOrmModule.forFeature(...)` call. See Failure Case #7 for why.
4. If tests fail with "cannot truncate a table referenced in a foreign key constraint" after adding a new entity, some other test file's `TRUNCATE` list is out of date — grep for `TRUNCATE` across `Backend/` and add the new table everywhere it appears. See Failure Case #8.
5. Run `npm test` inside `Backend/` — 7 suites, 29 tests as of this phase, all real (Postgres, Redis, and now the actual filesystem).

---

## Closing quiz

10 questions, batched, scored honestly. 3 SOLID / 3 SHAKY / 4 UNKNOWN — better than Phase 2's closing quiz, weaker in different ways than this phase's own opening diagnostic: two real wins landed cold (path traversal, content-hash reasoning), but `multipart/form-data`'s actual purpose is now wrong for the *second* time, in a *different* way, and one answer directly contradicts what the code in front of you actually does.

### C1 — What multipart/form-data actually is (second wrong answer, not the same wrong answer)
**Answer:** "ts main purpose is for seurity so that for every part we can find if the buffer is legitmate as it sends us metadata about the data bpackets of file."
**Score: UNKNOWN.** The opening diagnostic's wrong theory (resumable/chunked upload) has been replaced with a *different* wrong theory (a security/integrity-verification mechanism) — multipart/form-data does neither. There is no legitimacy-checking or security purpose built into the format at all. To restate plainly, one more time: it's an encoding that lets one HTTP request body hold multiple independent parts (a file, ordinary text fields, whatever), each with its own small header block (`Content-Disposition`, `Content-Type`) marking where it starts and what it is, all separated by a boundary string. That's the entire mechanism — no security, no resumability, no legitimacy verification. Worth approaching from a completely different angle next time (e.g., manually reading a raw multipart request body byte-for-byte) since two explanation attempts haven't landed it.

### C2 — Naming the vulnerability (repeat of Q5)
**Answer:** "path traversal"
**Score: SOLID.** Exactly right, no hedging needed. This is genuinely well retained.

### C3 — Why `WorkspaceGuard` needed `Membership` inside `DocumentsModule` specifically
**Answer:** "since workspace guard is request scoped so we we need membehip here too so that we can find the workspace id and role for every req"
**Score: SHAKY.** Correctly identifies request-scoping as the trigger (real progress — this was flat UNKNOWN twice in Phase 2). What's still missing is the actual DI mechanism: it's not that `Membership` is needed "to find workspace id and role" (that's what the guard's *logic* does, using data, not what makes the *provider* resolvable) — it's that because `WorkspaceGuard` is request-scoped, Nest cannot reuse one cached instance built inside `TenancyModule` for every consumer; it has to reconstruct `WorkspaceGuard`'s entire dependency chain fresh, per request, from whichever module is actually using it. `DocumentsModule` is a different "whichever module" than `WorkspacesModule`, so it needs its *own* visible path to `Repository<Membership>` for that reconstruction to succeed — this has nothing to do with what the guard's code does with the repository once built.

### C4 — Naming the race condition
**Answer:** "dontknow"
**Score: UNKNOWN.** This is called a **TOCTOU bug** (time-of-check-to-time-of-use) — a broad, extremely common class where code checks a condition ("does this hash already exist?"), then acts on the assumption that condition still holds ("...so it's safe to insert"), but time passes between the check and the act, during which the world can change. An app-level check can never fully close this alone because *any* gap between "check" and "act" — no matter how small — is exploitable by something else running concurrently during that gap. The only way to close a TOCTOU gap for real is to make the check-and-act a single atomic operation, which is exactly what a database `UNIQUE` constraint gives you: the database itself refuses the second insert as one atomic step, no gap for anything else to land in.

### C5 — Multer's size-limit enforcement point
**Answer:** "so as soon as the buffer reaches the file size limit we have defined multer will give error and stop accepting further and remove the saved buffers form disk too, and if we check after fully storng it than we are wasting unnecessary server resources."
**Score: SOLID.** Correct mechanism (stops mid-stream, not after full receipt) and correct reasoning (checking afterward wastes exactly the resources you were trying to avoid spending). One small mismatch worth noting: this project's config uses `memoryStorage()`, so there's no on-disk temp file for multer to clean up in our case specifically — that detail would apply if `diskStorage()` were in use instead. Doesn't change that the core answer is right.

### C6 — `SET NULL` vs `CASCADE`: the actual criterion
**Answer:** "we are deleting all the rows frm refresh and membership table silently in whihc that use id exist while in document when we delete user we will ot delete the document row we will just mark it as null"
**Score: SHAKY.** Correctly describes *what* each does mechanically (real, solid grasp of the FK behavior itself, consistent with Phase 1's Q6). What wasn't named is the actual *criterion* for picking one over the other: does this row have any independent value or meaning once its parent is gone? A `Membership`/`RefreshToken` row has none — it exists purely to describe a relationship or session tied to that specific user, so it should vanish with them (`CASCADE`). A `Document` has real, independent business value (it's part of the workspace's knowledge base) regardless of who happens to have uploaded it — so it should survive, just with a broken/nulled reference to the now-gone uploader (`SET NULL`). The rule in one sentence: *cascade what only exists because of the parent; null out references to a parent that the child doesn't actually depend on for its own meaning.*

### C7 — Why URL nesting matters mechanically (this one contradicts the actual code)
**Answer:** "it is absically a architecture desicion not must have thing because using this approach we are tell that documents must exist under workspace"
**Score: UNKNOWN — and worth flagging specifically because it's not just incomplete, it's incorrect about this codebase.** Calling it "not a must-have" is wrong given how `WorkspaceGuard` is actually written: `canActivate()` reads `Number(request.params.workspaceId)` directly off the URL route parameter — full stop, that's the only place it looks. If `workspaceId` were sent in the request body instead of the URL, `request.params.workspaceId` would simply be `undefined`, `Number(undefined)` is `NaN`, and the guard's membership lookup would search for a workspace that can never match — every request would be rejected, or worse, subtly broken in a way that's hard to trace back to "the ID isn't where the guard expects it." This is exactly the kind of gap worth catching by reading the guard's own source rather than reasoning about REST conventions in the abstract — the code in front of you is the actual authority here, not general API design taste.

### C8 — Why `content_hash`, not `(workspace_id, original_filename)`
**Answer:** "so we are also checking inside content hash of file and mark it duplicate only if two file hs exact same content not based on their names only."
**Score: SOLID.** Correctly reasons through both directions — different filenames with identical content are still caught, and identical filenames with different content are correctly *not* falsely flagged. This is exactly right.

### C9 — Making a recurring bug class stop recurring
**Answer:** "dont know"
**Score: UNKNOWN.** The `TRUNCATE`-list bug has now happened three times because the fix each time was "add the new table to the hardcoded list in N files" — which does nothing to prevent a *fourth* occurrence next time another referencing table appears; it just repairs the current symptom. A fix that actually stops this class of bug: don't hardcode table names in a `TRUNCATE` statement at all — query Postgres's own `information_schema.tables` for every table in the `public` schema at test-cleanup time and truncate all of them (with `CASCADE`, or in FK-safe dependency order) automatically. No new table can ever be "forgotten" because nothing is manually listing tables in the first place. This is a general principle worth having: when the same category of bug recurs more than once, the right question shifts from "what's the fix this time" to "what changes so this stops being a decision a human has to remember to make correctly, every time, forever."

### C10 — `memoryStorage()` vs `diskStorage()`, and the volatile/non-volatile mix-up
**Answer:** "if we use memory storage we are toring on ram whihc is non volatile and if our server gets cloed we will loose it and it is also expensive to store data on memory while disk keep data persistant and not that ush costly just accessing is slow as cimpared to memory"
**Score: SHAKY.** Real terminology error worth fixing precisely: **RAM is volatile** (contents are lost on power-off/restart); disk is **non-volatile** (persists). The sentence has the two words swapped. The surrounding instinct (RAM is faster but pricier per byte, disk is slower but persists and is cheaper) is directionally fine as general hardware knowledge, but it's not actually why `memoryStorage()` is the right call *for this specific upload flow*. The real reason: multer's chosen storage engine only needs to hold the file for the few milliseconds between "request received" and "our own code calls `StorageAdapter.save()`" — it was never being asked to persist anything long-term, `LocalDiskStorageAdapter` is what actually persists the file afterward. Given that, `diskStorage()` would just mean writing the same bytes to a temp file, then reading them back into memory anyway to hash/sniff/hand to our adapter — extra I/O for no benefit at a 50MB cap. `diskStorage()` earns its place once uploads get large enough, or concurrent enough, that holding many full files in RAM simultaneously risks exhausting server memory — a scale problem, not a persistence one.

---

## Topics to master — not just for Anchor, for being a genuinely strong engineer

Combining both quizzes for this phase.

### 1. What `multipart/form-data` actually is
**Search:** "multipart form data explained", "HTTP multipart request format", "why use multipart form data for file upload"
**Exposed by:** opening Q1 (UNKNOWN — confused with resumable/chunked upload) and closing C1 (UNKNOWN — confused with a security/verification mechanism). The single most-repeated, still-unresolved topic this phase, having now failed in two *unrelated* wrong directions. This is foundational, ordinary web-development knowledge — every file upload in every stack eventually rests on understanding this encoding, and it's worth deliberately re-approaching from a different angle (e.g. inspecting a raw multipart body byte-for-byte) rather than a third prose explanation.

### 2. TOCTOU (time-of-check-to-time-of-use) race conditions
**Search:** "TOCTOU race condition", "check then act race condition database", "atomic check and insert"
**Exposed by:** closing C4 (UNKNOWN), despite watching the exact bug get predicted and then proven in this phase's concurrent-upload test. This is one of the highest-leverage general concepts in all of backend engineering — it explains why "check if it exists, then insert" is never fully safe under concurrency in *any* language or framework, and why the fix is always making the check-and-act one atomic operation (a database constraint, a compare-and-swap, a lock) rather than two separate steps hoping nothing happens in between.

### 3. Request-scoped DI across module boundaries (continued from Phase 2)
**Search:** "NestJS request scoped provider across modules", "dependency injection scope propagation", "why does my guard fail to resolve in a different module"
**Exposed by:** Phase 2's opening Q6 and closing C2 (both UNKNOWN), now Phase 3's opening Q7 (SOLID on *what* to reuse) and closing C3 (SHAKY — real, concrete progress, but the actual mechanism still isn't named precisely). This is genuine improvement across two phases rather than a flat repeat, which is worth acknowledging — but it's not fully landed yet. The precise fact still to nail down: a request-scoped provider's entire dependency chain gets rebuilt per request, from the consuming module's own visible providers, not reused from wherever it was first declared.

### 4. Reading a guard's actual source before reasoning about API design in the abstract
**Search:** "NestJS ExecutionContext request params", "read the code not the convention", "REST resource nesting authorization"
**Exposed by:** closing C7 — the only answer this phase that didn't just miss a nuance, but actively contradicted what `WorkspaceGuard`'s own code does (`request.params.workspaceId`, nothing else). General API-design instincts are useful, but they're not a substitute for checking what a specific piece of code you're relying on actually reads its input from — especially when that code is short enough to read directly in under a minute.

### 5. Fixing a bug class structurally instead of patching the same symptom repeatedly
**Search:** "eliminate a class of bugs not just instances", "test database schema introspection cleanup", "why do the same bug keep coming back"
**Exposed by:** closing C9 (UNKNOWN) — and this is the third time the identical `TRUNCATE`-list bug has appeared across three phases, each time "fixed" by editing the hardcoded list rather than removing the need for a hardcoded list to exist. The transferable habit: after the *second* occurrence of the same bug shape, the right response shifts from "fix this instance" to "change the design so this shape of bug becomes structurally impossible" (here: discover tables dynamically from `information_schema` instead of hand-maintaining a list in N files).

### 6. Volatile vs non-volatile memory — precise terminology, and matching a storage engine to what it actually needs to do
**Search:** "volatile vs non-volatile memory", "multer memoryStorage vs diskStorage tradeoffs", "when to buffer in memory vs write to disk"
**Exposed by:** closing C10 (SHAKY) — a straightforward terminology swap (RAM is volatile, not disk) worth fixing precisely since it's the kind of thing that erodes credibility fast in a technical conversation if said backwards. The deeper, more valuable point underneath the vocabulary slip: the right choice of storage engine here didn't come from "which is more secure/persistent" in the abstract, but from asking what this specific engine is actually being asked to do — hold bytes for milliseconds before *our own* code persists them properly, not serve as the real persistence layer itself.

## Interview questions this phase generates

- "Explain multipart/form-data to me as if I'd never seen a file upload form before. What problem does it solve that a plain JSON body can't?" (Topic #1 — a great one to keep drilling until it's automatic.)
- "Two requests hit your API at the same instant, both checking 'does X exist' before inserting X. Walk me through exactly how this can still produce a duplicate, and what the one reliable fix is." (Topic #2, directly.)
- "You're debugging a NestJS app where a guard works fine in one module but throws a DI resolution error in another. What's your first hypothesis, and how would you confirm it?" (Topic #3 — this phase now has a real, lived example to reach for.)
- "A teammate points out this is the third time the same bug has appeared, just in a new place each time. How do you respond, technically?" (Topic #5.)
- "When would you choose to buffer an upload in memory versus stream it to disk? What's the actual deciding factor?" (Topic #6.)

## What I still don't understand

Carried forward, not glossed over:

- **`multipart/form-data`'s actual mechanism** (topic #1) — two wrong theories in a row means the next attempt should probably not be a third verbal explanation, but something more concrete (inspecting a real multipart request body directly, byte by byte, e.g. via `curl -v` or a packet capture).
- **TOCTOU race conditions as a named, general concept** (topic #2) — the specific instance (content-hash duplicate detection) is now well understood mechanically (Q8/C8 were both SOLID), but the *name* and *generality* of the underlying bug class didn't transfer, even having just watched it happen for real.
- **The precise mechanism of request-scoped DI reconstruction across modules** (topic #3) — closer than ever (SHAKY, not UNKNOWN), worth one more focused pass, ideally by deliberately breaking it again in Phase 4 or 5 and predicting the failure *before* triggering it, rather than being taught the explanation after the fact.

