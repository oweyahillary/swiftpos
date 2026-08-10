# SwiftPOS — Audit Register

**Living document.** The single tracker for audit findings: what is open, what is
closed, and what was checked and found correct. Update in place; do not fork.

| | |
|---|---|
| Opened | 2026-08-07 |
| Last updated | **2026-08-09, Beryl root cause (A14) + CI gap (A16)** |
| Tree | `dev` @ `5ad57f7`, tag **v0.5.25**, desktop **v0.5.25**, `LOCAL_SCHEMA_VERSION` 51 |
| Open | **A: 1 P0 · 4 P1 · 3 P2 · 5 P3 — D: 2 P0 · 2 P1 · 5 P2 · 2 P3** |
| Closed this session | **31 (printing) + 1 (migration 46)** |

**Header corrections, 08-08.** The previous header said `415e044 + this session's
work`; the work is committed at `a80c224` (59 files, not 58). It said the counts
were 5 P2 where section A lists 3. **C6, E1-E4, F, G1-G2 and H1-H2 appear in the
changelog as opened and have no entry anywhere in this file** — lost in the 08-08
restructure. They are neither open nor closed; they are missing. Recover from
`git show 415e044:docs/AUDIT-REGISTER.md` before the next session re-audits them.

`HANDOFF-2026-08-08.md` stated desktop v0.5.24 while `apps/desktop/package.json`
said 0.5.23. Bumped to 0.5.24 — then `release:patch` bumped again during the
build, so **the shipped artifact is `SwiftPOS-0.5.25-x64.exe` and the tag is
`v0.5.25`**. `v0.5.24` was deleted: no installer exists for it, and a tag
pointing at a version you cannot produce is worse than no tag.

**Rule learned: the tag follows the build, never precedes it.** `release:patch`
runs `npm version patch`, so the version is decided BY the build. With no
auto-update the tag is the only record of which source produced the `.exe` on a
given till.

**Working rules** live in `HANDOFF-2026-08-08-evening.md` §0 — standing, not
per-session. Rule 14 is the one this file depends on: nothing ships without an ID
and an entry here, in the same change as the code.

**Rules 21-23 added 2026-08-10.** 21 (owner): say **node** or **cloud**, never
"server" on its own. 22: a delivery zip carries the change, never the version —
a zip overwrote a version bump and produced two different binaries with the same
number. 23: mutation-check the GATE, not only the fix — both gates written that
day failed their own first version, one silently. Two machines answer to that word and it has already cost an
afternoon. `getServerUrl()` returns the CLOUD url and should be renamed.

**Rules 17-20 added 2026-08-09** (owner): assume it is already built halfway and
sweep before designing; zip only when code changed; nothing but `README.md` in
the repo root; be sure before proceeding, and never loosen a gate to accommodate
your own change. Rule numbers are stable and never reused — 17-20 append rather
than slot in, because 9, 10, 14 and 15 are cited by ID throughout this file.

**How to use this.** IDs are stable and never reused. Closed items keep their
entry — half the value of this file is stopping the next session re-auditing
ground already covered. New findings append with the next free number.

**Method.** Every item verified by reading or running source, not by reading docs.

**Severity.** **P0** money/data loss or a false-confidence trap · **P1** wrong
numbers or silent divergence · **P2** correctness residue · **P3** hygiene.

---

## Status at close of session

```
server tsc  OK   dashboard  OK   desktop main  OK   desktop renderer  OK

check-schema-drift    OK   check-ipc-parity      OK   (126/126)
check-supabase-catch  OK   check-shared-sync     OK
check-rls-coverage    OK   check-table-usage     OK   ← new, proves B6
check-sql-binds       OK   check-client-parity   OK   ← new, proves B5
check-own-rows        OK   check-row-attribution OK

offline suites        17/17
print resilience      51/51
printing package      spooler 18 + tickets 30, all passing
sample output         byte-identical to SAMPLE-OUTPUT.txt
```

58 files changed across the session.

---

## TOMORROW — before shipping

Agreed plan, in order:

1. **Run a full service on 0.5.25** with thermal on. Nothing below matters more
   than one real trading period.
2. **Final code review** — business logic, error reporting, UI logic.
3. **Remove HTML printing.** Only after 1 and 2. See P-06 for exactly what goes.
4. **Then** the register's remaining P0/P1 items.

---
## A. OPEN — carried into tomorrow

### A1 · P0 · OPEN · Secrets leak on every zip
`.env` files ride along because `pos.zip` is built from the working folder.
Rotated once this session; **the packaging is still unfixed**, so it will recur.

**Fix:** `git archive --format=zip HEAD -o pos.zip`. It honours the index, so
ignored files physically cannot get in. Two minutes, and it is the fourth time.

### A17 · P0 · OPEN · A peer till cannot sell "offline forever" — it locks out on day 15
**Stated design (owner, 08-09):** the main/server till is registered online once;
client tills then rely on the server till and **can keep selling without
internet indefinitely.** The code does not support that today, in three ways.

1. **Authentication is cloud-only.** `ipcHandlers.ts auth:verifyPin` calls
   `ownerFetch`, and `ownerFetch` uses `getServerUrl()` — which is
   `device_config.server_url`, **the cloud**. `node_url` is a separate field
   (`nodeClient.ts:21`) and **the node exposes no auth route at all**: its API
   is `/node/{health,sync,since,report,cursors,instructions,time,tech-session}`.
   There is no `/node/verify-pin`.
2. **So the only offline door is `staff_pin_cache`, and it expires.**
   `PIN_CACHE_TTL_DAYS = 14`, and `cached_at` is written from exactly one place —
   `cacheStaffCredential`, called only after a **successful cloud** verify-pin
   (`ipcHandlers.ts:443`). LAN contact with the node cannot refresh it. **On day
   15 of no internet, every cashier on that till is refused and the shop cannot
   open**, with the message "Saved sign-in expired after 14 days offline."
3. **A cashier who has never signed in on that terminal while online can never
   sign in at all** (D16 caches per-terminal, deliberately), and
   `override_pin_hash` is never cached, so voids, discounts past the floor and
   refunds are impossible for the whole offline period.

The 14-day bound was a correct decision for a *cloud-attached* till — it bounds a
stolen or retired terminal. It is the wrong bound for a till whose authority is
meant to be the branch node.

**This is a design gap, not a bug to patch.** Do NOT simply raise the TTL — that
widens the stolen-till window without giving the node the role the design says
it has.

**DESIGN AGREED 08-09** — owner confirmed the node is the branch's source of
truth and sole cloud uplink, and that it may stay offline indefinitely and may
authorise. Specification in **`docs/PHASE5-NODE-AUTHORITY.md`**. Expiry is
redefined there as "days since ANY authority was reached", so a peer that sees
its node daily never expires and a node never expires at all.

### A18 · P1 · OPEN · `nodeServer.ts` documents an architecture that no longer exists
Its header states the node is *"the SOLE uplink to the cloud: peer tills never
push to the cloud directly, so an order reaches the cloud by exactly one path
(till → node → cloud)"*, and that received peer orders are *"re-enqueued into
this node's sync_queue so the existing cloud push forwards them."*

**Both statements are false in the current tree.** `syncEngine.ts:1138-1151`
says the opposite explicitly — every till pushes its own orders to the cloud and
"the node is now a replica, reached separately by `pushToNode()`" — and
`nodeIngest.ts:414-418` records the reason (two destinations cannot share one
status column). `INSERT INTO sync_queue` appears in exactly one place,
`syncEngine.ts:1566`, at order creation on the till that made the sale.
**Nothing re-enqueues peer rows for cloud push.**

This is the file a new reader opens to learn the architecture. Header corrected
08-09 to describe the tree as it stands. **The finding stays open until §3 of
`docs/PHASE5-NODE-AUTHORITY.md` is implemented**, at which point the ORIGINAL
header becomes true again and the corrected one must be corrected back. Noted
here so that does not read as a regression.

### A19 · P1 · OPEN · A permanently-offline peer's sales never reach the cloud
Follows from A18. A peer till pushes to two independent destinations: the cloud
(`sync_queue`) and the node (`node_queue`). Under the stated design the peer has
no internet, so:

- the node receives the sales over LAN, so **branch totals and manager reports
  are correct locally** — this half works;
- the peer's `sync_queue` never drains, and the node does not forward it, so
  **the cloud never sees those sales.** The owner's web dashboard, cloud
  reports, eTIMS fiscalisation and cloud-side loyalty are all short by every
  peer sale, indefinitely, with no error anywhere.

**RESOLVED 08-09 — the node forwards.** Owner confirmed the node is the only
link to the cloud, and that cloud sync is for web access and backup rather than
for branch operation. A peer with a `node_url` will push to the node only; the
node enqueues peer rows into its own `sync_queue` preserving the original id and
idempotency key. The two-queue separation stays — `syncEngine.ts:1138-1151` was
right about the mechanism and wrong about the routing. See
`docs/PHASE5-NODE-AUTHORITY.md` §3, including why a node outage delays cloud
backup rather than losing sales, and why idempotency makes a mixed-version
rollout safe.

### A20 · P1 · OPEN · Failover cannot open the shop — the staff roster does not replicate
Follows from the owner's failover requirement (08-09) plus PHASE5 §4a. Promotion
already works well — `tech:promoteToNode` (`ipcHandlers.ts:1746`) is
session-gated, audited, clears `node_url` and starts serving; `collectDistribution`
fans every origin's rows to every peer; orders carry `_items` and `_payments` as
children (`nodeIngest.ts:641-648`), so a promoted till holds COMPLETE orders.

But `REPLICATED_TABLES` is `orders, shifts, float_transactions, expenses,
business_days, events`. PHASE5's `branch_staff` is specified node-only, so a
promoted till would hold every sale in the branch and **no way to authenticate
anyone** — the shop stays shut at exactly the moment failover exists to prevent.

**Decision required from the owner** — replicating the roster means a stolen
peer yields the branch's PIN hashes. Recommendation, tradeoff table and the
"a branch is one trust domain" argument in `PHASE5-NODE-AUTHORITY.md` §10.1.
Includes a runbook item that does not exist today: **rotate PINs when a terminal
goes missing.**

### A21 · P1 · CLOSED 08-09 · `outbox_cursors` is not keyed by node — rows strand on repoint
`localDb.ts:854` — `PRIMARY KEY (table_name)`. A peer records how far it has
offered its own rows as one number per table, with **no record of which node it
offered them to**. `peer_cursors` on the node side is correctly keyed
`(device_id, table_name)`; the peer side is not.

On failover: peer C has offered `orders` to seq 500; the dead node had only
distributed to 430 before dying; peer C is repointed at the promoted till and
**never re-offers 431-500**. Not lost — they are on peer C — but absent from the
new source of truth, the day close, and (under PHASE5 §3) the cloud, with nothing
reporting a gap.

**Fix:** reset the outbox cursors in `tech:setNodeUrl` when the URL actually
changes. Ingest is `INSERT OR IGNORE` / upsert-by-id, so re-offering everything
is absorbed — the same property that makes PHASE5 §3's rollout safe. Two lines,
no schema change. Keying the table `(node_id, table_name)` is cleaner but is a
local-schema change, and D6 already records six undocumented generations of that.
See §10.2.

**CLOSED 08-09.** `resetOutboxCursors()` in `nodeIngest.ts`; called from
`tech:setNodeUrl` **only when the URL actually changes** — re-entering the same
address must not trigger a full re-offer. The repoint audit line now carries
`node_changed`, and the reset is logged to `swiftpos.log`.

Option 2 (keying the table `(node_id, table_name)`) was NOT taken: it is a
local-schema change to the mechanism that decides whether a field till works, and
D6 already records six generations of that going undocumented. Revisit only if a
branch ever runs two nodes at once. The test asserts the current primary key, so
it will fail loudly if that ever changes.

12 tests in `apps/desktop/test/failover-cursors.test.mjs`, mutation-checked by
removing the DELETE (9 passed / 3 failed, exit 1; restored, exit 0). Ran on
`node:sqlite`, and **the suite prints that it did** — it is a stand-in, not the
app driver. Run under Electron on the target for a hardware-equivalent green.

### A25 · P1 · OPEN · The server cannot tell a node from any other till
Found while attempting PHASE5 §4b. **`device_role` does not exist anywhere in
`apps/server`** — grep returns nothing. So an endpoint that hands out the
branch's PIN hashes could only be gated on `surface === 'desktop'`, which every
till has, and on an owner token, which every till holds.

**The credentials endpoint was therefore NOT built.** Shipping it against that
guard would hand the branch roster to any till, and to anyone who lifted an owner
token off one — the opposite of what PHASE5 §4b exists to do.

This is the concrete form of the D4/D14 prerequisite named in PHASE5 §7. The
server must be able to verify that a caller is the branch's node before any
credential can cross that boundary. **D14 first (register the device), then D4
(enrol it), then §4b.**

### A22 · P2 · OPEN · Promotion has no split-brain check
`promoteToNode` clears `node_url` and starts serving immediately with no check
that the old node is gone. An old node that was merely unplugged, then
reconnected, gives the branch two nodes and peers pointed at either. Nothing
detects it. Low urgency while promotion is a human tech-session action, but a
node that can reach another node on its own branch should say so loudly. §10.5.

### A23 · P2 · OPEN · Distribution lag is the real RPO and is not measured
Promotion cannot recover rows the dead node originated but never distributed —
its own sales live only on its disk. So the recovery point is however far behind
distribution was, and **nothing measures or displays that**. Wanted: a "last
distributed" age on the tech screen. Also a runbook line that does not exist:
**do not wipe or re-image a failed node until its `swiftpos.db` has been read.**
§10.4.

### D14 · P1 · CLOSED 08-10 · The till is not registered — cause found, and it was not the upsert
**I called this a one-line upsert on `sync.ts:71`, then a device-enrolment
design decision. Both were wrong**, and the rule 17 sweep found far more built
than the register credited: `lib/deviceBinding.ts` (181 lines — rebind windows,
relocation history, terminal-code conflict handling, fails-open-until-bound),
`routes/devices.ts` (216 lines — fleet, approve, reject, delete, permission
gated) **and it is mounted**, at `routes/index.ts:94`.

**The cause is `auth.ts:432`:**

```js
const required = setting?.value === 'true' || setting?.value === true;
if (!required) return { result: 'allowed' };
```

Registration sits behind an opt-in business setting Beryl never enabled — and
`checkDeviceRegistration` returns earlier still for owners and elevated roles, so
a desktop till signing in as the owner fell through **both** gates.
`/desktop-login` registered nothing at all. Nothing was broken; registration was
never reached.

Three subsystems then degraded to silent no-ops while looking healthy:
migration 52's branch binding (`checkDeviceBranch` waves an unknown device
through, by design), fleet telemetry (an UPDATE matching no rows is not an
error), and A25.

**MEASURED IN PRODUCTION 2026-08-10, before the fix deployed:**

```
select count(*) from public.user_devices;                    ->  0
select count(*) ... where business_id = '<beryl>';           ->  0
select ... where key = 'require_device_registration';
   Lovers Rock | require_device_registration | false         (one row, all tenants)
```

**Zero registered devices across the ENTIRE fleet — ten businesses, seven of them
non-test.** And exactly one row for the flag anywhere: someone opened that
setting on Lovers Rock once and left it off.

So this was never a Beryl problem. **Device registration has never run for any
tenant, ever.** Everything downstream of it has been dead code in production
since the day it was written:

- `lib/deviceBinding.ts` (181 lines) — branch binding, rebind windows,
  relocation history, terminal-code conflict handling. Never executed.
- `routes/devices.ts` (216 lines) — fleet view, approve, reject, delete. Mounted
  at `routes/index.ts:94`, permission-gated, and always empty.
- Migration 43's telemetry columns — `app_version`, `schema_version`,
  `last_sync_at` never written for any till, so every diagnosis has required
  somebody physically at the machine.
- Migration 52's anti-relocation control — inert everywhere. A till moved
  between branches has been undetectable this whole time.

That is a large amount of correct, careful, well-tested work that has never once
run, gated behind a boolean nobody knew to set. **The lesson is not "turn the
flag on"** — it is that a subsystem with no observable output cannot tell you it
is idle. Nothing anywhere reported an empty fleet as unusual.

**Fix — the two concerns were conflated and are now separated.**
`require_device_registration` means *"cashiers must be approved before signing in
from a new BROWSER"*. It is a real, optional policy and is **untouched**. But a
desktop till is not a browser: it has a stable `device_id`, it is bound to a
branch, it is the unit migration 52 exists to control. So `lib/deviceRegistry.ts`
registers desktop terminals **unconditionally**, from `/desktop-login` and
`/verify-pin`.

New rows land `approved`, not `pending`: a pending row blocks the shop until
somebody opens the dashboard, which is unacceptable at the remote thin-internet
sites this product targets. Defensible because reaching that code already
required a valid owner token or a verified PIN — more than a browser fingerprint
proves. **An existing row's `status` is never touched**, so a rejected terminal
is not silently re-approved by signing in again.

**Registration is not authorisation.** No `branch_id` is set — `checkDeviceBranch`
owns binding, and guessing here could bind a till to the wrong branch
permanently. No `device_role` is set, so **A25 remains open by design**.

### A26 · P1 · CLOSED 08-10 · Fleet telemetry failed silently and blamed the wrong thing
`sync.ts` reported only an `error`. An UPDATE that matches **no rows is not an
error**, so a till with no `user_devices` row discarded its telemetry in silence
— the common case. The one message that could appear asked *"is migration 43
applied?"*, and 43 **is** applied, so the single available clue pointed away from
the cause. That is why diagnosing Beryl needed somebody physically at the machine.

Now `.select('id')` makes the matched count visible and a zero-row match says the
terminal has never registered, explicitly clearing migration 43. The mutation
check is enforced by the compiler: remove the `.select('id')` and there is no
`data` to count, so `tsc` fails.

20 tests in `tests/device-registration.test.mjs`, mutation-checked both ways.

### A27 · P1 · CLOSED 08-10 · The server could not tell what a terminal IS (and PHASE5 excluded office)
Raised by the owner: *"does this involve the view-only node?"* It did, and the
PHASE5 design was wrong.

`deviceConfig.ts:26` — `DeviceRole = 'till' | 'node' | 'office'`. Office is a
branch server that **cannot sell**: no drawer, no shift, no cash, safe
unattended, not meant to consume an activation seat. The file supplies
`isNodeRole()` and `canSell()` precisely so nobody tests the literal, and warns:
*"comparing against the literal 'node' anywhere else is how office machines fall
through cracks."*

**PHASE5 §4b did exactly that** — it gated credential distribution on
`device_role === 'node'`, which would have refused an office machine the branch
roster. Backwards: an office box is the BETTER holder, because it is the machine
that is safe unattended, which is the whole security argument of §10.1.
Corrected in `PHASE5-NODE-AUTHORITY.md` §12; every server-side gate now uses
`isNodeRole()`.

Three things were missing and are now built:
- **`user_devices` had no role column** (confirmed against the live dump).
  Migration **73** adds `device_role` (CHECK till|node|office) and
  `role_reported_at`, plus a `branch_serving_devices` view — the SQL form of
  `isNodeRole()`, with `is_view_only` marking an office machine.
- **The till never reported its role.** Sync sent `X-Schema-Version`,
  `X-Device-Id` and app version, nothing more. Now `X-Device-Role` too.
- **Registration ignored it.** `deviceRegistry.ts` stores and labels it — an
  office machine no longer appears in the fleet view as a till.

**Numbered 73, not 72:** migrations 68 and 72 are absent from this repo and 68 is
known to exist in production (A4). Reusing 72 would collide with whatever is
already applied there.

Existing rows stay NULL — *has not reported* — rather than being defaulted to
`till`. A guess that reads as a fact would make a branch server look like a
counter terminal until somebody noticed.

**A25 is NOT closed by this.** The server can now SEE a claimed role; it still
cannot VERIFY one. A device asserting `office` is exactly as trustworthy as a
device asserting its branch was before migration 52. Enrolment (D4) is what makes
it checkable, and no credential may cross that boundary until it does.

### A28 · P2 · CLOSED 08-10 · A missing migration would have lost the whole registration
Writing `device_role` in the same statement as the rest coupled every terminal
registration — and all fleet telemetry — to migration 73 being applied. If it
were not, the INSERT would fail entirely and no row would be created; the
telemetry UPDATE would fail and take `last_sync_at` and `schema_version` with it.

**Not hypothetical here.** Only **20 of 66** migrations record themselves in
`schema_migrations`, and 68 and 72 are absent from the repo entirely. A migration
being missing is the normal state in this project, not an edge case.

Now: the registry detects `42703` / `PGRST204` and retries without the role
columns, so the terminal registers regardless; and sync writes the role as a
**separate** statement, so telemetry is unaffected either way. Both paths log
which migration is missing, and say plainly what still worked.

### A4 · measured 08-10 — the migration ledger covers less than a third
Concrete figure for the "under-reports" claim: **only 20 of 66 migration files
contain an `INSERT INTO public.schema_migrations`**, so 46 are invisible to the
ledger. The version format is also split — 17 named (`'52_device_branch_binding'`)
against 1 bare (`'71'`) — so the table cannot be queried reliably by number
either. `60_menu_composition` and `61_adjust_product_stock` are recent examples
that record nothing.

Consequence unchanged and now quantified: **the ledger cannot be trusted to
decide what to run.** Still open.

### A25 · P1 · CLOSED 08-10 · The server can now verify a claimed role
Migration 73 let a terminal SAY what it is. **Migration 74** decides whether to
believe it — the difference between a diagnostic and a security control.

Same shape as migration 52, on purpose: trust on first use per branch, then
closed, with a manager-granted window for legitimate change. A second trust
mechanism would be a second thing to learn and a second thing to get wrong.

**One deliberate difference: this fails CLOSED where 52 fails open.**
`checkDeviceBranch` waves an unbound device through, because refusing would stop
a shop trading over a diagnostic. Here an unconfirmed device is refused
credentials, because the cost of a wrong answer is the branch's PIN hashes
rather than a misattributed sale. Refusing costs a machine offline
authentication until somebody confirms it; granting wrongly cannot be undone.

- `lib/deviceRole.ts` — `confirmServingRole()` (TOFU + conflict recording +
  handover) and `isConfirmedBranchServer()`, the read-only gate PHASE5 §4b must
  call. The gate never confirms as a side effect: a read that quietly grants is
  how a check stops being one.
- The branch is read from the device's **own server-side row**, never from the
  request. A caller-supplied branch would be a second claim propping up the
  first, which is what this exists to stop.
- `POST /api/devices/:id/authorise-handover` — one hour, matching
  `REBIND_WINDOW_MINUTES`. Granted on the OUTGOING device, because that is the
  machine an operator can identify and a replacement may have no row yet.
- Unique index `user_devices_one_server_per_branch` is the guarantee, not the
  intention. Handover clears the incumbent FIRST, so an interruption leaves the
  branch with NO confirmed server rather than two.

**Nothing here affects selling.** A refused machine still trades, still syncs,
still serves its own tills over the LAN with the branch secret. The only thing
withheld is the branch roster.

**Partly closes A22** (split brain): two machines claiming to serve one branch is
now detected and recorded — `role_conflict_at`, `role_conflict_with` — rather
than being silent. The node still does not warn on startup, so A22 stays open.

23 tests in `tests/device-role-confirmation.test.mjs`, mutation-checked.

### A29 · P1 · CLOSED 08-10 · `build-schema-index.mjs --merge-migrations` adds phantom columns
Found because migrations 73/74 tripped `schema-audit`, correctly: the new
columns were not in `scripts/schema-index.json`. The sanctioned unstick path is
`--merge-migrations`, and it **added six columns that do not exist in the live
database**, verified against the owner's 08-09 dump:

```
category_stations.business_id        parking_sessions.billed_amount
fuel_tanks.product_id                parking_sessions.cashier_id
fuel_tanks.tank_name                 parking_sessions.notes
```

Each was created by an early migration and renamed by a later one — `fuel_tanks`
has `fuel_product_id` and `name`, not `product_id` and `tank_name`. The tool
documents *"never removes"* as a safety property, and for removals it is; but it
also cannot know a column was renamed, so it resurrects dead names.

**That WEAKENS the gate.** Code selecting `fuel_tanks.product_id` would now pass
the audit and fail at runtime — the precise failure the index exists to catch,
reintroduced by the tool meant to maintain it.

The six were removed by hand against the live dump; only the eight columns from
73/74 remain. Verified semantically, not by diff: 98 tables before and after,
nothing lost, `total: 0`.

**Fix not yet applied to the tool.** It should either skip columns dropped or
renamed by a later migration, or print them as *unverified additions* for a human
to confirm. Until then, **`--merge-migrations` output must be diffed against the
live schema before it is committed**, and `--from-db` re-run when the database is
reachable. Consider this a standing caveat on that script.

### A30 · P1 · CLOSED 08-10 · Migration 74 failed on the owner's database — SQL nobody had run
```
ERROR: 42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
```

`CREATE OR REPLACE VIEW` may only **APPEND** columns: existing ones keep their
names, types and positions. Migration 74 inserted four columns before migration
73's trailing `is_view_only`, so position 16 changed name and Postgres refused.

**This reached the owner because "the DDL is unexecuted" was written down as a
caveat instead of being fixed.** Listing a risk is not managing it. Both
migrations now `DROP VIEW IF EXISTS` then `CREATE VIEW` — not `CASCADE`, so a
future dependency fails loudly rather than being quietly deleted.

**A second bug, found only by executing:** re-running 73 after 74 failed with
*"cannot drop columns from view"*, because replace cannot drop columns either.
Every migration here is written to be re-runnable — only 20 of 66 record
themselves (A4), so re-running to be sure is normal practice — and a view that
can be created once breaks that. Neither bug was findable by reading.

**Root fix — migrations now run against a real Postgres.**
`apps/server/test/migration-73-74.test.mjs` executes them under PGlite (Postgres
compiled to WASM: real parser, real planner, real DDL semantics, in-process, no
server to install), and it is **in CI**. 17 tests covering: both apply; both are
recorded; re-running both is idempotent; the CHECK accepts till/node/office and
rejects anything else while allowing NULL; the unique index refuses a second
confirmed server per branch, including an office machine; **clear-then-set is
proved to be the only order the index permits**, which is the handover sequence
`deviceRole.ts` reasons about; the view exposes both derived booleans and
excludes plain tills.

Documented consequence, tested rather than assumed: 73 owns the smaller view
definition, so running it **alone** after 74 reverts the view. Re-running 74
restores it. Run migrations in order.

**The wider lesson is the reusable part.** Any migration can now be executed in
CI before it reaches a database. The five earlier migrations in this batch's
lineage were never run either; they should be brought under the same harness.

### A31 · P1 · CLOSED 08-10 · A new desktop suite was written and never wired in
`failover-cursors.test.mjs` (A21) was added to `apps/desktop/test/` and **not
added to `npm run test:desktop`**. The owner's target run on 2026-08-10 executed
92 tests across five suites under `better-sqlite3 under Electron 35.7.5 — REAL
driver and ABI`, and the sixth was silently absent.

This is A16 repeated **in the same batch that closed A16.** A file in a test
directory is not a test; a test that nothing invokes is decoration (rule 10).

Now `test:failover` and `test:failover:electron` exist, matching how every other
suite is wired, and `test:desktop` runs the Electron variant. Also added to CI's
`desktop-scope` job, where it runs on the `node:sqlite` stand-in — which the
suite declares in its own output rather than implying a real green.

**The general lesson:** the same mistake is available every time a suite is
added. `check-ipc-parity` exists because a feature reached every layer except the
bridge; the equivalent gate here would assert that every `apps/desktop/test/*.test.mjs`
appears in a package script. Not built — recorded as the obvious next hardening.

### A9 · RESOLVED 08-10 — `npm audit`, split by workspace
The register carried "23 vulnerabilities, 3 critical — probably build-chain only"
as an unverified guess. Measured on both sides:

- **`apps/server`: 6 vulnerabilities, 0 critical, 3 high.** The guess was wrong
  for the server in both directions, and `nodemailer` is a **direct runtime**
  dependency, not build-chain.
- **`apps/desktop`: 23 vulnerabilities, 2 moderate, 18 high, 3 critical** —
  confirmed on the owner's machine 08-10. The 23/3 figure was the desktop
  workspace all along.

Desktop dependencies are build- and packaging-time (electron-builder and its
tree) rather than reachable from a running till, so the practical exposure is
lower than the number suggests — but that is an argument for triaging them, not
for leaving the number unexamined. Triage still open; the measurement is not.

### A32 · P1 · CLOSED 08-10 · Six migration tests existed, none ran, one had never worked
Found while fixing a Windows path bug in my own harness. **This repository has
tested migrations against PGlite since migration 41** — `scripts/test-migration-47,
-48, -50, -51, -52` and `test-migrations-41-42` — same pattern, same
`fileURLToPath`, same `--no-save` instruction.

**None of them ran in CI**, and the consequences were exactly what a test nothing
invokes always costs:

- **`test-migration-47.mjs` pointed at `/home/claude/out4/migrations/…`** — an
  absolute path from the sandbox it was written in. It has never run anywhere
  else since the day it was committed. **19 assertions, none ever executed.**
  Path fixed; 19/19 pass.
- **Migration 74 shipped a `CREATE OR REPLACE VIEW` Postgres refuses (A30)** and
  reached the owner's database. The practice to catch it existed; nothing made
  it habitual.

`scripts/run-migration-tests.mjs` now **discovers** `test-migration*.mjs` rather
than listing them — a hand-kept list is one more thing to forget, which is the
failure being fixed — runs each in its own process, and reports every failure
rather than stopping at the first. `npm run test:migrations` at the root, in CI.
**7 files, 110 assertions, all green — confirmed on the owner's Windows machine
2026-08-10.**

The runner reads both summary conventions in this directory (`N passed, N failed`
and `test-migrations-41-42`'s `PASS`/`all green`), because a blank summary is
indistinguishable from a file that asserted nothing — and after 47, "looks like
it did nothing" is not a reassuring thing for a runner to show. Exit status, not
the summary, decides pass or fail; verified by running a deliberately failing
file through it (`1 of 8 migration test file(s) failed`, exit 1).

`@electric-sql/pglite` is a root devDependency, so `npm install` provides it and
the `--no-save` step in six file headers stops being load-bearing.

**My own error, recorded because it is the same one:** I wrote a new harness at
`apps/server/test/` without checking whether the practice already existed — a
rule 17 miss in the batch that added rule 17 — and claimed migrations "now" run
against real Postgres when they had since migration 41. Moved to `scripts/` and
renamed to match.

### A33 · P2 · CLOSED 08-10 · `new URL(import.meta.url).pathname` breaks on Windows
My migration harness resolved paths with `new URL(import.meta.url).pathname`,
which yields `/C:/swiftpos/…` on Windows; `path.resolve` then prepends the drive,
producing `C:\C:\swiftpos\…` and 17 failures on the owner's machine. Correct
on Linux, the only place it had run.

Every other script in this repository already used `fileURLToPath`. Mine was the
sole deviation — the convention was right and I did not follow it.

Fixed, plus the harness now **fails immediately with the resolved path** when the
migrations directory is missing. Without that, a path bug presents as every
assertion failing for its own apparent reason — missing columns, empty views —
and the real cause is buried in the noise, which is precisely what the owner saw.

**CONFIRMED ON TARGET 08-10** — all 7 files pass on the owner's Windows machine.
This could not be proved from Linux (`fileURLToPath` is platform-dependent), and
it is the second time in one day that only the target could settle a claim.

### A34 · P1 · CLOSED 08-10 · CI #42 red — desktop suites added without the build they need
```
Run node --no-warnings test/logFile.test.mjs
dist/main not built. Run:  npx tsc -b tsconfig.main.json --force
```

`logFile`, `syncEngine-failures` and `failover-cursors` import from
`apps/desktop/dist/main`. `npm run test:desktop` builds first — which is exactly
why they pass on the target and failed on the runner. **I added the CI steps and
not the build**, and could not have found it locally, because locally the build
had already happened.

The `desktop-scope` job installed only `better-sqlite3` at the repo root, which
is all the `scripts/*.mjs` gates need. Three steps added:

- `npm ci --ignore-scripts` in **shared/printing** — it is a project reference of
  `tsconfig.main.json` and declares `"types": ["node"]`, so without its own
  `node_modules` the build fails on a missing type definition. Non-obvious, and
  it cost a cycle to find the first time.
- `npm ci --ignore-scripts` in **apps/desktop** with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — the Electron binary is ~100MB and nothing
  in this job launches it.
- `npx tsc -b tsconfig.main.json --force`.

**Verified against a genuinely clean checkout**, not the working tree: extracted
`git archive HEAD` to a fresh directory with no `node_modules`, ran the three
steps in order, then all three suites — 12, 29 and 12 passed. That is the closest
reproduction of a runner available here.

The other five jobs — typecheck, build, secret scan, schema drift and **server
suites, including the 7 migration files** — were green on the same run. Only this
one failed.

**The general point:** CI is the first environment in this project that starts
from nothing. Everything local benefits from state built up by hand, and A32
(six migration tests never run) and A31 (a suite never wired in) were both
invisible for the same reason. Expect more of this on the next few runs; each
one is a real gap, not noise.

### A35 · P1 · CLOSED 08-10 · The secret scan never ran on a pull request
CI #44, PR #2 (`dev → main`):

```
RequestError [HttpError]: Resource not accessible by integration
  GET .../repos/oweyahillary/swiftpos/pulls/2/commits   403
  x-accepted-github-permissions: pull_requests=read
```

`gitleaks-action` lists the PR's commits through the API on a `pull_request`
event. The workflow declared **no `permissions` block at all**, so it inherited
the repository default — `contents`, `metadata`, `packages`, all read — and the
action crashed **before scanning anything**.

**Every earlier run was a `push` event, where the API is never touched.** So this
gate had been passing for a reason that did not hold on the one event type that
gates a merge to `main`. It looked like 40-odd green runs of a working secret
scan; on the path that matters it had never been exercised.

`permissions: { contents: read, pull-requests: read }`, scoped to that job —
nothing else here calls the API, and a read-only default is worth keeping
everywhere it still works.

**Second finding, from the same failure.** The job's steps ran gitleaks FIRST and
the `.env` assertion second, so when gitleaks crashed the job stopped and **both
secret gates were skipped by one infrastructure fault.** The `.env` check needs
no action, no API and no network. It now runs first, so it cannot be taken out by
something unrelated failing.

Context for why this matters more than a red tick: A1 was a service-role key
leaked in a packaged zip on 2026-08-08, and the repo leaked an Ed25519 signing
key before that. These two steps are what stand between that and a repeat.

**The general shape, third time today:** a check that passes for the wrong
reason. `test-migration-47` had never run (A32), `failover-cursors` was never
invoked (A31), and now a secret scan that had never scanned a PR. All three
looked like coverage.

### A36 · **P0** · CLOSED 08-10 · `/desktop-login` minted `surface: 'web'` — four features silently dead
The one-word bug behind everything chased today.

`routes/auth.ts` `/desktop-login` set `surface: 'web'` in its token payload. **The
header of that same file has said `surface='desktop'` since the route was
written.** The comment and the code disagreed for months and nothing compared
them.

It propagates: `/verify-pin` issues `surface: req.surface ?? 'web'`, so the
owner token's value flows into every staff token minted from it. On every till
that signed in through that route, four things were false and therefore silent:

1. **`offlineAuth` (`auth.ts:1356`) is gated on `surface === 'desktop'`.** The
   PIN hash was never returned, so `staff_pin_cache` stayed EMPTY. **The entire
   offline sign-in feature — D16, shipped 2026-08-08 with 16 passing pinCache
   tests — has never worked in the field.** Measured on Beryl's till 2026-08-10:
   manager and cashier PINs entered ONLINE, then
   `select count(*) from staff_pin_cache` → **0**.
2. **Desktop terminal registration (D14) never ran.** `user_devices` was empty
   for all ten businesses, which kept migration 52's branch binding and every
   telemetry column inert. This is the *real* reason the fleet was empty — the
   `require_device_registration` flag was a second, independent cause.
3. **The `desktop_licensed` gate never fired** for those tills (`pos.ts:87`,
   `auth.ts:1174`). A till signing in this way traded unlicensed.
4. **`requireWebSurface` was bypassed**, so a till could reach web-portal-only
   routes.

**Why nothing caught it.** `/pos-login` derives surface from the request body and
CAN be `'desktop'` — so the fixtures, and the real `BRANCH_NOT_LICENSED` errors
seen in the field, both looked right. Two login routes, two different answers,
and the tests exercised the correct one.

**Deploy safety, checked before shipping:** the till never calls `/api/reports*`,
so activating `requireWebSurface` changes nothing; and Beryl's Main Branch has
`desktop_licensed = true` since 2026-07-25, so the licence gate will pass. **On
an unlicensed branch this fix stops the catalogue pull with a 403** — check
before deploying anywhere else.

`tests/auth-surface.test.mjs`, 10 tests, mutation-checked. It is a source-text
test on purpose: the bug was one word in a literal, and a unit test asserting
`payload.surface === 'desktop'` against a stub would only prove the stub. It also
asserts the header and the code agree, which is the specific thing that failed.

### A37 · P2 · OPEN · The desktop licence is bypassable by client-supplied `surface`
`/pos-login` reads `surface` from the request body (`auth.ts:925`) and gates the
licence on it (`:1062` — `callerSurface !== 'web' && !allowed.desktop_licensed`).
A client that sends `surface: 'web'` skips the desktop licence check, and
`pos.ts:87` then also passes because it tests the same value.

A commercial control decided by client input. **Not changed here** — the
legitimate web POS uses this path, and closing it without breaking that is its
own piece of work. `tests/auth-surface.test.mjs` §4 pins the current shape so a
change forces this to be revisited.

### A38 · **P1** · CLOSED 08-10 · The till sent `X-Device-Id` twice — every reader got a comma-joined value
Found in Render's logs while chasing A36, and it is the SECOND independent cause
of the empty fleet:

```
[fleet] no user_devices row for device
  24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
```

`syncEngine.pushAuthHeaders()` declared **both** `'x-device-id'` and
`'X-Device-Id'` in one object literal. HTTP header names are case-insensitive,
so fetch emitted the pair and the server received them joined with `", "`. The
reader then did `.slice(0, 64)` on the JOINED string, chopping the second copy
mid-uuid — which is the trailing fragment in that log line.

**Four places consumed it:**
- fleet telemetry — `WHERE device_id = ?` could never match, so this would have
  stayed broken even after registration started creating rows
- `orders.device_id`
- `shifts.device_id`
- `terminalKeyFromRequest`, which feeds migration 63's one-open-drawer-per-terminal
  unique index

**The rollout risk, and why the server fix matters more than the client one.**
An updated till sending a single value would resolve to a DIFFERENT terminal key
than the shift it opened under the joined value — looking like a new terminal and
being allowed a second open drawer against the same physical till. New
`deviceIdFromRequest()` in `lib/terminalKey.ts` takes the first comma-separated
value, so an old build and a new one resolve identically and the change is
invisible to that index. `orders.ts`, `shifts.ts` and `sync.ts` all route through
it.

Client side: one spelling in both header builders. They previously disagreed —
`'x-device-id'` in `authHeaders`, `'X-Device-Id'` in `pushAuthHeaders` — which is
how a copy-paste put both into one object.

`tests/device-id-header.test.mjs`, 10 tests, mutation-checked both halves
(removing the split → exit 1; restoring the duplicate key → exit 1). It asserts
against **the exact string Render logged**, not a value typed into the test.

**Worth stating plainly:** the empty `user_devices` table had THREE independent
causes — the `require_device_registration` opt-in (D14), `surface: 'web'` (A36),
and this. Fixing any one alone would have produced no visible change, which is
why the first two fixes appeared to do nothing.

### A39 · **P1** · CLOSED 08-10 · The design six files cite was not in the repository
`BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` is cited **by section** in six source files
— `cart.ts:39`, `managerReports.ts:405`, `localDb.ts:920`, `branch-prices.ts:20`,
`pos.ts:17`, `orders.ts:176` — and was **not in the repo or its git history.**
Supplied by the owner from a different folder on 2026-08-10; now in `docs/`.

Worse than a missing file: the citations make it look present. Anyone working
from a clone reads *"See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6"* and finds
nothing, so the reasoning behind `branch_prices`, the effective-price COALESCE
and the `updated_by` stamp is invisible.

**And it is the design for most of what this register has been rediscovering all
week.** Its status line reads *"agreed design, not yet implemented"*:

| Register finding | Already specified as |
|---|---|
| A19 — a peer's sales never reach the cloud | §1, §3 — the node is the sole uplink |
| A24 — reference data goes stale on a peer | §1 — "edits flow DOWN: Manager PC → tills" |
| PHASE5 §4 — offline sign-in | §2 — "PIN login must also be local", tills cache a verifier via safeStorage |
| PHASE6 — branch-local settings | §1 — the branch authority owns reference data |
| Two-writer resolution | §5 — newest-wins, collision-only notify, confirm/reject, audit |

`syncEngine.ts:1138-1151` records a deliberate move AWAY from §1 and §3, with a
sound engineering reason and no apparent knowledge that a design said otherwise —
which is what an untracked specification produces.

**Partially implemented already:** §6's per-branch pricing decision (
`branch_prices`, migration 20), and §5's stamping (`branch-prices.ts:97` —
`updated_by='pc'`, the edit's own timestamp so an offline edit keeps its real
time). §2's PIN caching exists as `pinCache.ts` but caches from the **cloud**
rather than from the node, and did not work at all until A36 was fixed today.

**Rule 19 covers the repo root; this is the converse** — a document that should
be in `docs/` and was nowhere.

**GATE BUILT 08-10** — `scripts/check-doc-refs.mjs`, in CI. Every `Something.md`
cited from live code or live docs must resolve to a file in the tree. It found
more than a manual grep did, and **three of the owner's own documents are still
missing**:

| Missing | Cited by |
|---|---|
| `DESKTOP_DESIGN.md` | `migrations/18_web_access_remodel.sql:4`, and **BRANCH_AUTHORITY itself at :3, :28, :157** — it is the companion that defines the `node` role and steps 5-6 of the build sequence |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `etims/provider.ts:4`, citing **§2** |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |

`DESKTOP_DESIGN.md` matters most: PHASE6 is to be built against BRANCH_AUTHORITY,
which opens by calling itself *"Companion to DESKTOP_DESIGN.md"* and widens the
node role *"from DESKTOP_DESIGN.md"*. **Building PHASE6 without it means building
against half a specification.**

`docs/history/` is deliberately excluded from the citation scan — a past handoff
naming a since-deleted document is an accurate record, not a broken link — but
documents living there still count as PRESENT, so a live doc pointing at an
archived handoff passes.

**The gate is RED until those three land.** That is the correct state: it is
reporting a real gap, not a false alarm.

### A40 · P1 · CLOSED 08-10 · `DESKTOP_DESIGN.md` is lost — recorded, not reconstructed
Searched the repository, its full history (`--diff-filter=D`) and the owner's
local folders. **Gone.** Eleven citations survive.

`docs/DESKTOP_DESIGN.md` now states plainly that the original is lost and maps
each surviving citation to the code that implements it. **Nothing is invented** —
a plausible reconstruction would be worse than an honest gap, because the next
reader could not tell which parts were real.

What the citations preserve, and where it lives:

| Cited | Now |
|---|---|
| "the two-products model" (`migration 18:4`) | `branches.desktop_licensed` + `businesses.web_access_expires_at`; `lib/webAccess.ts` carries the whole renewal ladder |
| "the `node` role" (BRANCH_AUTHORITY:28) | `deviceConfig.ts:26` — and wider now, `'till' \| 'node' \| 'office'` |
| "steps 5-6 of the build sequence" (BRANCH_AUTHORITY:157) | **Diverged.** `syncEngine.ts:1138-1151` moved away from the sole-uplink model deliberately, with no sign of knowing a design said otherwise. Register A19, still open. |

Genuinely gone: the reasoning behind the two-products split, the full build
sequence, and whatever else it covered. **PHASE6 is unblocked** — the parts it
depends on are implemented and readable.

Still missing and worth finding: `BRANCH-SERVER-PLAN.md`,
`SwiftPOS_eTIMS_Integration_Scope.md`.

### A41 · P1 · CLOSED 08-10 · Two gates for the seam that produced everything this week
§L: *"two things that must agree, with nothing comparing them."* Every finding
this week was that shape. Two more comparators, both in CI:

**`check-header-keys.mjs`** — no object literal declares one header under two
spellings (A38). Mutation-checked.

**Its own first version silently missed the bug it was written for.** The
literal-matching regex refused nested braces, so any headers bag containing
`` `Bearer ${token}` `` was skipped — which is every one that matters. It scanned
23 literals, reported OK, and passed a mutation test by not looking. Now
interpolations are blanked (length-preserving, so line numbers stay true) and it
catches A38 at the exact file and line. **A gate that cannot fail is the thing it
was built to prevent.**

**`check-test-registration.mjs`** — every test file is invoked by a package
script, a CI step, or a discovering runner (A31, A32). Mutation-checked by
unwiring `test:failover:electron`.

**Its first version reported 22 false positives** — files a CI shell glob
(`for f in tests/*.test.mjs`) runs perfectly well. Fixed before shipping, because
a gate that cries wolf gets switched off, which is worse than no gate.

**Still no gate for the seam §L names as widest:** an IPC channel whose two sides
disagree about the *payload shape*. `check-ipc-parity` proves a channel exists,
not that its arguments agree. P-09 and P-11 both came through it. Next.

### D8 · P1 · CLOSED 08-10 · Dispatch slips could print on neither system — and the HTML sale path is gone
Thermal ran a full service on 2026-08-10 with **all ticket types produced,
dispatch slips included**, which is the condition `POSPage.tsx:451` set for
itself: *"The old path is NOT deleted. It is the fallback, and it stays until a
real service has gone through the thermal one on this hardware."*

**0.5.27 removes the HTML SALE path only.** The rule 17 sweep found the naive
"delete four modules" would have taken three things with it:

- **Shift and Z-reports.** `escposBridge` exports exactly one print function,
  `printSale`. There is no thermal shift report. `printShiftReport.ts` is
  untouched and `ShiftPanel`/`ManagerPage` still use it.
- **Printer calibration.** `buildCalibrationTicket` is how paper width is
  detected. No thermal equivalent.
- **Test prints and previews.** `PrintersTab` uses `printKOT` and
  `printDispatcher` for sample tickets and on-screen previews.

So `printKOT`, `printDispatcher` and `printReceipt` all remain. What went is the
duplicated live-sale branch in `POSPage` — 76 lines — and the early return that
was D8 itself.

**D8 is closed by reporting, not by routing around it.** `printSale` has always
returned `{ queued, skipped }` and every caller discarded `skipped`, so a station
with no printer bound was skipped in silence. It now reaches the renderer and
the cashier is told *"nothing printed for: Dispatch"*. With no fallback there is
no second system to catch it, so silence was no longer survivable.

**`escpos_enabled` now defaults ON** (`localDb.ts`). It defaulted OFF while HTML
was the fallback — correct then, dangerous now: OFF no longer means "print the
old way", it means print nothing. A guarded one-time backfill in
`maintenance_state` flips tills that hold 0, and **does not override a manager
who later turns it off deliberately** — verified against a real SQLite database,
not reasoned about.

**The `localStorage` exclusion list is retired.** The Printers tab previewed and
test-printed from a per-till localStorage copy while the printer used the
server-synced list — two lists on one screen, silently disagreeing. New
`escpos:kitchenExclusions` IPC exposes what the printer actually applies; the box
is now **read-only and shows the live value**, and says where it is edited. A
control that looks editable and changes nothing is worse than no control.

**Not done, and deliberately:** a thermal shift report. That is new code, not
removal, and deleting the HTML one would have left the manager screen with
nothing. Its own release.

### A42 · P1 · CLOSED 08-10 · The thermal toggle's OFF label reassured while nothing printed
`PrinterSetupScreen.tsx:169` read *"Off. Sales still print the old way; nothing
on this screen affects them yet."* True while the HTML fallback existed. **From
0.5.27 it is false: OFF means nothing prints at all** — no kitchen ticket, no
dispatch slip, no receipt.

Now *"OFF — nothing will print. Turn this on before trading."* in amber. Found
because the owner unticked it on a live till and the screen said everything was
fine.

The 0.5.27 backfill is confirmed working on real hardware: marker row
`escpos_default_on_0527 = applied` at 12:49:43, column set to 1, and it correctly
did **not** override the owner's later deliberate untick — the property verified
against SQLite before shipping.

### A43 · P1 · OPEN · Exclusions were built on a screen that is not rendered
`PrintersTab.tsx` was superseded by `screens/PrinterSetupScreen.tsx`.
`ManagerPage.tsx:1116` says so in a comment: *"PrinterSetupScreen supersedes
PrintersTab… PrintersTab.tsx remains in the tree"* until thermal is proven.

0.5.27's read-only exclusions box, the live-list preview and the
`escpos:kitchenExclusions` wiring all went into `PrintersTab`. **None of it is
reachable.** A rule 17 failure of the exact shape the rule names: the file
existed, and I never checked that it renders.

The IPC channel and the main-process half ARE live and correct — only the
renderer half is orphaned.

**Deliberately not ported across.** `PrinterSetupScreen` is station-oriented —
stations left, the selected station's settings centre — which is the natural home
for **per-station** exclusions (PHASE6 §4, `print_stations.exclude_terms`) rather
than a global card bolted onto a per-station layout. Exclusions stay on the web
dashboard until PHASE6.

**Thermal is now proven, so `PrintersTab.tsx` can be deleted** — the condition its
retention was gated on has been met. Not done here: it still serves nothing, and
deleting it is a separate, clean change.

### A44 · P2 · CLOSED 08-10 · Adding a station — already built, and it anticipated this
Owner asked for a "Barista" station. `dashboard/pages/settings/StationsPage.tsx`
has create, edit, delete and category routing; `routes/stations.ts` has
POST/PATCH/DELETE behind `products.manage`. The page's header comment reads *"A
client wanting a 'Barista' station tomorrow meant a code change"* and the New
station placeholder is literally **"Barista"**.

`kind` is constrained to `kitchen | dispatch | receipt` (migration 44). A Barista
station is a new station NAMED Barista with kind `kitchen` — kind decides
behaviour and ticket layout, the name is what staff call it. It reaches the till
on the next catalogue sync, where a printer is bound to it.

**Nothing to build for the DASHBOARD.** But the desktop cannot create stations,
and that matters: a branch at `locked` cannot open the portal, so it could not
add a station at all — a shop building a coffee counter would have to renew a
*web* subscription to tell its own till about it.

**Folded into PHASE6 §8c** (owner, 08-10): station create/edit becomes
manager-editable at the branch under `products.manage`, no internet required,
**not** behind the tech screen — tech access needs a reveal code and a signed
token from the same portal that is locked, which would route around a closed door
with a key kept behind it.

Backed up and visible to head office, per the owner: node authoritative, cloud
the durable copy, dashboard reads it, *"so the owner can tell what is happening on
the ground."* `print_stations` already syncs DOWNWARD to the till; the missing
half is the write path and the upward sync — the same `/node/settings` channel
per-station exclusions need, so building them apart would mean building that sync
twice.

### A45 · P1 · OPEN · The Receipt tab is shown to a manager the server then refuses
Observed on a live till 2026-08-10: a manager opens Receipt, edits the branch
address and phone, presses Save, and gets **"Your role does not allow this
change."**

Two gates for one action, disagreeing:

- `ManagerPage.tsx:1083` — the tab is listed `...(isManagerRole ? [...] : [])`
- `business.ts:110` — the write needs `requirePermission('settings.manage')`

**§L's seam again, this time in permissions.** The UI promises what the server
refuses, and nothing compares them. The user finds out after typing.

Immediate unblock: grant the role `settings.manage` on the dashboard, or edit as
the owner. **Both are worse than they sound — see A46.**

Proper fix is PHASE6 §7, which already separates branch-operational settings from
business-identity ones. The screenshot makes the case: the header read
`Juja B Branch / 018202083` — a BRANCH address and phone, exactly the
manager-editable, branch-local content §2 argues for. The KRA PIN line is the
part that is business identity and stays owner-only.

Whatever the split, **the tab's gate must read the same key the server enforces.**
A source-text gate asserting that every permission-gated route has a UI gate
naming the same permission would catch this class — the fourth comparator, after
`check-ipc-parity`, `check-header-keys` and `check-doc-refs`.

### A46 · **P1** · OPEN · One permission gates sixteen routes with wildly different blast radii
Owner, 08-10: *"split these roles into fine small roles that would not affect
operations… rather than having one role once implemented a whole section is
affected."* Correct, and the measurement supports it.

**`settings.manage` gates 16 routes across 6 files:**

| Route | What it grants |
|---|---|
| `business/settings` | Receipt text — **and** loyalty rate, service charge, turnover alerts, every flag in `READABLE_SETTING_KEYS` |
| `devices/:id/approve` · `reject` · `delete` | Approve or **revoke a terminal** |
| `devices/:id/authorise-handover` | Hand the branch-server role to another machine (migration 74) |
| `etims/config` · `branches/:id/register` | **KRA fiscal device registration** |
| `flags/:key` | Feature flags |
| `shifts/:id/force-close` | Close a drawer with no count — the cash-variance path |
| `tables/*` | Create and delete tables |

**To let a manager type a branch phone number you must also grant eTIMS
registration and the power to revoke a till.** That is not a permissions model;
it is one switch.

`products.manage` is worse by volume — **29 routes** — and includes station
create/delete, which PHASE6 §8c moves to the branch.

**Proposed split** (names follow the existing `noun.verb` convention):

| New key | Takes over |
|---|---|
| `receipt.manage` | `business/settings` for `receipt_header`, `receipt_footer` |
| `stations.manage` | `print_stations` create/edit/delete, per-station exclusions (PHASE6 §8c) |
| `devices.approve` | approve / reject / delete / authorise-handover |
| `etims.manage` | eTIMS config and registration — owner-only in practice |
| `tables.manage` | `tables/*` |
| `shifts.force_close` | the no-count close, audited |
| `settings.manage` | **retained** for what is left: flags and business-wide settings |

Every key is additive: a role holding `settings.manage` today keeps everything it
has, and the new keys are what a MANAGER role gets granted. `permissions` and
`role_permissions` already exist (migration 00), `permissions_version` already
forces token refresh on change, and migration 59 already backfills defaults — so
the machinery is there. This is seeding rows and re-pointing gates, not new
infrastructure.

**Not started.** It touches 45 route gates and every UI gate that mirrors them,
and it needs the A45 comparator built first or the two will drift again while
being changed. Sequence: comparator → split → re-point UI gates.

### A24 · P1 · OPEN · Reference data goes permanently stale on an offline peer

**FIRST PAYLOAD DESIGNED 08-10** — `docs/PHASE6-BRANCH-SETTINGS.md`. Printer
settings rather than the staff roster, deliberately: if downstream distribution
misbehaves, a ticket prints an item it should not (visible, harmless), where the
same failure with credentials means someone signs in who should not. Also
uncovered that `business_settings` has **no `branch_id`**, so a two-branch
business changing exclusions for one branch changes both — and that there are
**two** exclusion mechanisms, cloud-backed and per-till `localStorage`, feeding
the two print paths from different sources.
The unifying finding. `REPLICATED_TABLES` is `orders, shifts, float_transactions,
expenses, business_days, events` — **all sales-side**. Everything a till READS
still comes from the cloud: `syncEngine:476` pulls the catalogue from
`/api/pos/init` and `:581` pulls staff from `/api/staff`, both against
`_serverUrl`. `nodeClient` pulls only `/node/since`.

**The node replicates sales upward and sideways; nothing flows downward through
it.** A17 (auth), A20 (roster for failover) and this are three symptoms of that
one sentence, not three findings.

Consequence at a remote site: a price change reaches the node when *it* has
internet and never reaches the tills; a cashier hired at HQ can never sign in on
a peer; receipt text and kitchen exclusions never update. Two tills at one branch
can quietly sell the same item at different prices — the class `branch_prices`
and `local_price_edits` exist to control.

**Fix:** extend `collectDistribution` downstream to carry `users` and the
catalogue tables. That closes A17, A20 and A24 together and is an extension of an
existing mechanism rather than a new one. See `PHASE5-NODE-AUTHORITY.md` §11.

### CORRECTION 08-09 — the register under-credits what is built
Owner's push-back, checked and upheld. Verified present and sound: bidirectional
branch replication with cursors; orders replicating COMPLETE with `_items` and
`_payments`; promotion and demotion, session-gated, audited and probe-before-save;
`emitEvent` with `EVENT_WHITELIST` as an explicit security boundary; Phase 4
central day close with instructions and acks; the staff sync pipe; `can_authorize`
and `/api/staff/authorizers`; order idempotency end to end.

**PHASE5 §§3-5 over-specified as a result** — in particular it proposed a new
`branch_staff` table when the local `users` table already exists and is already
synced. Superseded by §11.4: add columns to `users`, one flag on `shapeStaff`,
one `/node/verify-pin` route, and extend distribution. Items 6, 7 and 9 there are
a handful of lines each.

### A2 · P1 · CLOSED 08-09 · BUG-17 — mpesa `.single()`
Both sites fixed. `:224` raised PGRST116 on a refunded order (two mpesa legs —
migration 37 keeps both rows) and told the cashier "No M-Pesa payment leg found"
for an order that had one. Now reads all legs, picks the `pending` one, and
distinguishes "already completed" (409) from "nothing to collect" (404).

`:372` was worse and was not in the original finding: the callback destructured
**only `data`**, so any lookup failure produced `payment === undefined`, logged
"unknown checkout", and returned. **A payment M-Pesa had already collected was
dropped, and the log said the checkout did not exist.** Now `maybeSingle` shape
with an explicit error branch that says the payment was NOT recorded and needs
reconciling against the Daraja statement, plus a loud error if two rows ever
share a checkout id.

### A14 · P0 · CLOSED 08-09 · Owner token can carry an `auth.users` id
**This is the Beryl root cause.** `auth.ts` resolved the owner's `public.users`
row with `.eq('email', data.user.email)` — a **case-sensitive** match against a
column holding whatever was typed at signup, while Supabase Auth lowercases. On
a miss both `/login` and `/desktop-login` fall back to `data.user.id`, which is
an **`auth.users`** id, and mint a token carrying it as `userId`.

`orders.cashier_id` is `REFERENCES public.users(id)` (confirmed in the live
dump), and `orders.ts` writes `cashier_id: req.userId`. So the push fails
**23503** — which was neither 23505 nor 23514, so it fell to `throw createErr`
and became "Failed to create order (ref: …)".

It persists for a whole session because **`/refresh` reuses `cleanPayload.userId`
and never re-resolves it**, so one bad login poisons the entire 30-day refresh
chain until a fresh `/desktop-login`. That is the bounded 21:09–22:53 window.

`pos-login` already had the correct pattern from BUG-05 (escaped coarse `ilike`,
exact compare in JS). It was never applied to the two owner paths. Now shared as
`resolveOwnerUserRow()`.

**Login is deliberately NOT refused when the row is missing** — a release is in
flight and an owner who works today must still work tomorrow — but it now logs
an explicit error naming the consequence instead of failing silently.

**Still to confirm on production** (the deduction is from source, not from the
database): see §E.

### A15 · P1 · CLOSED 08-09 · Every order-create failure was one sentence
Anything that was not 23505 or 23514 became "Failed to create order (ref: …)" —
the same message for a bad foreign key, a malformed uuid and a dead database.
Extracted to `lib/orderErrors.ts` and classified: 23503 → 422
`ORDER_FK_VIOLATION`, 22P02/22007/22008 → 422 `ORDER_MALFORMED_VALUE`, 23502 →
422 `ORDER_MISSING_FIELD`. Unknown codes still rethrow, but the log now carries
the SQLSTATE — the one thing missing for three sessions.

Note `22007`: the RPC casts `created_at` with a bare
`NULLIF(...)::timestamptz`, and **only the offline path populates that field.**
Same shape as the `pump_id` bug migration 69 exists to fix.

### A16 · P0 · CLOSED 08-09 · No test in `tests/` had ever run in CI
All 18 offline suites — including `pay-claim-and-loyalty`, `tip-reconciliation`,
`atomic-order` and `stock-effects-parity`, i.e. **the money paths** — were
written one per incident, passed once on the author's machine, and were never
executed again. Nor were any of the 92 desktop tests added on 08-08.

New `server-suites` CI job runs all 18. The two Electron-free desktop suites
(`logFile`, `syncEngine-failures`) added to `desktop-scope`. The three SQLite
suites cannot run on a Linux runner by design (better-sqlite3 is built for
Electron's ABI) and stay a target-machine step; a comment in the workflow says
so, so the next person does not "fix" it.

### A3 · P1 · OPEN · BUG-21 — KDS realtime / RLS
Never re-verified. Still unknown, not known-good.

### A4 · P1 · OPEN · Migration 68 exists only in production
Applied to the live database, never committed to any branch. Confirmed absent
from git history. The repo cannot reproduce production.
**Blocked on:** `select version, applied_at from public.schema_migrations order by version;`

### A5 · P1 · OPEN · Docs understate the system by two phases
`ROADMAP.md` last touched 2026-07-10; no mention of Phase 2, Phase 4, Close
Branch, `/node/since`, events or the office role — all of which pass tests.
`PHASE2-3-DESIGN.md` still reads *"For approval before code."*

### A6 · P2 · OPEN · The 3-Aug handoff was never filed
Recoverable: `git show 0f85155:HANDOFF.md`. Commit `a4aee05` overwrote the path
with a different document. Nothing in `docs/` records the tech DB console or the
wipe gates.

### A7 · P2 · OPEN · `ParkingPOS` / `PetrolPOS` unrouted, no ROADMAP line
### A8 · P2 · OPEN · `SplitBillModal` unrouted while `PATCH /:id/split` is live
### A9 · P3 · OPEN · Empty `apps/desktop/src/renderer/{lib,pages,components}/`
### A10 · P3 · OPEN · `PrinterSetupScreen` docstring claims a supersession that has not happened
### A11 · P3 · OPEN · `ManagerPage.tsx:1061-65` comment contradicts itself
### A12 · P3 · INVESTIGATE · `ingredients.current_stock` vs `ingredient_stock_levels.current_stock`
Same duplicate-table shape as B6. Find who reads it before it becomes B6's sequel.

### A13 · P3 · NOTE · Two suites run on `node:sqlite`, not the app's driver
`test-node-ingest`, `test-sync-rejection-routing`. They say so themselves. A
local green is not hardware-equivalent.

**Pattern worth copying (08-08):** `test/heldOrders.test.mjs` selects
`better-sqlite3` when it resolves and falls back to `node:sqlite` only where the
native module cannot be built — then prints which driver ran. On any machine
that can run the app the real driver is used, so the green *is* hardware-
equivalent, and where it is not the output says so instead of implying otherwise.
**Confirmed on the target machine 08-08:** plain `node` cannot load the app's
`better-sqlite3` at all — `ERR_DLOPEN_FAILED`, built for `NODE_MODULE_VERSION`
133 (Electron 35) against the 115 that Node 20 requires. That is not a broken
checkout; `postinstall` runs `electron-builder install-app-deps`, which is
supposed to build for Electron's ABI. And `node:sqlite` needs Node >= 22.5 while
the tills run Node 20, so a suite that hard-imports it cannot run where it
matters either. **The only runtime that tests the real driver is Electron
itself:** `npm run test:held:electron` (see `test/run-under-electron.mjs`).
Verified green there: 21/21 on better-sqlite3 under Electron 35.7.5, Windows.

---

## D. OPEN — desktop app audit, 2026-08-08

Every item below was verified against source at `a80c224`, not against docs.

### D1 · P0 · Owner login is a dead end when they own two businesses
`auth.ts:603` — `/desktop-login` returns 409 `MULTIPLE_BUSINESSES` with *"Choose
which one to open."* `ipcHandlers.ts:83` throws `data.error` and drops `code`.
There is no picker anywhere in `apps/desktop`. The owner reads an instruction
the app gives no way to follow.
**Not firing for Beryl** — that owner has exactly one business (verified 08-08).
Closed by the D4 enrolment work, which removes owner login from the till.

### D2 · P0 · CLOSED 08-08 · Open tables lived in localStorage
See §E. Held orders now sit in SQLite, one row per tab. D9 (cross-till recall)
remains open — that needs server state, not local storage.

### D3 · P1 · No auto-update
No `electron-updater`, no `autoUpdater`. Every release is a hand-installed `.exe`
per till; `localDb.ts` says so itself. Root cause of A1 — no release pipeline is
why `pos.zip` gets hand-built from a working folder. Also the tax on every other
fix in this list.

### D4 · P1 · Owner portal credential used to provision the till
No device-scoped enrolment. Couples portal and till blast radius.
**Agreed design:** business ID identifies, a single-use enrolment code authorises.
Portal issues it; server burns it, writes the `user_devices` row and returns a
device-scoped token. Copy `routes/tech.ts` — that flow is already this shape.

### D5 · P1 · CLOSED 08-08 · Owner and staff tokens stored plaintext in SQLite
See §E. Wrapped at rest via `main/tokenStore.ts`; plaintext columns retained as
a fallback and never cleared until the wrapped value has been read back in the
same write.

### D6 · P2 · Local schema 46-51 undocumented
`localDb.ts` explains 43/44/45 in detail, then goes silent through 51. Six
generations with no record, on the mechanism deciding whether a field till works.

### D7 · P2 · 126 IPC channels, no shared payload validation
`check-ipc-parity` proves a channel exists, not that its two sides agree. This is
the gap §L already names, and what P-09 and P-11 were.

### D8 · P2 · Dispatch ticket can print nowhere
`POSPage.tsx:455` early-returns on `canPrint('kitchen')`, but the HTML path it
skips prints kitchen **and** dispatch. `escposBridge.ts:409` filters targets to
bound stations. Kitchen bound + dispatch unbound = the dispatch slip prints on
neither system, silently. Dormant while thermal is off.

### D9 · P3 · Held orders are not visible across tills
### D10 · P3 · `ipcHandlers.ts` at 1,639 lines
### D11 · P1 · `/api/pos/init` fails closed and kills the catalogue pull
`pos.ts:62-67` does `.single()` on `branches WHERE is_main` — zero rows errors,
and `one_main_branch_per_business` permits zero. `pos.ts:87` returns 403 on
`desktop_licensed`, which defaults false — **and resolves it from the `is_main`
branch, not the branch the till is bound to.** A till bound to branch B is
licensed by branch A's flag.
**Not the Beryl fault** — verified 08-08: one branch, `is_main` true,
`desktop_licensed` true. The licence-resolution bug stands regardless.

### D12 · P1 · CLOSED 08-08 · Inbound sync failures were entirely silent
See §E.

### D13 · P0 · PARTLY CLOSED 08-08 · Refresh rotation
Client side done — single-flight guard and stale-token retry, see §E.
**The crash window remains open** and cannot be closed from the client: the
server revokes the consumed token before the response is even sent, so any
interruption between there and the till's `UPDATE session` strands a dead token.
Only a server-side grace period fixes it — a briefly-superseded token returning
the current pair instead of a 401. That is the outstanding part of D13.

### D13 (original finding) · Refresh rotation with a non-atomic persist and no guard
`auth.ts:50-51` — access 15m, refresh 30d, **rotating**; `auth.ts:736` revokes
the consumed token before the desktop persists the new one at
`syncEngine.ts:117`. Killed between those points — crash, power cut, dropped
response — the till holds a revoked token and can never refresh. **The owner must
sign in again.** The window opens every ~15 minutes of trading.
Second path: `refreshAccessToken()` has no single-flight guard and is called from
the sync loop, IPC handlers and the PIN screen; concurrent callers present the
same token and the loser gets a 401.
**Fix:** single-flight mutex; on 401 re-read the token from SQLite once before
giving up; server-side, a short grace window returning the current pair.

### D14 · P2 · The till is not registered
`user_devices` has **no row for Beryl at all**. `sync.ts:71` is an `UPDATE`, not
an upsert, so telemetry writes nothing; `checkDeviceBranch` returns `ok:true` for
unknown devices, so migration 52's binding is inert. Consequence: no remote
visibility of `app_version` or `schema_version` — every diagnosis needs someone
physically at the machine.

### D15 · P3 · Two different tables named `sync_queue`
`public.sync_queue` in Postgres (`retry_count`, `table_name`) is **dead** —
no hit for `from('sync_queue')` anywhere in `apps/server` or `apps/dashboard`.
The live one is the till's SQLite table (`attempts`, `last_error`). Same name,
different columns, one of them a decoy. Drop or rename it.

---

## M. Migration ledger — reconciled against production, 2026-08-08

Source: `select version, applied_at from public.schema_migrations`, cross-checked
against the live schema dump. **`schema_migrations` under-reports** — several
migrations are demonstrably applied but have no row, so the log cannot be used to
decide what to run. That is worse than a known gap and is why 46 sat unapplied.

- **31 and 32** are recorded `SKIPPED`, "number never used". Resolved, not lost.
  **64 never existed.** The earlier concern about four missing numbers is one gap.
- **68 is real and prod-only.** `p_delta` → `p_points` on the loyalty RPC, applied
  2026-08-06 21:13. `CREATE OR REPLACE` cannot rename a parameter, so it needed a
  DROP. **Extract the live definition and commit it** — see §E.
- **66 is applied in production but filed under `archive/superseded`.** It is the
  live `create_order_atomic`, superseded only by 69's hotfix. 69 is a full
  redefinition, so the repo *can* rebuild the function.
- **71 is recorded as version `71`**; the file inserts `71_adjust_fuel_tank_level`.
  Re-running it creates a duplicate row.
- **Applied but unrecorded:** 57 (`onboarding_progress.owner_pin_set` exists),
  60 (`component_slots`, `order_item_units` etc. exist), and almost certainly
  53 and 61 (functions). 55/56/58 are recorded under legacy names.
- **Genuinely unapplied until 08-08: 46.** See §E.

---

## E. CLOSED 2026-08-08

| ID | What it was | Closed by |
|---|---|---|
| 46 | `payments_method_check` admitted only cash/mpesa/card/credit while `PaymentModal.tsx:49-57` offers Glovo on every till, unconditionally. The migration file predicted the symptom verbatim: *"the order fails to sync and sits in the queue with a constraint violation nobody can read from the till."* | Applied to production 08-08. Verified: `glovo` present in the constraint. **Was not the Beryl fault** — those payloads are cash. |
| D12 | Inbound sync failures were silent. `syncEngine.ts:328` was a bare `if (!res.ok) return false` — status and body discarded — on the **one** call that matters, while tables/pumps/stations all log properly. Compounding it, the desktop had **no durable logging at all**: every `console.warn` goes to a console that does not exist on a packaged build. | New `main/logFile.ts` (rolling, bounded, never throws). Catalogue pull and both token refreshes now record status + body. `getSyncStatus()` gains `pullError`, `pullErrorSince` and `logPath`, alongside the existing `failedReason`. |
| D2 | Held orders — restaurant tabs, with pre-assigned bill number and per-line kotSent flags — were one JSON blob in renderer `localStorage`, read through a catch that returned an empty list. A truncated write reported **zero open tables**, silently, with the KOTs already on the pass. | New `held_orders` table (one row per tab, so a bad row costs one table not all of them). Five IPC channels; the renderer API keeps its shape but is now async — 9 call sites and 5 functions in `POSPage.tsx`. **No `LOCAL_SCHEMA_VERSION` bump**: `CREATE TABLE IF NOT EXISTS` runs ungated on every open. A corrupt cart now returns the tab with an empty cart and a `corrupt` flag so it can be rebuilt from the KOT, rather than disappearing. One-time idempotent import of the legacy blob, and the old key is cleared only after the main process confirms it. Not cleared by `clearCatalogue()`. |
| D13 (client half) | Refresh tokens rotate and `auth.ts:736` revokes the consumed one, but `refreshAccessToken()` had no single-flight guard across three call sites (`ownerFetch`/PIN pad, the sync loop, the order push) and `refreshStaffToken()` none across four. Two concurrent refreshes present the same token; the loser gets a 401 for a token that was valid when it read it, and the owner is signed out. Offline that is unrecoverable — there is no way to sign back in. | Single-flight promise on both paths, so overlapping callers await one request. Plus a one-shot retry when a 401 arrives and the persisted token differs from the one sent — a stale in-memory copy is bookkeeping, not a revoked session. A genuinely revoked token is **not** retried. 10 new tests; mutation-checked by removing the guard and confirming they fail. |
| D16 (offline sign-in) | Everything on a till worked offline except the DOOR: `auth:verifyPin` called the server and threw, and the local `users` table carried no hash to check against, so a line fault stopped the floor starting a shift. | New `staff_pin_cache` table + `main/pinCache.ts`. Cached **only** for staff who signed in on this terminal while online, **only** bcrypt hashes (legacy upgrades on next online sign-in), **never** `override_pin_hash` — elevated actions stay online. Wrapped with safeStorage/DPAPI; nothing cached at all if the platform cannot wrap it. Expires after 14 days without server contact; cleared on logout. Offline verification scans all cached entries and refuses on two matches, same as the server. `bcryptjs` (pure JS) not `bcrypt` — a native module would hit the same ABI wall as better-sqlite3. Server returns the hash from `/api/auth/verify-pin` for `surface === 'desktop'` only. **The fallback fires on transport failure only, never on a 401/409** — otherwise a sacked cashier signs in by unplugging the cable. 16 tests. |
| D5 | `session.token` / `refresh_token` and the staff equivalents were plaintext in `swiftpos.db`. The refresh token is the durable one — 30 days, self-renewing — so anyone with a copy of the file held working owner-scoped access long after taking it. | New `main/tokenStore.ts`: values wrapped with safeStorage (DPAPI) into `*_enc` columns, 8 read sites and 3 write sites routed through it, `migratePlaintextTokens()` at startup so an upgraded till stops holding a clear credential within seconds. **The plaintext is cleared only after the wrapped value round-trips in the same write** — the naive version of this change is itself a lockout, and offline the owner cannot sign in again to replace what it destroyed. No safeStorage means plaintext, not a broken session. 14 tests, mutation-checked by removing the round-trip verification. Honest limit, same as PHASE2-3-DESIGN §2d: defeats a copied `.db`, a stolen backup and a pulled disk; not code running as the app user. |
| A1 (packaging) | `pos.zip` hand-built from the working folder, so `.env` rode along. Written as prose in five handoffs and committed as a script zero times — which is why it recurred. | `npm run package` → `git archive --format=zip HEAD -o pos.zip`, plus `npm run package:check` which fails if `.env` or `node_modules` appear. |

### Still open from the Beryl investigation

Eight orders failed on 2026-08-07 between 21:09 and 22:53 UTC, all `attempts=5`,
all `Failed to create order (ref: …)`. Ruled out by evidence, not by reasoning:

- **Not Glovo** — both sampled payloads are `"method":"cash"`.
- **Not the shift FK** — shift `79c4881f-…` exists, open, terminal `T1`.
- **Not the payment reconciliation guard** — 600 = 600 and 6040 = 6040 exactly;
  that path is 23514 and returns a readable 400 anyway.
- **Not an order-number collision** — 23505, handled as a 409 at `orders.ts:669`.

**CORRECTED 08-09 — "something threw after the RPC committed" is ruled out.**
`syncEngine.ts:1161` sends `X-Idempotency-Key: row.order_id`, identical on every
retry, and `orders.ts:360-372` checks that key **before anything else** and
returns `200 duplicate` when a matching order exists. So had attempt #1
committed — even if something then threw post-commit — attempt #2 would have
short-circuited and the row would have cleared at `attempts=2`. All eight
reached 5. **No attempt ever committed. The money is not banked and the till was
telling the truth.**

That leaves `throw createErr` on a code that is neither 23505 nor 23514.
**A14 is the candidate: 23503 on `orders_cashier_id_fkey`,** because the desktop
owner token can carry an `auth.users` id. It fits every ruled-out item, and it
fits the bounded window, because `/refresh` never re-resolves `userId`.

Settle it with either:

```sql
-- Expect ZERO rows. Any row means the deduction above is wrong.
select id, order_number, created_at, idempotency_key from public.orders
where idempotency_key in ( <the 8 local order ids from sync_queue> );

-- The smoking gun for A14: a cashier_id equal to businesses.owner_id
-- (an auth.users id) rather than a public.users id.
select b.name, b.owner_id as auth_id, u.id as users_id, u.email
from businesses b left join users u on u.business_id = b.id
where b.name ilike '%beryl%';
select distinct cashier_id from orders where business_id = '<beryl>';
```

The server log for `error 341849fb` remains the direct answer and now would
print the SQLSTATE (A15).

---

## B. CLOSED this session — audit findings

| ID | What it was | Closed by |
|---|---|---|
| A1 (rotation) | Live secrets in the archive | Rotated. **Packaging still open — see A1 above.** |
| B1 | `/pay` had no idempotency and no concurrency guard | Claim-before-write: `.eq('status','open').select()`. Loser returns the winner's payload; amount mismatch writes a `payment_exceptions` row. |
| B2 | Loyalty diverged 10× between counter and dine-in | `/pay` now uses `awardLoyaltyPoints` + earn rate + tier. Writes the ledger row, `total_spent` and `loyalty_points_used`. |
| B3 | ESC/POS built but `queueTickets()` never called | Wired into the sale path behind a per-terminal switch. |
| B4 | Two printer config stores | Stations from `print_stations`; printer bound per terminal. |
| B5 | `pump_id` end-to-end on desktop only | Added to `PaymentModal.buildOrderPayload`. `check-client-parity` proves it. |
| B6 | Low-stock alerts read `stock`, which nothing writes | Both jobs read `stock_levels`. `check-table-usage` proves it. |
| C1 | `fetchAllIds` paged without ORDER BY | `.order(idColumn)` + a `seen` set. |
| C2 | pageSize 1000 could silently truncate | 500, below every plausible row cap. |
| C3 | Racy read-then-write stock in 3 places | `adjust_product_stock` (existed, never called) + new `adjust_fuel_tank_level`. |
| C4 | Unescaped `ilike` pattern + `limit(20)` | `%`/`_`/`\` escaped, cap raised to 200. |
| C5 | BUG-18 owner lockout | **Three** sites, not two. Extracted to `lib/ownerBusiness.ts`; 409 + picker. |
| C7 | Numeric comparisons uncoerced | Fuel reorder, low-stock, discount floor. |
| C8 | `qty_pieces` fractional into an INTEGER column | Rounded in JS. |
| C9 | `dailySummary` `.lt()` — three bugs in one line | Removed; error destructured. |
| D1 | CI job named "Schema drift" did not run the drift gate | Added, plus both new gates. |
| D2 | `assert:built` warned instead of failing | Fails, and compares against newest `src/` mtime. |
| D3 | `build:all` did not clear `dist` | Cross-platform `clean` first. |
| BUG-16 | DB blip logged a cashier out | `try` narrowed to `jwt.verify`; 503 not 401. |
| BUG-19 | Till report overstated by every refunded bill | Nets off `refunded_amount`. |
| BUG-20 | Fuel deducted twice | Tank authoritative; `stock_levels` mirrors. |
| BUG-22 | `device_hint` stored a fleet-identical User-Agent | `device_id` first. Also fixes revocation. |
| — | `release:patch` built before bumping | Reordered. |
| — | `api.ts` stripped every error field but `code`/`status` | Preserved, so 409 payloads are usable. |

---

## P. CLOSED this session — printing

| ID | What it was |
|---|---|
| P-01 | Kitchen ticket empty: bridge used literal station ids that never matched real UUIDs. Now routes by **kind**. |
| P-02 | Combos opaque: components not sent. Now sent, routed by their own `category_id`. |
| P-03 | Plain products lost their variant entirely — `if (attrs.length && units.length)` dropped it when there were no components. |
| P-04 | Category never arrived: renderer sent `categories`, desktop products carry `category_id`. |
| P-05 | All three tickets fired at payment. Split: production on **send**, receipt on **pay**. |
| P-06 | Double printing when thermal was on — both systems fired. Old path now returns early. |
| P-07 | No receipt station possible on the till; receipt was never queued. "Till receipt" always offered. |
| P-08 | `Print receipt` said "sent" and printed nothing. Real reprint, marked **Duplicate Print**. |
| P-09 | Preview dead: handler expected a full `PrintContext`, screen sent `{stationId, paperWidthMm}`. |
| P-10 | Kitchen preview showed "0 items to cook" — sample routing ids didn't match the previewed station. |
| P-11 | Test print crashed on `station.kind` — same shape mismatch as P-09, missed once. |
| P-12 | **`-args` does not bind with `-Command`.** Root cause of three separate "printer" failures. Values now travel in the environment. |
| P-13 | Error classifier guessed from message text — `GetPrintQueue` was in the "not found" regex, so any fault in that call reported a wrong printer name. Now classifies on Win32 codes only, and says **"this is a fault in SwiftPOS"** when it is. |
| P-14 | USB needed manual sharing. Now Win32 `OpenPrinter`/`WritePrinter` RAW via P/Invoke — printer picked by name, no sharing, no native module. |
| P-15 | Receipt footer collapsed to one line — `wrap()` treats `\n` as a space. `wrapAuthored()` keeps author line breaks. |
| P-16 | **Every HTML print was truncated.** The measuring window had no width, so Electron defaulted it to 800px while printing at 302px. Shift report lost its entire cash reconciliation. |
| P-17 | Z-report was the last HTML document, via **two** routes (`printReceipt` and `window.open().print()`). Now ESC/POS through one helper. |
| P-18 | Drinks-only orders printed a kitchen slip reading **"0 items to cook"**. `hasPrintableContent()` — nothing routed, nothing printed. Receipts exempt. |
| P-19 | Both report screens set a failure message nothing displayed. Now shown. |

**New capability:** owner-stated kitchen exclusions (`business_settings.kitchen_exclusions`),
edited in Dashboard → Restaurant, cached on each till, applied to every source of
units. Your design — explicit beats inferred.

---

## I. Verified correct — do not re-audit

- **Item 10 numeric sweep:** additive coercion is clean. This codebase coerces at
  the API boundary, which is the right place. BUG-12 was in a *job* — no boundary.
  **Comparisons were not clean** — see C7.
- **The refund model is right.** `orders.status` stays `completed` on refund
  (migration 37), so the negative leg stays in shift-close scope. The bug was on
  the till only.
- **Constraints the code depends on all exist** — `stock_levels` and `users`
  composite uniques, and the `/orders` idempotency index. The schema dump does not
  render composite uniques; always cross-check `00_baseline.sql` before concluding
  one is missing.
- **`adjust_product_stock` already existed** (migration 61) and the sale path
  never called it. Same shape as `chunkIn`. Worth checking for more of these.
- **Ticket layouts match `SAMPLE-OUTPUT.txt` byte-for-byte**, both widths, and the
  sample is regenerated on every `npm test` in the printing package.

---

## L. The pattern

The 08-07 handoff ends: *"Every serious bug in this codebase came through the same
seam: two things that must agree, with nothing comparing them."*

This session was that, repeatedly — and now with gates on the two widest seams:

- `check-table-usage` — a table written under one name, read under another (B6)
- `check-client-parity` — a field the server reads that one client sends (B5)
- `check-ipc-parity` — caught P-17's handler landing in the wrong file **before** it shipped

The seam that kept biting and has **no** gate: **an IPC channel whose two sides
disagree about the payload shape** (P-09, P-11). `check-ipc-parity` proves a
channel exists, not that its arguments agree. That is the next gate worth building.

---

## Changelog

| Date | Change |
|---|---|
| 2026-08-07 | Opened. A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I. |
| 2026-08-07 | Live schema dump reviewed. Added B6, C7-C9, §0 dump caveat. BUG-19 upgraded and sized. |
| 2026-08-08 | G1-G7 shipped. 31 items closed. Printing migrated to ESC/POS end to end (P-01…P-19). Two new gates. Register restructured: open items first, closed items retained as evidence. |
| 2026-08-08 | Desktop audit (D1-D15) and Beryl sync investigation. Migration ledger reconciled against production (§M). Migration 46 applied. D12 and A1 packaging closed. Header counts and commit corrected. |
| 2026-08-10 | A45: the Receipt tab is shown on `isManagerRole` while the server demands `settings.manage` — a UI gate and a server gate disagreeing. A46: that one permission covers 16 routes from receipt text to eTIMS registration and till revocation; owner asked for a fine-grained split, proposed with seven keys. |
| 2026-08-10 | A42: the thermal toggle's OFF label reassured while nothing would print — corrected. A43: 0.5.27's exclusions box went onto PrintersTab, which is superseded and unrendered; deferred to PHASE6 as per-station. A44: station creation already exists on the dashboard. |
| 2026-08-10 | 0.5.26 built and installed. 0.5.27: HTML SALE path removed after thermal proved itself; D8 closed by reporting skipped stations rather than routing around them; escpos_enabled defaults ON with a guarded backfill; localStorage exclusion list retired. Shift reports and calibration deliberately kept. |
| 2026-08-10 | A40: DESKTOP_DESIGN.md confirmed lost; stub records what the citations preserve and where it lives, nothing reconstructed. A41: check-header-keys and check-test-registration added to CI — both caught defects in their own first versions. |
| 2026-08-10 | **A39**: BRANCH_AUTHORITY_AND_SYNC_DESIGN.md — cited by section in six source files, absent from the repo. Now in docs/. It already specifies A19, A24, PHASE5 §4 and PHASE6; status line reads "agreed design, not yet implemented". |
| 2026-08-10 | Rule 21 (node vs cloud vocabulary). PHASE6 designed: branch-local settings owned by the node, cloud-backed, manager-editable offline — the first payload for A24's downstream channel. |
| 2026-08-10 | **A38**: the till sent X-Device-Id twice; every server reader got a comma-joined, truncated value. Third independent cause of the empty fleet, alongside D14's opt-in flag and A36's surface. Normalised server-side so old and new builds resolve the same terminal key. |
| 2026-08-10 | **A36 (P0)**: `/desktop-login` minted `surface: 'web'` while its own header said `'desktop'`. Four features silently dead on every till — offline sign-in (D16) never worked in the field, device registration never ran, the licence gate never fired, requireWebSurface bypassed. One word. A37 opened. |
| 2026-08-10 | D14 measured in production: **0 registered devices across all 10 businesses**, and one `require_device_registration` row anywhere (Lovers Rock, false). Registration has never run for any tenant; deviceBinding.ts, devices.ts, migration 43 telemetry and migration 52 binding have all been dead code in production. |
| 2026-08-10 | CI #44 (PR dev→main): secret scan 403 — no permissions block, so gitleaks could not read PR commits and scanned nothing. Passing on push for 40+ runs, never exercised on the event that gates main. Fixed; .env check moved first so one fault cannot skip both gates. |
| 2026-08-10 | CI #42: desktop-scope red — the three desktop suites import dist/main and the job never built it. Build + the two installs added, verified from a clean checkout. Other five jobs green, including all 7 migration files. |
| 2026-08-10 | A32: six migration tests existed and none ran; test-migration-47 had never worked (hardcoded sandbox path, 19 dead assertions). Runner added, all 7 in CI. A33: Windows path bug in my harness. |
| 2026-08-10 | Target run: 92 desktop tests green under real Electron ABI. A31 found — failover-cursors was never wired into test:desktop, A16 repeated in the batch that closed A16. A9 measured: 23/3-critical is desktop, server is 6/0. |
| 2026-08-10 | Migration 74 failed on the owner's database (42P16). Fixed, plus a second idempotency bug only execution found. Migrations now run against real Postgres (PGlite) in CI — 17 tests. A30 closed. |
| 2026-08-10 | D4: migration 74 makes a claimed role verifiable — TOFU per branch, recorded conflicts, one-hour handover window, unique index. A25 closed; A22 partly closed. A29 found: --merge-migrations resurrects renamed columns and weakens the audit. |
| 2026-08-10 | Office role (view-only node) brought into scope. PHASE5 §4b corrected from `=== 'node'` to `isNodeRole()`. Migration 73 adds device_role; till reports it; registry stores and labels it. A27, A28 closed. A4 measured: 20/66. A25 still open — a role can now be seen, not verified. |
| 2026-08-10 | Rule 17 sweep on D14. Cause found at `auth.ts:432` — an opt-in flag, not a missing upsert; far more was built than credited. D14 and A26 closed; approval and registration separated. A25 still open by design. |
| 2026-08-09 | Owner's correction upheld: most of the architecture is built. A24 opened as the unifying finding — the node has no downstream distribution. PHASE5 §11 rewrites the delta; `branch_staff` dropped in favour of columns on the existing `users` table. |
| 2026-08-09 | Failover clarified: data replicates to all tills, a peer can be promoted. Promotion machinery confirmed present and sound. A20-A23 opened against the gaps; PHASE5 gains §10. |
| 2026-08-09 | Owner's design clarification: node is branch source of truth, sole cloud uplink, may stay offline forever and may authorise. A17/A19 resolved to a design; `PHASE5-NODE-AUTHORITY.md` written for approval. Reverses D16's override-PIN decision (§5) and makes D4/D14 prerequisites (§7). |
| 2026-08-09 | Batch 1 (server). A14 Beryl root cause found and fixed, A15 error classification, A16 CI gap, A2 closed. Beryl post-commit hypothesis ruled out by idempotency deduction. 17 new tests, mutation-checked. |
| 2026-08-08 (eve) | D2, D12, D13 (client half), D16 offline sign-in, A1 packaging closed. Migration 46 applied. 78 desktop tests added, green on Windows/Node 20 with SQLite suites on the real Electron ABI. Working rules moved into the handoff §0. |
