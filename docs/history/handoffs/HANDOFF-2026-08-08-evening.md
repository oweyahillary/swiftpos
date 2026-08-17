# SwiftPOS — session handoff, 8 August 2026 (evening)

Supersedes HANDOFF-2026-08-08.md for anything they disagree on.
Companion: **AUDIT-REGISTER.md** — the living tracker. This is the narrative of
one session; the register is the standing list. **If they disagree, the register
wins.**

**§0 RULES is new and is the point of this document.** It is the standing
agreement on how work gets done here, so it stops being retyped every session.
Read it first. Everything below is one session's application of it.

---

## 0. RULES — standing, not per-session

### Delivery

1. **Only changed files ship**, in a zip whose folder structure mirrors the repo
   so it extracts over the project root. Never the whole tree.
2. **Every zip carries a manifest and a rollback line.** File list, one line per
   file on what changed and why, and the exact command to undo it. The manifest
   must be reviewable without extracting.
3. **Zips are cumulative within a session** and lettered (`-a`, `-b`, …). The
   latest supersedes all before it.
4. **State the base commit.** If a file being shipped whole has moved in the
   working tree, say so and ship a patch instead of overwriting.

### Evidence

5. **Research before coding.** Read the current source, not the docs, not
   memory. The docs in this repo have been wrong about the tree more than once.
6. **Full review, not symptom fixes.** When something breaks, find the class of
   problem and sweep for the rest of it. Fixing the line that shouted is how the
   next four arrive one at a time.
7. **Never say "fixed" — say what was run and what it printed.** Commands and
   output, plus an explicit list of what could NOT be verified. "Should work" is
   banned.
8. **Build and test in a sandbox before every handover**, not just type-check.
   A green from a type-checker is not a green from a run.
9. **State the environment a green came from.** Target is **Windows, Node 20,
   better-sqlite3 under Electron 35**. A Linux green is a weaker claim and must
   say so. See §0 note below.
10. **A test that passes with the bug present is decoration.** For any fix worth
    a test, remove the fix, confirm the test fails, restore it. Mutation-check.
11. **Errors travel verbatim** — full text, status code, and the server `ref`.
    Paraphrased errors send both sides down the wrong hole.

### Judgement

12. **If a fix starts growing, stop and ask.** Two files becoming five means the
    diagnosis was wrong, not that the fix is bigger.
13. **Additive during a deploy window.** No deletions, renames or migrations
    when a release is in flight; every change revertable by restoring one file.
14. **Nothing ships without a register ID.** Findings get a number and an entry,
    in the same zip as the code. Half the register's value is stopping the next
    session re-auditing closed ground — and it has already lost items once.
15. **Bump the desktop version on any desktop change, and TAG AFTER THE BUILD.**
    With no auto-update the version string is the only way to know what a till is
    running. Batch related fixes into one bump rather than four — and note that
    `release:patch` runs `npm version patch`, so the version is decided BY the
    build. Tagging first produced a `v0.5.24` for which no installer exists.
    Build, read the artifact filename, then tag.
16. **Some verification is only possible on the target.** Every handover ends
    with an explicit list of what the other side must check. Nothing is marked
    closed on bench evidence alone.

### Working with this codebase (added 2026-08-09, owner)

**Rule numbers are stable and never reused.** These append rather than slot into
the sections above, because 9, 10, 14 and 15 are cited by ID across the register
and every manifest, and renumbering would silently break those references.

17. **Assume it is already built, halfway.** Before writing a line, sweep for the
    existing implementation and read it. This codebase's defining pattern is a
    subsystem complete at every layer except one wire — ESC/POS was built,
    tested and left unconnected; `adjust_product_stock` existed for a migration
    before anything called it; `chunkIn` had nine call sites while a handoff
    said zero. **Proposing something that already exists is worse than
    proposing nothing**, because it gets built twice and the two copies drift.
    Rule 5 says read the source instead of the docs; this says read it before
    designing, not after.
    - Say what already exists, then what is genuinely missing, then the delta.
    - When a design turns out to duplicate existing machinery, **say so plainly
      and withdraw it.** PHASE5 proposed a new `branch_staff` table when the
      local `users` table was already there and already synced.

18. **Zip only when code changed.** A batch that touches nothing but `.md` gets
    the changed file and the manifest entry — no archive. Zips are for applying
    code, and one that carries only prose trains the eye to skip them.

19. **Nothing but `README.md` in the repo root.** Documents live in `docs/` —
    manifests, handoffs, designs, notes, all of it. A cluttered root is how the
    ~140 stray zips happened, and it is how a stale file gets read as current.

20. **Be sure before you proceed, then build it clean and do not break it.**
    Uncertainty is a reason to check or to ask, never a reason to ship something
    approximate and see what happens. Concretely, in this repo:
    - **A green from every existing gate is part of "not broken"**, not an
      optional extra. Run them before claiming anything.
    - **Never loosen a gate to accommodate your own change.** If an assertion
      complains, the change moves, not the assertion. `test-office-role` checks
      by source-text regex within a character window; comments pushed an audit
      line outside it, and the right fix was restructuring the handler, not
      widening the window.
    - **If the right guard does not exist yet, do not ship the thing that needs
      it.** Record it as a finding and name the blocker. `device_role` does not
      exist server-side, so the endpoint that hands out PIN hashes was not built
      (A25).
    - Additive beats clever. One file restorable, one rollback line.

21. **Say "node" or "cloud". Never "server" on its own.** (added 2026-08-10,
    owner) Two machines answer to "the server" and they are not the same thing,
    which has already cost real time — including an afternoon diagnosing a
    device-registration failure while "deploy the server" meant one thing to one
    person and something else to the other.

    The vocabulary is not new; it is what the code already says. `device_role`
    has been `'till' | 'node' | 'office'` since Phase 3, and "the node" (105
    uses) and "the cloud" (47) already outnumber every alternative. What is new
    is banning the ambiguous term.

    | Term | Means | Do not write |
    |---|---|---|
    | **node** | the branch machine that serves its tills | "local server", "branch server", "the server" |
    | **cloud** | the hosted API | "the server", "remote", "backend" |
    | **till** / **peer** | a selling terminal that is not the node | "client" |
    | **office** | a node that cannot sell | — |

    - Applies to code comments, commit messages, the register, handoffs, and
      anything said to the owner.
    - **`getServerUrl()` returns the CLOUD url.** It is the most misleading name
      in the tree and it produced a wrong diagnosis on 2026-08-10. Rename it
      `getCloudUrl()`. The `device_config.server_url` COLUMN keeps its name —
      renaming a local-schema column is the class of change D6 warns about — but
      it gains a comment saying what it holds.
    - "The server is down" is not a usable sentence in a bug report. Which one?



The tills run **Windows, Node 20, Electron 35.7.5**. Three separate breakages in
one session came from assuming otherwise:

- `await import(absolutePath)` works on Linux; Windows ESM needs a `file://`
  URL via `pathToFileURL`.
- `node:sqlite` needs Node ≥ 22.5. The tills are on Node 20.
- `better-sqlite3` is rebuilt by `postinstall` (`electron-builder
  install-app-deps`) against **Electron's** ABI — `NODE_MODULE_VERSION` 133, not
  Node 20's 115. **Plain `node` can never load it.** That is not a broken
  checkout.

**Therefore: anything touching SQLite runs under Electron-as-Node.**
`test/run-under-electron.mjs` exists for this. `npm run test:desktop` uses it.

---

## 1. GOAL

Continue working the register down, desktop first, after a full audit of the
desktop app. Secondary: diagnose why Beryl's till stopped syncing.

Both met. The sync investigation cost three wrong hypotheses before the evidence
arrived — see §5.

---

## 2. STATE

### Verified at close of session

```
server tsc  OK   dashboard  n/c   desktop main  OK   desktop renderer  OK

check-schema-drift    OK   check-ipc-parity      OK
check-supabase-catch  OK   check-shared-sync     OK
check-rls-coverage    OK   check-table-usage     OK
check-sql-binds       OK   check-client-parity   OK
check-own-rows        OK   check-row-attribution OK

desktop suites (NEW)          92 total
  logFile              12     node
  syncEngine-failures  29     node
  heldOrders           21     better-sqlite3 under Electron 35.7.5
  pinCache             16     better-sqlite3 under Electron 35.7.5
  tokenStore           14     better-sqlite3 under Electron 35.7.5
```

All 92 run green on **Windows, Node 20**, the two SQLite suites on the real
driver and ABI. That is the first hardware-equivalent green in the project.

### Not yet done

- **Nothing is deployed.** Everything below is bench- and Windows-verified, but
  no till and no server has run any of it.
- **Shipped as 0.5.25.** Bumped to 0.5.24 to settle the old 0.5.23/0.5.24
  disagreement, then `release:patch` bumped again during the build. The artifact
  is `SwiftPOS-0.5.25-x64.exe`, tagged `v0.5.25` at `5ad57f7`; `v0.5.24` was
  deleted because no installer exists for it. See rule 15.
- **Two manual tests outstanding** — §6.
- No trading period has run on thermal. Unchanged from this morning.

### Decisions made (do not relitigate)

- **Offline sign-in caches the credential; it does not mint a session.** There
  is no server JWT offline and none is needed: orders push under the OWNER token
  (`syncEngine authHeaders`) and `cashier_id` comes from `staff_session`.
- **The fallback fires on transport failure ONLY, never on a rejection.** A 401,
  a 409 `PIN_NOT_UNIQUE`, a disabled account — those are answers and they stand.
  Otherwise a sacked cashier signs in by unplugging the network cable.
- **`override_pin_hash` is never cached.** A thief already has the till; the only
  credential worth stealing is the one that authorises voids, discounts past the
  floor and refunds on OTHER terminals. Elevated actions stay online.
- **bcrypt only, never the legacy hash format.** Legacy upgrades on the next
  online sign-in. Caching a weaker credential to widen offline coverage is
  backwards.
- **`bcryptjs`, not `bcrypt`.** Pure JS. A native module would hit the same ABI
  wall as better-sqlite3 (§0).
- **Held orders stay local and out of the sync queue.** A held order has no
  payment, so it is not yet an order. Cross-till recall is D9 and needs server
  state.
- **Encryption at rest (PHASE2-3-DESIGN §2d) is deferred** until Beryl onboards
  and pays. Owner's call, recorded knowingly: the pilot runs parallel to the
  client's existing system and nothing depends on it.

---

## 3. ACTIVE FILES

```
apps/desktop/src/main/logFile.ts             NEW  durable rolling log
apps/desktop/src/main/pinCache.ts            NEW  offline sign-in cache
apps/desktop/src/main/tokenStore.ts          NEW  credentials wrapped at rest (D5)
apps/desktop/src/main/index.ts                    startup token migration
apps/desktop/src/main/syncEngine.ts               inbound failure capture; refresh single-flight
apps/desktop/src/main/localDb.ts                  held_orders, staff_pin_cache
apps/desktop/src/main/ipcHandlers.ts              held handlers; offline PIN fallback
apps/desktop/src/main/preload.ts                  swiftpos.held channels
apps/desktop/src/renderer/lib/heldOrders.ts       rewritten - async over IPC
apps/desktop/src/renderer/pages/POSPage.tsx       8 functions async, 10 awaits
apps/desktop/package.json                         bcryptjs; test scripts
apps/server/src/routes/auth.ts                    verify-pin returns offlineAuth.pinHash
package.json                                 (root) package / package:check

apps/desktop/test/logFile.test.mjs           NEW  12
apps/desktop/test/syncEngine-failures.test.mjs NEW 29
apps/desktop/test/heldOrders.test.mjs        NEW  21
apps/desktop/test/pinCache.test.mjs          NEW  16
apps/desktop/test/tokenStore.test.mjs        NEW  14
apps/desktop/test/run-under-electron.mjs     NEW  the runner rule 9 requires
```

---

## 4. CHANGES MADE

### A1 — packaging (closed)
`npm run package` → `git archive --format=zip HEAD -o pos.zip`, plus
`package:check` which fails if `.env` or `node_modules` appear in the archive.

The root cause was never the zip. There was **no packaging script anywhere in
the repo**, so the archive was hand-built from a working folder. The fix had been
written as prose in five handoffs and committed as a script zero times. That is
why it recurred.

### D12 — inbound sync failures (closed)
`syncEngine.ts:328` was a bare `if (!res.ok) return false` on `/api/pos/init` —
status and body discarded, on the one call that matters, while tables, pumps and
stations all logged properly.

Compounding it: **the desktop had no durable logging at all.** Every
`console.warn` went to a console that does not exist on a packaged build.

Now: `logFile.ts` (rolling at 1 MB into one `.1` backup, never throws, no
secrets), catalogue pull and both token refreshes record status + body, and
`getSyncStatus()` gains `pullError`, `pullErrorSince`, `logPath` alongside the
existing `failedReason`.

**One slot per scope, not one overall.** The first cut used a single field; a
test caught it immediately — `syncAll()` drives a pull AND a refresh, both fail
together, and the last writer won. The status field reported "owner token refresh
failed" while the real cause was `BRANCH_NOT_LICENSED` on the pull. A confident
wrong message is the thing this change exists to stop. `auth` now outranks
`sync`, because a dead token explains a dead pull and not the reverse.

### D2 — held orders (closed)
Open tables lived as one JSON blob in renderer `localStorage`, read through
`catch { return []; }`. A truncated write — a power cut mid-persist, which a
restaurant till on unprotected mains meets eventually — made the parse throw and
the app report **zero open tables**. Silently, with the KOTs already on the pass.

Now `held_orders`, one row per tab, so a bad row costs one table rather than all
of them. **No `LOCAL_SCHEMA_VERSION` bump** — all 41 `CREATE TABLE IF NOT EXISTS`
statements run ungated on every open, so a new local table costs nothing in fleet
coordination.

- A corrupt cart returns the tab with an empty cart and a `corrupt` flag, so the
  cashier can rebuild it from the KOT. One lost cart is recoverable; a table
  disappearing is not.
- Recall is one transaction. Read-then-delete as two statements can hand the same
  tab to two recalls — two carts, one order number, one unbilled.
- **One-time idempotent import of the legacy blob**, clearing the old key only
  after the main process confirms. Without it the fix destroys the tables it
  exists to protect. A duplicated tab is annoying; a deleted one is a bill nobody
  can produce.
- Not cleared by `clearCatalogue()`.

Cost: the renderer API is now async, so 8 functions and 10 call sites in
`POSPage.tsx` changed.

### D13 — refresh rotation (client half closed)
Refresh tokens rotate and `auth.ts:736` revokes the consumed one, but
`refreshAccessToken()` had no single-flight guard across three call sites
(`ownerFetch`/PIN pad, sync loop, order push) and `refreshStaffToken()` none
across four. Two concurrent refreshes present the same token; the loser is handed
a 401 for a token that was valid when it read it, and the owner is signed out.
**Offline that is unrecoverable.**

Now: a single-flight promise on both paths, plus a one-shot retry when a 401
arrives AND the persisted token differs from the one sent — a stale in-memory
copy is bookkeeping, not a revoked session. A genuinely revoked token is not
retried.

**The crash window remains open and cannot be closed from the client.** The
server revokes before the response is sent, so any interruption before the till's
`UPDATE session` strands a dead token. Only a server-side grace period fixes it.

### D16 — offline sign-in (closed)
Everything on a till worked offline except the door. `auth:verifyPin` called the
server and threw; the local `users` table carried no hash to check against.

New `staff_pin_cache` + `pinCache.ts`. Cached only for staff who signed in on
**this terminal** while online. safeStorage-wrapped (DPAPI); nothing cached at
all if the platform cannot wrap it. Expires after 14 days without server contact;
cleared on logout. Offline verification scans all cached entries and refuses on
two matches, exactly as the server does — a shared PIN books one cashier's sales
to another, and the till has no more right to guess than the server has.

Server returns the hash from `/api/auth/verify-pin` for `surface === 'desktop'`
only, bcrypt only, the authenticated user's own hash only.

### D5 — credentials wrapped at rest (closed)
`session.token` / `refresh_token` and the staff equivalents were plaintext in
`swiftpos.db`. The refresh token is the durable one — 30 days, self-renewing —
so anyone with a copy of the file held working owner-scoped access long after
taking it.

New `tokenStore.ts` wraps values with safeStorage (DPAPI) into `*_enc` columns.
Eight read sites and three write sites route through it, and
`migratePlaintextTokens()` runs at startup so an upgraded till stops holding a
clear credential within seconds rather than within fifteen minutes.

**The plaintext is cleared only after the wrapped value has been read back in the
same write.** A naive version of this change is itself a lockout: wrap the
credential, fail to unwrap it later, and the till has destroyed the only copy of
something it cannot re-obtain — and offline the owner cannot sign in to replace
it. No safeStorage means plaintext, not a broken session. Same honest limit as
PHASE2-3-DESIGN §2d: defeats a copied `.db`, a stolen backup and a pulled disk;
not code running as the app user.

### Migration 46 — applied
`payments_method_check` admitted only cash/mpesa/card/credit while
`PaymentModal.tsx:49-57` offers Glovo unconditionally on every till. The
migration file predicted the symptom verbatim. Applied to production 08-08 and
verified in the constraint.

---

## 5. FAILED ATTEMPTS — read this one

Same convention as the previous handoff, and for the same reason: the pattern
matters more than the individual mistakes. All of these are mine.

1. **Diagnosed Beryl's failed orders three times from reasoning, and was wrong
   twice.** "It's Glovo" — the payloads were cash. "It's the shift foreign key" —
   the shift exists. Both were plausible, both were stated with more confidence
   than the evidence carried, and each cost a round trip. The server log line was
   available the whole time. **The check was possible and I theorised instead.**

2. **Shipped tests that only ran on Linux, twice.** `await import(absolutePath)`
   fails on Windows ESM; `node:sqlite` needs Node 22.5 and the tills run Node 20.
   Each was invisible in my sandbox and obvious the moment it ran on the target.

3. **Asserted "better-sqlite3 is built on your machine, because the app runs
   there."** It is built for **Electron's** ABI. The `postinstall` line saying so
   was in a file I had read two hours earlier. Then I compounded it by swallowing
   the real error and printing a guess about the cause — the exact behaviour I
   had spent the day flagging in this codebase.

4. **Claimed "fully tested" after type-checking in isolation with `strict:
   false`.** `tsconfig.main.json` is `strict: true`. The claim was not earned.

5. **Nearly shipped a diagnostic that lied.** The single `_pullError` slot
   reported the wrong cause when two failures raced. Caught only because a test
   drove the real code rather than the happy path.

6. **Broke a template literal with backticks inside a SQL comment**, and later
   broke a string while rewriting em dashes to ASCII. Both caught by building,
   neither by reading.

**The common thread, again: inference presented as fact, and environments assumed
rather than checked.** Rules 7, 8, 9 and 10 in §0 exist because of this list.

---

## 6. NEXT STEPS

### Immediately, before anything else
1. **Confirm `SUPABASE_SERVICE_ROLE_KEY` was rotated** after this morning's zip
   was deleted. If not, A1 is still a live P0 — the script prevents the next
   leak, not the last one.
2. **Bump to 0.5.24** and cut the release.

### Deploy order — one hard rule
**Server first, tills second.** `offlineAuth` does not exist until the server
ships, so a till updated first caches nothing and offline sign-in silently never
works, with no error to explain why.

### The two tests only the target can run
1. **Held-orders upgrade.** On the CURRENT build, hold two tabs — one dine-in
   with a KOT already sent, one delivery with a rider name. Close the app.
   Install 0.5.24. Open it. Both tables must be there, with carts, order numbers
   and the rider's name. **This is the only way this change can hurt you.**
2. **Offline sign-in.** Sign in online once. Pull the cable. Restart. The same
   PIN must work. A cashier who has NOT signed in on that terminal must be
   refused with a message telling them to sign in online once. This is also the
   first real exercise of Windows DPAPI — `safeStorage` was stubbed in tests, so
   the machine-binding behaviour is proven in logic only.

### Still unanswered from this morning
- **Eight orders failed 2026-08-07, 21:09–22:53 UTC**, all `attempts=5`, all
  "Failed to create order (ref: …)". Ruled out by evidence: not Glovo (payloads
  are cash), not the shift FK (shift `79c4881f-…` exists), not the reconciliation
  guard (600=600, 6040=6040), not an order-number collision (23505 returns 409).
  Only `throw createErr` at `orders.ts:681` yields the generic message, so it is
  an unhandled Postgres error **or something throwing after the RPC committed**
  (stock deduction and the rest run inside the same `try`). Two ways to settle
  it: grep the server log for `error 341849fb`, or check whether those
  idempotency keys already exist in `public.orders` — if they do, the money is
  recorded and the till is lying. **Real revenue, five-minute answer.**
- **`migrations/72_kudo_menu_composition.sql`** is named in the previous handoff
  §3 and is not in the repo. Uncommitted or lost.
- **Migration 68** identified (loyalty RPC parameter rename) but still not in
  git. `select pg_get_functiondef(oid) … 'increment_loyalty_points'` and commit.
- **`npm audit`: 23 vulnerabilities, 3 critical.** Probably build-chain only.
  Unverified — do not repeat that as fact until someone checks.

### Proposed, not agreed
- **D3 — auto-update, with per-client targeting.** Design agreed in discussion:
  `electron-updater` pointed at `GET /api/updates/feed?device_id=…` so the SERVER
  decides who is offered what. `user_devices` already carries device, branch,
  business and version; the admin portal is where a release is aimed. Default is
  that nobody is offered anything. Two decisions outstanding: **artifact hosting**
  (private Supabase bucket is the fit) and **per-machine + UAC vs per-user +
  silent** — cheapest to change now, while there is one till.
  - No code-signing certificate exists. **Updates still work unsigned** —
    integrity is the sha512 in `latest.yml`. Cost is an "Unknown publisher" UAC
    prompt. **Sign the release manifest with the existing Ed25519 tech-token
    keypair** (`lib/techToken.ts` signs, `techService.ts:118` verifies) — that
    buys authenticity without a commercial certificate, and retrofitting trust
    into a live update channel is a much worse conversation.
  - Whether SmartScreen interferes with an unsigned auto-update is **unverified**
    and must be tested on a real till, not assumed.
- **D4 — device enrolment.** Held deliberately until 0.5.24 has traded. It
  changes how a till authenticates, and with no auto-update a bad enrolment is a
  site visit. Needs a design decision first: `requireAuth` expects a `userId` on
  every token, so a device-scoped token needs a synthetic identity or a change to
  how the middleware resolves.

### Skipped deliberately
- **Encryption at rest** (PHASE2-3-DESIGN §2d) — owner's call, until Beryl pays.
  Note the honest limit already in that document: it defeats a copied `.db` and a
  stolen disk, not code running as the app user. Beryl's till requires a typed
  Windows password, so DPAPI is real protection there; BitLocker is not on.
- **Removing HTML printing** (~1,500 lines) — only after a full service on
  thermal, which has still never run.
- **D1** — Beryl's owner has one business, so the lockout is not firing, and D4
  removes it entirely when it lands.

---

## 7. WATCH FOR

- **`npm install` is required** in `apps/desktop` before building — `bcryptjs`
  is new.
- **Anything touching SQLite must run under Electron.** `npm run test:desktop`
  does this. Plain `node test/heldOrders.test.mjs` will fail with
  `ERR_DLOPEN_FAILED` and that is expected, not a broken checkout.
- **A till that never signs in online caches nothing**, so offline sign-in will
  appear not to work. It is working; there is simply nothing cached yet.
- **Legacy-hash users cannot sign in offline** until they have signed in online
  once, which upgrades them to bcrypt.
- **`swiftpos.log`** now exists in `%APPDATA%\SwiftPOS`. It is the first place to
  look when a till "isn't syncing", and it holds no secrets by design.
- **Thermal printing is still off by default**, which keeps D8 (the dispatch
  ticket that can print nowhere) dormant. Do not tick it on without reading D8.
- **The register lost items once.** C6, E1–E4, F, G1–G2 and H1–H2 appear in the
  changelog as opened and have no entry anywhere. Recover from
  `git show 415e044:docs/AUDIT-REGISTER.md` before the next session re-audits
  them.
