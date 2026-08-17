# SwiftPOS — HANDOFF, 3 August 2026 (full session)

Supersedes SESSION-HANDOFF-2026-08-02.md AND the interim
SESSION-HANDOFF-2026-08-03.md written mid-session. Read §1 and §5 before
touching anything. §5 (zip supersession) is the one that bites.

---

## 1. GOAL

**Ship 0.4.8 to both tills, trade a full day, close it centrally once, then
commit and push everything.** That is the gate. Phase 2a (replication
distribution) starts on the test report from that day — not before.

The session's larger arc: the fast-food pilot's two tills went from a build
that could not sell (a one-line bind bug in the sell gate itself) to a working
branch: LAN replication carrying payments, a manual recovery path for parked
sync conflicts, Phase 4 (central day close) built and tested, the tech window
grown a read-only DB console, the last open audit thread (ungated wipes)
closed, and the Phase 2/3 architecture decided and documented.

---

## 2. CURRENT STATE

### Deployed / installed / verified on hardware

- Tills at **0.4.7** (both). **0.4.8 pending** — five zips accumulated (§5).
- Server deployed unchanged during the session **until the final zip**, which
  contains one server file (`orders.ts`, pump_id passthrough) — deploy with
  the same push.
- **Verified on real hardware this session:** sell path, float modal, day
  gate, order replication T2→T1, the conflict **Retry sync** button clearing a
  real parked shift against production.
- **NOT yet exercised:** Phase 4's Close Branch screen (built + 27 assertions,
  zero hardware runs), the tech DB console, the gated wipes, pump_id.

### Versions and schema

- Desktop source: bump to **0.4.8** before building. Read the sidebar footer
  on a misbehaving till FIRST — three binaries said 0.4.5 in one week and it
  cost a day.
- `LOCAL_SCHEMA_VERSION` **46** = `REQUIRED_DESKTOP_SCHEMA` **46** (moved
  together, per house rule). v46 adds `node_instructions` + `node_peer_state`.

### Test/guard state (all green at hand-back, on better-sqlite3)

```
check-sql-binds                 165 statements (was 158 — two blind spots closed)
check-own-rows                  64 queries, all scoped
test-node-ingest                50 assertions (was 41)
test-sync-rejection-routing     18
test-branch-close               27  (new)
test-tech-db-console            38  (new)
tsc                             clean: desktop main, renderer, server
```

### The open trading-day picture

- Eugene's stuck **2026-07-30 shift**: closed locally, was parked in
  `sync_status='conflict'`; **cleared via the new Retry button** against
  production. If any conflict reappears, the card now shows the server's real
  refusal reason and a Retry button.
- Old peer orders ingested before the payments fix show Payment "—" on the
  node forever (cursor passed; test data). Server data complete. Cosmetic.

---

## 3. CHANGES MADE (in order, with root causes)

### 3.1 Sell-gate bind fix (`swiftpos-fix-sellgate-bind.zip`)
`getOpenShift()` — THE sell gate — had the ownership scope predicate with
**zero arguments bound**: `.get()` on one `?`. better-sqlite3 throws on every
call. One function, three symptoms: no float modal, "Too few parameter values"
at charge, day close broken. Fix: one line. Why the guard missed it: a
**comment between `prepare(` and the SQL** made the site invisible to the
regex (not skipped — unscanned), and `?? null` after the call was a second
hiding place. Both blind spots closed in `check-sql-binds.mjs`.

Also: `day:gate` IPC now **fails closed** — a throwing gate renders the red
hard-block with the reason instead of silently letting the till trade until
payment explodes (which is exactly what had happened).

### 3.2 Payments replication (`…-fix-payments-replication.zip`, superseded by 047)
Orders crossed the LAN **with items but without payments** — visible on the
manager screen as Payment "—" on a peer's order, and the branch method split
omitted every terminal but the node's own (cash+M-Pesa+Glovo ≠ revenue).
Payments now ride inside their order both directions, same transaction,
stamped `'peer'` (payments HAVE a sync_status column locally; 'pending' on a
node would be a row a future unscoped query pushes). Duplicate re-offer
back-fills missing children additively (INSERT OR IGNORE by child id).

### 3.3 Conflict retry (`swiftpos-047-retry-and-payments.zip`)
`syncEngine` deliberately never retries `'conflict'` rows (the C7 anti-loop
rule) — correct for permanent refusals, wrong for refusals whose EXTERNAL
cause clears (migration 42's one-open-drawer-per-cashier, the live case). Such
rows were parked forever, and the conflict card's hardcoded text promised a
sync nothing performed. Now: `retryConflictedShift()` re-arms the shift + its
floats + expenses + trading day **as one family**, refuses peer drawers on a
node (own-scope), and the card shows the **server's real refusal** with a
per-shift **Retry sync** button. Manual-by-a-manager is what makes retry safe
where automatic was not.

### 3.4 Business type on restart (`swiftpos-fix-businesstype-restart.zip`)
Item Mix "disappeared after the update" — it was never the update: **any
restart** downgraded the manager UI to retail. `auth:login` returns
`business.type` and persists it to device_config; `auth:getSession` (every
start) rebuilt `business` WITHOUT it → `modeFlags(undefined)` → 'retail' →
Item Mix and the restaurant overview gone. POSPage was immune (reads
device_config directly), which is why dine-in never broke. Fix: getSession
returns `type` from device_config. Interim proof without a build: full
sign-out + email login restores it.

### 3.5 Phase 4 — central day close (`swiftpos-phase4-central-day-close.zip`)
One deliberate deviation from BRANCH-SERVER-PLAN wording: **no push fan-out,
because peers run no server and that stays true.** PULL model:

- Node queues a `close_day` **instruction** (localDb v46 `node_instructions`);
  peers poll **every 15s** (`/node/instructions/poll`), piggybacking their own
  day state (`node_peer_state`) — because the node's replicated copies of peer
  shifts/days go STALE after close (append-only; the Phase 2b events gap) and
  must never be read for money.
- Peer executes `closeDayInstructed()` — same body as closeDay MINUS the local
  isManager check: **the authority is the instruction** (manager-created on
  the node, node-secret channel); `closed_by` records that manager, notes say
  "Closed centrally". Open-drawer refusal SURVIVES and acks by cashier name.
- **Idempotent**: no open day → ack success `already_closed`. **Date
  mismatch → named refusal** ("check the clocks"), never closes the wrong day.
- Instructions are **re-offered until ACKED** — delivery never retires them
  (a peer crashing mid-execute is asked again). A corrected amount REPLACES
  the pending instruction; an acked one is history. Unacked outcomes retry
  from `pendingAcks` on the next tick.
- **Counted cash is entered centrally; expected/variance come back in the ack
  from the till's own books.** Blind rule held harder: no expected figure
  shown centrally at all. The roll-up counts only confirmed acks.
- Unreachable till: visibly "waiting", forever-honest. Node down: tills close
  at the till exactly as before.
- UI: **Close Branch** tab in ManagerPage (all managers see it; on a non-node
  till it explains where it lives). Node's own day closes directly on the
  same screen.

### 3.6 Tech read-only DB console (`swiftpos-tech-db-console.zip`)
- Read-only enforced by a **dedicated readonly connection** — the engine
  refuses writes, not a parser. SELECT/WITH/EXPLAIN, one statement, 500 rows.
- **Secrets masked on the SOURCE column** (`pin|token|secret|password|hash|key`)
  — found and closed the `SELECT token AS t` alias dodge mid-build (the
  owner's bearer token lives in `session.token`; PIN hashes crack instantly
  offline; `node_secret` is the branch key). Residue, deliberate: an
  EXPRESSION wrapping a secret can leak — the verbatim audit is the backstop.
- Gated in **main** on an active tech session; query audited verbatim BEFORE
  it runs (a failing query is still on record). `device:reset` closes the
  console's handle so a wipe can still delete the file.

### 3.7 Wipe gates + pump_id (`swiftpos-048-final-wipegate-pumpid.zip`)
- **`config:clear` and `device:reset` now require an active tech session and
  are audited** — closes the audit's ungated-`clearDeviceConfig()` finding
  (it was the bypass around device-branch binding and, with per-seat
  licensing, a free seat mint). The reset's audit entry lives in the database
  being deleted, so the raw tech token is held **in memory only** (never
  persisted — tested) and the entry is flushed before the drop, capped at 3s
  so a wipe never hangs offline. Accepted residue: a reset in a fresh app run
  before re-unlock cannot flush — but the wipe still shows server-side as the
  device vanishing and a new one registering. Unsynced-orders guard intact.
- **pump_id end to end**: column existed in BOTH databases since migrations
  15/45; **nothing ever wrote it** — fuel reports read zero. Now: fuel cart
  line stores `pumpId` → order payload (first fuel line) → local insert →
  cloud payload (spread) → **server insert passthrough (the one server file
  this session)** → the tank-deduction code that was already reading it.
  Rode along with this rebuild exactly as the plan scheduled.

---

## 4. FAILED ATTEMPTS — worth knowing they were tried

- **"Close the old shift at the till" instruction was wrong.** I told the
  owner the amber stale-banner would surface Eugene's 30-Jul drawer after
  Hillary's closed. It could not: the shift was already CLOSED locally
  (`getOpenShift` returned null — the yellow "No drawer is open" box proved
  it); only its sync was parked, and nothing re-offers conflicts. That
  mis-instruction is what forced the real finding (3.3).
- **`triggerSync()` referenced in the retry handler — doesn't exist.** The
  push-only flush is `syncPush()`. Caught by grep before tsc.
- **preload insertion split the `day` namespace** — `day.close` landed inside
  `branchClose`. Caught by reading the diff, would have tsc'd clean and
  broken per-till close at runtime.
- **`shift.cashier_name` read off the shifts row** in ownDayState — the local
  shifts table has no such column; names live in `users` (the same "no such
  table: staff" class that once blanked the Close Day tab). Fixed to join.
- **Test regex flaws, twice**: a 900-char span too short for log→rmSync
  ordering, and a proximity check misread as persistence (`_rawToken`
  assigned two lines after `persistSession` ≠ persisted). Both asserts
  rewritten to test the actual property (index ordering; persistSession's
  BODY).
- **Alias unmasking shipped as "KNOWN LIMIT" for one commit** — then
  rejected: `stmt.columns().column` gives the source name, so the dodge was
  closable and was closed. Don't ship a bypass the driver can kill.
- **Renderer tsc narrowing failure** on the discriminated union
  (`strict: false` in the renderer tsconfig disables it) — explicit
  `r.ok === true` + assertion. Note for future renderer code.
- **`npm version 0.4.4`** — the owner pasted the old Glovo build command and
  went BACKWARDS; separately built 0.4.6-content labelled 0.4.5. Version
  discipline is now a standing rule, not advice.

---

## 5. ZIP SUPERSESSION — APPLY IN THIS ORDER

```
swiftpos-047-retry-and-payments.zip        (contains payments fix — skip the
                                            standalone payments zip entirely)
swiftpos-fix-businesstype-restart.zip
swiftpos-phase4-central-day-close.zip
swiftpos-tech-db-console.zip
swiftpos-048-final-wipegate-pumpid.zip     (LAST — its ipcHandlers.ts,
                                            techService.ts, syncEngine.ts
                                            supersede every earlier copy)
```

`swiftpos-fix-sellgate-bind.zip` is already applied and on the tills (0.4.6/7).
`swiftpos-fix-payments-replication.zip` is fully contained in 047 — do not
apply it after 047.

Then: `npm version 0.4.8 --no-git-tag-version` in apps/desktop, tsc both
configs, vite build, pack installer+portable, **install BOTH tills** (schema
46 + payments sender/receiver need both sides). Deploy the server (orders.ts).

### Verify after extracting, before building

```bash
node scripts/check-sql-binds.mjs                              # OK, 165
node scripts/check-own-rows.mjs                               # OK, 64
node --no-warnings scripts/test-node-ingest.mjs               # 50 passed
node --no-warnings scripts/test-branch-close.mjs              # 27 passed
node --no-warnings scripts/test-tech-db-console.mjs           # 38 passed
node --no-warnings scripts/test-sync-rejection-routing.mjs    # 18 passed
cd apps/desktop && npx tsc -p tsconfig.main.json --noEmit \
                && npx tsc -p tsconfig.json --noEmit
cd ../server   && npx tsc --noEmit
```

---

## 6. NEXT STEPS, IN ORDER

### 6.1 The gate (owner, tonight/tomorrow)
1. Build + install 0.4.8 both tills; sidebar footers must read v0.4.8.
2. Trade a real day.
3. **Five Close Branch hardware tests** (node terminal, Manager → Close
   Branch):
   a. Both tills trading → both listed, T2 shows "a drawer is still open
      (name)", last-seen < 30s.
   b. Close T2 with its drawer open → named refusal on the card, no spinner.
   c. Drawers closed → counted cash → Close → waiting → **closed with
      expected/variance within ~15s**.
   d. Close the node's own till same screen → roll-up 2 of 2.
   e. **Kill the app on T2, queue its close → sits "waiting" honestly;
      restart T2 → closes within 15s.** This one proves the crash-re-offer
      path outside the harness. Also re-check b after a restart.
4. Console smoke: tech session →
   `SELECT id, status, sync_status FROM shifts ORDER BY opened_at DESC LIMIT 5`
   works; `SELECT token FROM session` reads `•••masked•••`.
5. Wipe gate smoke: config reset attempt WITHOUT a tech session must refuse.
6. **Commit + push** (dev → main merge or PR). Commit message drafted in the
   conversation; server redeploy on main push is intended this time
   (orders.ts). Never commit `.env` files; package future zips with
   `git archive` (C0's packaging half is STILL unfixed — .envs were in
   pos.zip again this session).
7. Put this HANDOFF.md, PHASE2-3-DESIGN.md in the repo root; delete the two
   older 08-02/08-03 handoffs.

### 6.2 Phase 2 (me, on the test report) — ~8.5 days, design APPROVED
Per `PHASE2-3-DESIGN.md` (authoritative; includes everything below):
- **2a Distribution (2d):** replicated STAR, not true mesh (amendment
  approved) — tills pull other devices' rows from the node via `/node/since`
  with per-peer cursors (Phase 1 machinery reused); peers stay outbound-only.
  Gives 3 LAN copies within ~15s; T2-dies-with-open-shift exposure shrinks to
  that window. Trade-off accepted: node + second till dying in the same
  window is uncovered.
- **2b Events (2d):** `shift_closed` / `day_closed` / `order_voided` as
  append-only event rows; only the origin device may emit about its own row;
  idempotent appliers. Fixes replica staleness; upgrades Close Branch from
  poll-state to replica-accurate.
- **2c Bounded replicas + archive tier (2d):** peers prune OTHERS' rows at
  **90 days** (owner's number, changeable) and only when **confirmed by the
  archive tier** — cloud for online clients, THE NODE for fully-offline
  clients (node never prunes; growth is the safe failure). Offline clients
  get a **nightly encrypted snapshot job** (USB/second disk/NAS, N-snapshot
  retention, "last backup: when/where" on the manager screen, restore in
  RUNBOOK). Sales guidance: offline node on a secured office machine.
- **2d Encryption (2.5d, Phase 7 pulled forward):** SQLCipher via
  better-sqlite3-multiple-ciphers; in-place migration with .bak until
  verified. **One DEK, wrapped twice**: DPAPI/safeStorage (unattended boot)
  + a RECOVERY CODE shown once at install (scrypt-wrapped; cloud-escrowed
  additionally for online clients). Snapshots carry the recovery-wrapped DEK
  beside the .db → dead machine → new hardware → restore → code → trading,
  zero internet needed. Honest limit in client material: defeats copied
  .db / stolen disk / stolen till; NOT code running as the app user (that is
  BitLocker + Windows accounts, Phase 0). Rotation deferred to Phase 6
  (`PRAGMA rekey`).

### 6.3 Phase 3 — `office` role — 2-3 days
Third role at setup: node that CANNOT sell (no POS/drawer/shift/cash;
listener + ingest + Close Branch + management). **Consumes no activation
seat** (server counts only `role='till'`). Office-PC-as-node where a desktop
exists; T1-node + PC-as-viewer where it's a laptop. Node replacement =
documented `node_url` repoint per till; mDNS rejected deliberately.

### 6.4 Activation codes — ~1 day — jumps the queue if a client install books
**Decisions LOCKED (do not relitigate):** Licensing **Model B** — per-branch
licence (`branches.desktop_licensed` stays authoritative), codes minted in
the **ADMIN portal only** (never the owner; owner gets "Request a terminal"),
**branch-locked**, **quota'd** (`max_devices: N`), 7-day expiry, revocable,
stored hashed. `device_activation_uses` = seat ledger = billing ledger =
audit, one table. `/api/auth/activate-device` mints the same device session
as password login and writes the migration-52 branch binding in the same act.
Reinstall of a known device_id re-auths free; a wiped config = new device_id
= a VISIBLE new seat (interlocks with §3.7's gated wipes). Removes owner
email/password from till installs — the owner-credential-sharing problem the
owner raised.

### 6.5 Tech window backlog (proposed, accepted in principle, not built)
- **Node promotion lever** — ships inside 2a (promote role + start listener;
  peers repoint node_url with reachability probe). Without it "failover is a
  role flag" is a claim.
- **Diagnostics bundle** (~½ day) — versions, sync queue, recent log, drift,
  guard states → one zip.
- **Drift display** on the status card (trivial; `measureNodeDrift` exists).
- **Snapshot export / "verify last snapshot restorable"** — ships with 2c/2d.
- **Rebind visibility** (409 cause + window state) — with activation codes.
- Explicitly REJECTED: re-displaying the recovery code; any tech path to
  cash figures beyond counts.

### 6.6 Phases 5–6 (after the above)
Heartbeat/trading gate (3d — only now safe: failover is real) → branch secret
rotation (3d — new key only ever over a connection authenticated with the old
one; rekey folds in DEK rotation).

---

## 7. SKIPPED / DEFERRED, DELIBERATELY

- **True mesh (any-till-serves-any)** — replaced by the star (approved).
- **mDNS node discovery** — support burden dressed as a feature.
- **PIN-derived DB keys** — a POS that needs a human to boot is not a POS.
- **Automatic conflict retry** — manual-by-manager IS the design (C7 lesson).
- **Write access in the DB console** — every needed write becomes an audited
  feature (the Retry button is the pattern).
- **Central entry of the CASHIER count** — blind count stays at the till;
  Phase 4 centralises the manager's second count only.
- **Third install in one day** (business-type fix solo) — batched into 0.4.8.
- **Expression-wrapped secret leakage in the console** — audit is the
  backstop, deliberate residue.
- **`schema_migrations` bump for local v46** — local SQLite versioning is
  `LOCAL_SCHEMA_VERSION` + migrateColumns, not the Postgres migration table;
  no numbered SQL migration was needed this session (v46 tables are
  desktop-local).

## 8. UNRESOLVED, NOT BLOCKING (carried, some aging)

- **C0 packaging** — .env files were in pos.zip AGAIN. Rotate
  `SUPABASE_SERVICE_ROLE_KEY`; package with `git archive`.
- Render Shell SMTP test — never run; decides if email works from Render.
- `swiftpos.co.ke` (~KES 999) — blocks Resend/DNS-01.
- `schema-index.json` still built from migrations; run `--from-db` against
  Supabase once.
- Branch protection on `main` — bypassed repeatedly; honour or remove.
- Dashboard nav link for `/dashboard/open-drawers` — route exists, no
  sidebar entry (owner navigated by URL); one line, next dashboard batch.
- Old "—" payment rows on the node (pre-fix ingests) — cosmetic, ages out.
- eTIMS A-vs-B certification decision; tourism-levy rename; H1 payment-legs
  observation window; H3/H4 void-refund paths; M18/M19 — all pre-dating this
  session, unchanged.

## 9. HOW THIS SESSION WORKED

Every real finding came from **running it, not reading it** — the tradition
holds: the sell-gate bug was found by reproducing the till's exact error on
the real driver; the guard's blind spot by making the guard fail BEFORE
fixing the bug; the payments gap was on the owner's screenshot before it was
in the code; the alias dodge died because the test that documented it as a
limit was an embarrassment to read. Where a change touches cash or printing,
execute it against real data before trusting it — and when a till misbehaves,
**read the version string first**.
