# SwiftPOS — batch 2026-08-09-a (server only)

**Base commit:** `f9d29a8` on `dev`.
**Scope:** server only. **No desktop change, no migration, no deletion, no rename.**
Every change is revertable by restoring one file.

Register IDs: **A2** (closed), **A14** (new, P0), **A15** (new, P1), **A16** (new, P0).

---

## Files

| File | Change | Why |
|---|---|---|
| `apps/server/src/lib/orderErrors.ts` | **NEW** (117 lines) | A15. The order-create error classifier, extracted so a test can drive the shipped code rather than a copy of it. |
| `apps/server/src/routes/orders.ts` | 1 import + the `createErr` block | A15. Was `throw createErr` for everything not 23505/23514. Now classified, and the log carries the SQLSTATE and every FK-bearing id. |
| `apps/server/src/routes/auth.ts` | +`resolveOwnerUserRow()`, 2 lookups replaced, 2 warnings | **A14 — the Beryl root cause.** `.eq('email')` was case-sensitive; a miss mints a token whose `userId` is an `auth.users` id, and `orders.cashier_id REFERENCES public.users(id)`. |
| `apps/server/src/routes/mpesa.ts` | 1 import + 2 lookups | A2/BUG-17. `:224` broke on refunded orders (two mpesa legs). `:372` discarded the lookup error and dropped real collected payments as "unknown checkout". |
| `tests/order-error-classification.test.mjs` | **NEW** (17 tests) | A14 + A15, mutation-checked. |
| `.github/workflows/ci.yml` | +1 job, +2 steps | A16. |
| `docs/AUDIT-REGISTER.md` | A2 closed; A14/A15/A16 added; Beryl section corrected; header + changelog | Rule 14. |

---

## What was run, and what it printed

Environment: **Linux, Node 22.22.2, npm 10.9.7.** The server deploys to Render
(Linux), so for these files this is environment-equivalent, not a weaker claim
under rule 9. **Nothing here was run on Windows and nothing touches the desktop.**

```
apps/server  npx tsc --noEmit                 exit 0
apps/server  npm run build                    exit 0
             node scripts/typecheck-ratchet.mjs server
                                              server ✓ 0 errors (baseline held)
             python3 scripts/schema-audit.py --strict
                                              458 selects / 100 inserts, 76 tables, total: 0

check-supabase-catch   OK    check-table-usage      OK
check-client-parity    OK    check-rls-coverage     OK
check-sql-binds        OK    check-own-rows         OK
check-row-attribution  OK    check-ipc-parity       OK
check-schema-drift     OK

tests/order-error-classification.test.mjs      17 passed, 0 failed
all 18 tests/*.test.mjs                        exit 0
```

**Mutation check (rule 10).** Deleted the `23503` branch from
`lib/orderErrors.ts`, rebuilt, re-ran:

```
with fix REMOVED,  exit=1   (15 passed, 2 failed)
with fix RESTORED, exit=0   (17 passed, 0 failed)
```

## What could NOT be verified here

1. **That A14 is actually what killed Beryl's eight orders.** The chain is read
   from source and from your schema dump; it is a deduction, not an observation.
   The two queries in AUDIT-REGISTER §E settle it. **If `cashier_id` on Beryl's
   good orders is a valid `public.users` id, A14 is real but is not the cause,
   and the log grep for `error 341849fb` is still the answer.**
2. **The mpesa paths against real Daraja.** No callback was replayed; the refund
   case was not exercised against a real two-leg order.
3. **The CI job as GitHub runs it.** The YAML parses and the loop was simulated
   locally; it has not run on a runner.
4. **Anything on Windows or on a till.** Untouched by this batch.

## Rollback

```bash
git checkout f9d29a8 -- .github/workflows/ci.yml apps/server/src/routes/auth.ts \
  apps/server/src/routes/mpesa.ts apps/server/src/routes/orders.ts docs/AUDIT-REGISTER.md
rm -f apps/server/src/lib/orderErrors.ts tests/order-error-classification.test.mjs
```

## Deploy note

Additive and server-only, so it does **not** disturb the 0.5.25 deploy ordering:
server first, tills second, still holds. This batch can ship with that server
deploy or ahead of it.

**A14 does not fix an already-poisoned session.** If an owner is currently
holding a token built from the fallback, it stays wrong until they sign in
again — `/refresh` reuses `userId`. **Have the owner sign out and back in on the
till after this deploys.**

---

# Batch 2026-08-09-**b** — additions (supersedes -a; cumulative)

Triggered by the owner's design clarification: *main POS registered online once,
client tills then rely on the server till and can sell without internet
indefinitely.* Investigating that against source produced three findings. **No
code behaviour changes in this batch** — it is one comment correction and the
register.

| File | Change | Why |
|---|---|---|
| `apps/desktop/src/main/nodeServer.ts` | **header comment only** — 0 non-comment lines changed (`git diff` verified) | A18. The header claimed the node was the sole cloud uplink and re-enqueued peer orders. Neither is true. |
| `docs/AUDIT-REGISTER.md` | +A17 (P0), +A18 (P1), +A19 (P1) | Rule 14. |

## The findings

- **A17 · P0** — "offline forever" is not possible today. Auth is cloud-only
  (`ownerFetch` → `server_url`; the node has no `/node/verify-pin`), so the only
  offline door is `staff_pin_cache`, whose `cached_at` is written **only** on a
  successful *cloud* verify-pin. LAN contact with the node cannot refresh it.
  **Day 15 with no internet, every cashier is refused and the till cannot open.**
- **A18 · P1** — `nodeServer.ts`'s header documented an architecture that no
  longer exists, contradicting `syncEngine.ts:1138-1151` and
  `nodeIngest.ts:414-418`.
- **A19 · P1** — a permanently-offline peer's sales reach the node (branch
  totals right) but never the cloud: `INSERT INTO sync_queue` exists only at
  `syncEngine.ts:1566` on the selling till, and nothing forwards peer rows.

## What was run

```
apps/server  npx tsc --noEmit    exit 0     (unchanged from -a)
all 18 tests/*.test.mjs          exit 0
git diff nodeServer.ts           28 insertions / 7 deletions, ALL comments
```

**Not verified:** `apps/desktop` does not typecheck in this sandbox —
`@types/node`, `electron` and `better-sqlite3` are not installed, so `tsc -b`
reports missing-module errors on files I never touched. The change is
comment-only and proven so by diff, but **it has had no compiler pass.** Run
`npm run test:desktop` on the target before shipping.

## Rollback (batch -b only)

```bash
git checkout f9d29a8 -- apps/desktop/src/main/nodeServer.ts docs/AUDIT-REGISTER.md
```

---

# Batch 2026-08-09-**c** — additions (supersedes -b; cumulative)

Owner's design clarification answered all three open questions from -b. **No code
in this batch — design and register only.** §8 of the design says why: this
changes how a till authenticates, and with no auto-update (D3) a bad build is a
site visit. Nothing ships before 0.5.25 has traded a full service.

| File | Change | Why |
|---|---|---|
| `docs/PHASE5-NODE-AUTHORITY.md` | **NEW** | The specification. FOR APPROVAL BEFORE CODE, per this repo's own convention. |
| `docs/AUDIT-REGISTER.md` | A17 → design agreed · A19 → resolved · A18 note · changelog | Rule 14. |

## The three answers, and what each changed

| Question | Answer | Consequence |
|---|---|---|
| A19 — does the node forward to cloud? | **Yes. Node is sole uplink; cloud is web access + backup.** | Peers with a `node_url` stop pushing to cloud. `syncEngine.ts:1138-1151` was right about the *mechanism* (two queues) and wrong about the *routing*. Only the routing changes. |
| Does the node's registration expire? | **No — remote sites with minimal internet must not be locked out.** | `PIN_CACHE_TTL_DAYS` is redefined as "days since ANY authority was reached". A peer seeing its node daily never expires; a node never expires. |
| Override PIN offline? | **Yes, the node may authorise.** | **Reverses a D16 decision.** Mitigated: override hashes live on the node ONLY and are never cached on a peer, so a stolen peer still gains nothing — which was D16's actual threat model. A stolen node is genuinely worse, and that is accepted knowingly (§5). |

## Two things the design forced out that were not asked for

- **D4 (enrolment) stops being deferrable.** §4b hands a machine the branch's PIN
  hashes on the strength of `device_role === 'node'` — a value the till currently
  asserts about itself. D4 must land in the same work, not after it.
- **D14 (the till is not registered) becomes a prerequisite.** `user_devices` has
  no row for Beryl at all, so there is nothing to check `device_role` against
  server-side. This is the same D14 I wrongly called a one-line upsert.

## What was run

```
apps/server  npx tsc --noEmit    exit 0   (unchanged from -a)
all 18 tests/*.test.mjs          exit 0
```

Documentation only in this batch; nothing executable changed since -b.

## Rollback (batch -c only)

```bash
git checkout f9d29a8 -- docs/AUDIT-REGISTER.md
rm -f docs/PHASE5-NODE-AUTHORITY.md
```

---

# Batch 2026-08-09-**d** — additions (supersedes -c; cumulative)

Owner's failover clarification. **Still no code** — the design is not approved
and §10.1 needs an owner decision. Documentation and register only.

| File | Change | Why |
|---|---|---|
| `docs/PHASE5-NODE-AUTHORITY.md` | **+§10 Failover** (six subsections) | Promotion is in scope now that PHASE5 makes the node load-bearing for auth. |
| `docs/AUDIT-REGISTER.md` | +A20 (P1), +A21 (P1), +A22 (P2), +A23 (P2), changelog | Rule 14. |

## First: the existing promotion machinery is better than the register credits

Verified by reading, not by the docs:

- `tech:promoteToNode` (`ipcHandlers.ts:1746`) — session-gated, audited
  (`role.promote` from/to), clears `node_url`, starts the listener, returns the
  branch secret.
- `tech:setNodeUrl` — **probes before saving**, and doubles as the demotion path.
- `collectDistribution` (`nodeIngest.ts:605`) — fans every origin's rows to every
  other peer, so each till holds the whole branch.
- Orders carry `_items` and `_payments` as children (`:641-648`), so a promoted
  till holds **complete** orders, not just headers.

**The owner's claim holds.** Four things stop it holding completely.

## The four

| ID | Severity | What |
|---|---|---|
| **A20** | P1 | `REPLICATED_TABLES` is orders/shifts/float/expenses/business_days/events. PHASE5's `branch_staff` was specified node-only, so **a promoted till would hold every sale and be unable to sign anyone in.** Needs an owner decision — replicating the roster means a stolen peer yields the branch's PIN hashes. |
| **A21** | P1 | `outbox_cursors` PRIMARY KEY is `table_name` — **no node identity**, while `peer_cursors` is correctly `(device_id, table_name)`. After a repoint a peer never re-offers rows the dead node had but never distributed. Fix is two lines in `tech:setNodeUrl`. |
| **A22** | P2 | Promotion has no split-brain check. An old node unplugged rather than dead gives the branch two nodes. |
| **A23** | P2 | Distribution lag **is** the RPO and nothing measures it. Plus a missing runbook line: do not wipe a failed node until its `.db` has been read. |

## The decision I need (A20 / §10.1)

|  | Roster node-only (§5 as written) | Roster replicated (failover works) |
|---|---|---|
| Stolen peer yields cashier PINs | No | **Yes** |
| Stolen peer yields override PINs | No | **Yes**, unless split |
| Node dies at a remote site | **Shop shut** | Promote and carry on |

**My recommendation:** replicate, default on, with override-hash replication as a
per-business flag a hardened site can turn off. A branch is one trust domain —
every till already holds every sale, customer and price for the whole branch, so
withholding the roster buys less than it looks like. The stronger controls are
DPAPI, the branch secret and a typed Windows password — plus one that does not
exist yet: **rotate PINs when a terminal goes missing.**

## What was run

```
apps/server  npx tsc --noEmit    exit 0    (unchanged since -a)
all 18 tests/*.test.mjs          exit 0
```

Documentation only; nothing executable changed since -b.

## Rollback (batch -d only)

```bash
git checkout f9d29a8 -- docs/AUDIT-REGISTER.md
# and revert §10 from docs/PHASE5-NODE-AUTHORITY.md, or drop the file (new in -c)
```

---

# Batch 2026-08-09-**e** — additions (supersedes -d; cumulative)

Owner's push-back — *"most of the architecture had been built"* — checked against
source and **upheld**. Documentation and register only; no code.

| File | Change |
|---|---|
| `docs/PHASE5-NODE-AUTHORITY.md` | **+§11 REVISION**, which supersedes §§3-5 where they disagree |
| `docs/AUDIT-REGISTER.md` | +A24 (P1, the unifying finding), + an explicit CORRECTION entry, changelog |

## What I got wrong

§§3-5 over-specified. The clearest example: I proposed a new `branch_staff`
table when the local `users` table **already exists and is already synced**
(`syncEngine:581` → `:806`), and `shapeStaff` (`staff.ts:85-90`) already strips
the hashes in exactly one place. The work is columns and a flag, not a table.

I also under-credited: bidirectional replication with cursors, orders replicating
**complete** with `_items`/`_payments`, promotion and demotion (session-gated,
audited, probe-before-save), `EVENT_WHITELIST` as an explicit security boundary,
Phase 4 central day close, `can_authorize`, `/api/staff/authorizers`, end-to-end
idempotency. The hard parts are done.

## The reframing (A24)

`REPLICATED_TABLES` is all sales-side. Everything a till READS still comes from
the cloud — `syncEngine:476` catalogue, `:581` staff, both against `_serverUrl`.

> **The node replicates sales upward and sideways. Nothing flows downward
> through it.**

A17, A20 and A24 are three symptoms of that one sentence. So is the 14-day
lockout: the cache is not wrong, the node is simply absent from the read chain.

## Corrected delta (§11.4) — nine items, one substantial

Substantial: extend `collectDistribution` downstream to carry `users` and the
catalogue tables. Closes A17, A20 and A24 together.
Small: columns on local `users`; a flag on `shapeStaff`; `POST /node/verify-pin`;
the node→cloud→cache authority chain; refresh `cached_at` on node contact (1
line); reset outbox cursors on repoint (2 lines, A21); node enqueues ingested
rows to its own `sync_queue`; peer skips cloud push when `node_url` is set.

**No `LOCAL_SCHEMA_VERSION` bump** — all local tables run
`CREATE TABLE IF NOT EXISTS` ungated on every open, per D2.

## What was run

```
apps/server  npx tsc --noEmit    exit 0
all 18 tests/*.test.mjs          exit 0
```

## Rollback (batch -e only)

```bash
git checkout f9d29a8 -- docs/AUDIT-REGISTER.md
# revert §11 from docs/PHASE5-NODE-AUTHORITY.md, or drop the file (new in -c)
```

---

# Batch 2026-08-09-**f** — CODE (supersedes -e; cumulative)

**A21 closed.** First batch since -a with executable changes on the desktop.
Manifest moved into `docs/` — it should not have been in the root.

| File | Change | Why |
|---|---|---|
| `apps/desktop/src/main/nodeIngest.ts` | **+`resetOutboxCursors()`** | A21. Forget how far this till has offered its rows, so the next fill offers everything again. |
| `apps/desktop/src/main/ipcHandlers.ts` | `tech:setNodeUrl` — reset on an actual URL change; new `node.reoffer` audit action | A21. |
| `apps/desktop/test/failover-cursors.test.mjs` | **NEW**, 12 tests | A21, mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A21 closed · **A25 opened (P1)** | Rule 14. |

## Checked before writing anything, as instructed

Every one of the nine PHASE5 §11.4 items was swept for existing work first. Two
findings changed the plan:

1. **Distribution is a device-originated, seq-based star.** Every row carries
   origin `device_id` + `seq`, and ingest deliberately REFUSES rows without them
   (re-stamped, claiming the receiver's identity, missing seq). `users` and the
   catalogue are cloud-originated with neither. **Adding them to
   `REPLICATED_TABLES` would mean faking a seq or weakening those refusals** —
   it would break the model. Reference data needs its own channel, not this one.
2. **`pullCatalogue` is a 415-line function with fetch and apply interleaved.**
   Serving it from the node means splitting fetch from apply — a real refactor of
   the most load-bearing function on the till. That is its own step with its own
   verification, not something to bolt on.

## A25 — why the credentials endpoint was NOT built

`grep -rn "device_role" apps/server/src/` returns **nothing**. The server cannot
tell a node from any other till. So PHASE5 §4b's endpoint could only be gated on
`surface === 'desktop'` — which every till has — and an owner token, which every
till holds. Shipping it would hand the branch's PIN hashes to any till, and to
anyone who lifted a token off one.

**Blocked on D14 then D4, exactly as PHASE5 §7 predicted.** Recorded as A25
rather than built badly.

## A21 — what shipped

`resetOutboxCursors()` called from `tech:setNodeUrl` **only when the URL actually
changes**; re-entering the same address must not trigger a full re-offer.

Option 2 (keying the table `(node_id, table_name)`) was **not** taken: it is a
local-schema change to the mechanism that decides whether a field till works, and
D6 records six generations of that going undocumented. The test asserts the
current primary key, so it fails loudly if that ever changes.

**One gate caught me, and I did not loosen it.** `test-office-role` asserts by
source-text regex that `tech:setNodeUrl` is session-gated and audited within a
300-character window. My first draft put explanatory comments and three
declarations between the two anchors and pushed the audit line outside it. The
gate was semantically satisfied but structurally right to complain, so the prose
moved above the handler and the re-offer became its **own** audit action
(`node.reoffer`) rather than a field on `role.repoint` — better auditing, and the
original assertion is untouched.

## What was run, and what it printed

```
server tsc               OK      desktop main tsc -b      OK
schema-audit --strict    total: 0

check-supabase-catch  OK   check-table-usage      OK
check-client-parity   OK   check-rls-coverage     OK
check-sql-binds       OK   check-own-rows         OK
check-row-attribution OK   check-ipc-parity       OK
check-schema-drift    OK   check-shared-sync      OK

test-node-ingest            OK   test-node-distribution   OK
test-sync-rejection-routing OK   test-office-role         26/26
test-events                 OK   test-branch-close        OK
test-maintenance            OK   test-print-resilience    OK

desktop  logFile 12/12 · syncEngine-failures 29/29 · failover-cursors 12/12
server   all 18 tests/*.test.mjs                        exit 0
```

**Mutation check (rule 10):** removed the `DELETE FROM outbox_cursors` →
9 passed / 3 failed, exit 1. Restored → 12/12, exit 0.

## What could NOT be verified here

1. **`failover-cursors` ran on `node:sqlite`, NOT the app's driver.** The suite
   **prints this itself** rather than implying a hardware-equivalent green.
   better-sqlite3 in this sandbox was installed `--ignore-scripts`, so it
   resolves but throws on construction — which is why driver selection catches
   the CONSTRUCTION, matching `heldOrders.test.mjs`. **Run
   `node test/run-under-electron.mjs test/failover-cursors.test.mjs` on the
   target.**
2. **No real failover has been performed.** PHASE5 §10.6 step 4 is the test that
   proves this fix; it needs three tills and a node.
3. `test-maintenance` fails in this sandbox with `MODULE_NOT_FOUND` — it needs
   `better-sqlite3` at the repo root, which CI installs. Green once installed,
   and **it failed identically on the clean tree before any of my changes.**
4. Nothing has run on Windows or on a till.

## Rollback (batch -f only)

```bash
git checkout f9d29a8 -- apps/desktop/src/main/ipcHandlers.ts \
  apps/desktop/src/main/nodeIngest.ts docs/AUDIT-REGISTER.md
rm -f apps/desktop/test/failover-cursors.test.mjs
```

---

# Batch 2026-08-09-**g** — rules (docs only, NO ZIP per new rule 18)

| File | Change |
|---|---|
| `docs/HANDOFF-2026-08-08-evening.md` | **+§0 rules 17-20** under a new "Working with this codebase" subsection |
| `docs/AUDIT-REGISTER.md` | Pointer to 17-20 in the working-rules note |

## The rules added

- **17 — Assume it is already built, halfway.** Sweep for the existing
  implementation and read it before designing. Proposing something that already
  exists is worse than proposing nothing: it gets built twice and the copies
  drift. Withdraw a design plainly when it turns out to duplicate.
- **18 — Zip only when code changed.** Docs-only batches get the changed file
  and a manifest entry. An archive carrying only prose trains the eye to skip.
- **19 — Nothing but `README.md` in the repo root.** Documents live in `docs/`.
- **20 — Be sure, then build clean and do not break it.** Every existing gate
  green counts as "not broken"; never loosen a gate to fit your own change; if
  the right guard does not exist yet, do not ship the thing that needs it.

## Why they append instead of slotting in

Rules **9, 10, 14 and 15 are cited by ID** across the register, the previous
handoffs and every manifest entry in this file. Inserting into the Delivery /
Evidence / Judgement sections would renumber them and silently break those
references, so 17-20 sit in their own dated subsection and the note says numbers
are stable and never reused — the same convention the register uses for finding
IDs.

**Verified:** rules 5, 9, 10, 14, 15, 16 still present at their original numbers;
`ls *.md` in the repo root returns `README.md` only.

## What was run

Nothing executable changed in this batch — two Markdown files. The full sweep
from batch -f (server tsc, desktop main tsc, 10 gates, 8 phase scripts, 3 desktop
suites, 18 server suites) stands unchanged and was not re-run, because no input
to it moved.

## Rollback (batch -g only)

```bash
git checkout f9d29a8 -- docs/HANDOFF-2026-08-08-evening.md docs/AUDIT-REGISTER.md
```

---

# Batch 2026-08-10-**a** — CODE · D14 + A26 (server only)

Base `f9d29a8`. Cumulative with everything above. **Server only — no desktop
change, no migration, no deletion, no rename.**

| File | Change |
|---|---|
| `apps/server/src/lib/deviceRegistry.ts` | **NEW** — unconditional desktop terminal registration |
| `apps/server/src/routes/auth.ts` | +import; register on `/desktop-login` and on `/verify-pin` when `surface === 'desktop'` |
| `apps/server/src/routes/sync.ts` | `.select('id')` on the telemetry update + a zero-row branch (A26) |
| `tests/device-registration.test.mjs` | **NEW**, 20 tests |
| `docs/AUDIT-REGISTER.md` | D14 closed · A26 closed · changelog |

## The rule 17 sweep changed the answer completely

I called D14 a one-line upsert, then a device-enrolment design decision.
**Both wrong.** Already built and uncredited: `lib/deviceBinding.ts` (181 lines
— rebind windows, relocation history, terminal-code conflict handling,
fails-open-until-bound) and `routes/devices.ts` (216 lines — fleet, approve,
reject, delete, permission gated), **mounted at `routes/index.ts:94`**.

I also nearly reported `devices.ts` as unmounted, having grepped
`apps/server/src/index.ts` instead of `apps/server/src/routes/index.ts`. Caught
before it was claimed — but worth recording as the near-miss it was.

**The cause is `auth.ts:432`** — registration behind an opt-in flag Beryl never
enabled, with owners and elevated roles exempted earlier still, and
`/desktop-login` registering nothing at all. Nothing was broken. Registration was
never reached.

## The design call

`require_device_registration` gates the right thing for the wrong population: it
means *"approve cashiers signing in from a new BROWSER"*. **Untouched.** A
desktop till is not a browser — stable `device_id`, bound to a branch, the unit
migration 52 exists to control. Desktop registration is therefore unconditional
and separate.

- New rows land **`approved`** — a pending row blocks the shop until somebody
  opens the dashboard, unacceptable at a remote site. Reaching that code already
  required a valid owner token or a verified PIN.
- An existing row's **`status` is never touched**, so a rejected terminal is not
  silently re-approved by signing in again.
- **No `branch_id`** — `checkDeviceBranch` owns binding; guessing could bind a
  till to the wrong branch permanently.
- **No `device_role`** — registration is not authorisation. **A25 stays open by
  design**, and PHASE5 §4b is still correctly blocked.

## What was run

```
server tsc              OK      desktop main tsc -b     OK
typecheck-ratchet       server ✓ 0 errors (baseline held)
schema-audit --strict   total: 0

all 10 check-*.mjs gates                                OK
8 phase scripts (node-ingest, distribution, rejection-routing,
  office-role, events, maintenance, branch-close, print) OK
desktop  logFile · syncEngine-failures · failover-cursors OK
server   19 suites (was 18)                             OK
tests/device-registration.test.mjs                      20/20
```

**Mutation checks (rule 10), both ways:**
- Removed the telemetry fix from the model → exit 1. Restored → exit 0.
- Removed `.select('id')` from `sync.ts` → **`tsc` itself fails**: with no
  `data` there is nothing to count, so the zero-row branch cannot exist. The
  compiler enforces this one.

## What could NOT be verified here

1. **No till has registered against a real database.** The insert path, the
   partial unique index `(business_id, device_id)`, and the 23505 race branch
   are all unexercised against Postgres. First desktop sign-in after deploy
   should be followed by `select * from user_devices where business_id = '<beryl>'`.
2. **Whether `branch_id` binds correctly on first sync** — that is
   `checkDeviceBranch`'s existing path, now reachable for the first time. Worth
   watching, because it has never actually run in production.
3. Nothing ran on Windows or on a till.

## Deploy note

Additive and server-only. Ordering is unchanged: server first, tills second.
After deploy the till must sign in once for a row to appear — which the A14 fix
already requires anyway (sign out and back in).

## Rollback

```bash
git checkout f9d29a8 -- apps/server/src/routes/auth.ts apps/server/src/routes/sync.ts \
  docs/AUDIT-REGISTER.md
rm -f apps/server/src/lib/deviceRegistry.ts tests/device-registration.test.mjs
```

---

# Batch 2026-08-10-**b** — CODE · office role, migration 73 (supersedes -a)

Base `f9d29a8`. Cumulative. **Contains a MIGRATION** — first batch that does.

| File | Change |
|---|---|
| `migrations/73_device_role.sql` | **NEW** — `device_role`, `role_reported_at`, `branch_serving_devices` view |
| `apps/server/src/lib/deviceRegistry.ts` | `normaliseDeviceRole`, `isNodeRole`, `canSell`, `labelFor`, missing-column degradation |
| `apps/server/src/routes/auth.ts` | Pass the reported role from both sign-in paths |
| `apps/server/src/routes/sync.ts` | Role refreshed on sync, as a **separate** statement |
| `apps/desktop/src/main/syncEngine.ts` | Sends `X-Device-Role` |
| `tests/device-registration.test.mjs` | 20 → **33 tests** |
| `docs/PHASE5-NODE-AUTHORITY.md` | **§12 correction** — every gate becomes `isNodeRole()` |
| `docs/AUDIT-REGISTER.md` | A27, A28 closed · A4 measured · changelog |

## The design was wrong and the code comment predicted it

`deviceConfig.ts:26` defines three roles, supplies `isNodeRole()` and
`canSell()`, and warns: *"comparing against the literal 'node' anywhere else is
how office machines fall through cracks."* **PHASE5 §4b gated credential
distribution on `device_role === 'node'`** and would have refused an office
machine the branch roster — backwards, since an office box is the one that is
safe unattended, which is §10.1's entire security argument.

## Two hazards I introduced and then removed

1. **Migration coupling.** Writing `device_role` in the same statement as
   everything else tied registration AND all fleet telemetry to migration 73
   being applied — a failed INSERT would create no row at all. Given **only 20
   of 66** migrations record themselves and 68 and 72 are missing from the repo,
   "not applied" is the normal state here. Now: the registry detects
   `42703`/`PGRST204` and retries without the role columns; sync writes the role
   as an independent statement. Terminal registers either way.
2. **Numbering.** 72 is absent from the repo and may exist in production, so
   this is **73**. A collision on the migration ledger is not recoverable the way
   a wasted number is.

## What was run

```
server tsc            OK      desktop main tsc -b     OK
typecheck-ratchet     server ✓ 0 errors (baseline held)
schema-audit --strict total: 0
check-schema-drift    67 migrations, 98 tables, 17 functions — migrations and database agree

all 10 check-*.mjs gates                                 OK
8 phase scripts incl. test-office-role                   OK
desktop  logFile · syncEngine-failures · failover-cursors OK
server   19 suites                                       OK
tests/device-registration.test.mjs                       33/33
```

## What could NOT be verified here

1. **Migration 73 has not been run against any database.** The DDL, the CHECK,
   the partial index and the view are unexecuted. Apply to a copy first.
2. **The degradation path is modelled, not exercised** — no server has been run
   against a database lacking the columns.
3. **No till has reported `X-Device-Role`.** The header is sent by code that has
   not run.
4. Nothing on Windows or on a till.

## Deploy order for this batch specifically

**Migration 73 first, then the server, then the tills.** The degradation exists
so a wrong order is survivable, not so it can be ignored — out of order, roles
are silently absent until the migration lands.

## Rollback

```bash
git checkout f9d29a8 -- apps/server/src/routes/auth.ts apps/server/src/routes/sync.ts \
  apps/desktop/src/main/syncEngine.ts docs/AUDIT-REGISTER.md docs/PHASE5-NODE-AUTHORITY.md
rm -f migrations/73_device_role.sql apps/server/src/lib/deviceRegistry.ts \
  tests/device-registration.test.mjs
```

The migration is additive (two nullable columns, one index, one view) and safe to
leave applied after a code rollback.

---

# Batch 2026-08-10-**c** — CODE · D4 / A25 (supersedes -b)

Base `f9d29a8`. Cumulative. **Contains migration 74.**

| File | Change |
|---|---|
| `migrations/74_device_role_confirmation.sql` | **NEW** — confirmation, handover window, conflict record, unique index |
| `apps/server/src/lib/deviceRole.ts` | **NEW** — `confirmServingRole`, `isConfirmedBranchServer` |
| `apps/server/src/routes/devices.ts` | **NEW** `POST /:id/authorise-handover` |
| `apps/server/src/routes/sync.ts` | Confirm the serving role once the claim lands |
| `scripts/schema-index.json` | +8 columns from migrations 73/74 (see A29) |
| `tests/device-role-confirmation.test.mjs` | **NEW**, 23 tests |
| `docs/AUDIT-REGISTER.md` | A25 closed · A29 closed · A22 partly · changelog |

## The design reuses migration 52 rather than inventing a mechanism

Trust on first use per branch, then closed, with a manager-granted window. **One
deliberate difference: this fails CLOSED where 52 fails open** — the cost of a
wrong answer is the branch's PIN hashes, not a misattributed sale.

Two details worth review:
- **The branch is read from the device's own server-side row, never the
  request.** A caller-supplied branch would be a second claim propping up the
  first, which is what this exists to stop.
- **Handover clears the incumbent FIRST.** The unique index forbids two
  confirmed rows, so the other order would be refused — and an interruption must
  leave the branch with NO confirmed server rather than two.

`isConfirmedBranchServer` is read-only and never confirms as a side effect: a
read that quietly grants is how a check stops being one.

## A29 — the gate caught me, and then the fix tool tried to weaken the gate

`schema-audit` correctly failed: migrations 73/74's columns were not in
`schema-index.json`. The sanctioned unstick path is
`build-schema-index.mjs --merge-migrations`, and it **added six columns that do
not exist in the live database** — verified against the 08-09 dump:

```
category_stations.business_id   fuel_tanks.product_id   fuel_tanks.tank_name
parking_sessions.billed_amount  parking_sessions.cashier_id  parking_sessions.notes
```

Each was created by an early migration and renamed by a later one. The tool
documents *"never removes"* as a safety property — true for removals, but it
cannot know a column was renamed, so it resurrects dead names. **Code selecting
`fuel_tanks.product_id` would then pass the audit and fail at runtime**, which is
the exact failure the index exists to catch.

Removed by hand against the live dump. Verified **semantically, not by diff**:
98 tables before and after, nothing lost, only the eight columns from 73/74
added, `total: 0`.

**The tool is not fixed** — that is its own change. Standing caveat recorded:
`--merge-migrations` output must be diffed against the live schema before commit.

## What was run

```
server tsc            OK      desktop main tsc -b     OK
typecheck-ratchet     server ✓ 0 errors (baseline held)
schema-audit --strict 467 selects / 100 inserts, 76 tables — total: 0
check-schema-drift    68 migrations, 98 tables, 17 functions — agree

all 10 check-*.mjs gates                                 OK
8 phase scripts                                          OK
desktop  logFile · syncEngine-failures · failover-cursors OK
server   20 suites (was 19)                              OK
tests/device-role-confirmation.test.mjs                  23/23
```

**Mutation check:** removed the conflict guard → exit 1. Restored → exit 0.

## What could NOT be verified here

1. **Migrations 73 and 74 have never been run.** The DDL, both CHECKs, the
   partial unique index and the view are unexecuted. Apply to a copy first.
2. **No handover has been performed.** The clear-then-set ordering, and its
   behaviour when interrupted, are reasoned and tested as a model — not observed.
3. **No conflict has occurred in reality.** The A22 split-brain path is modelled.
4. **`schema-index.json` is best-effort, not `--from-db`.** Re-run
   `build-schema-index.sql` + `--from-db` when the database is reachable; the
   six phantoms are a warning about how far the merge path can be trusted.
5. Nothing on Windows or on a till.

## Deploy order

**Migration 73 → migration 74 → server → tills.** 74 depends on 73's
`device_role`. Registration degrades without them; confirmation simply does not
happen, and credentials stay refused — which is the correct direction.

## Rollback

```bash
git checkout f9d29a8 -- apps/server/src/routes/sync.ts apps/server/src/routes/devices.ts \
  scripts/schema-index.json docs/AUDIT-REGISTER.md
rm -f migrations/74_device_role_confirmation.sql apps/server/src/lib/deviceRole.ts \
  tests/device-role-confirmation.test.mjs
```

Both migrations are additive and safe to leave applied after a code rollback.

---

# Batch 2026-08-10-**d** — CODE · migration 74 fix + a real Postgres harness

Base `f9d29a8`. Cumulative. **Fixes a defect that reached the owner.**

| File | Change |
|---|---|
| `migrations/74_device_role_confirmation.sql` | `DROP VIEW` + `CREATE VIEW` — fixes 42P16 |
| `migrations/73_device_role.sql` | Same, so re-running after 74 does not fail |
| `apps/server/test/migration-73-74.test.mjs` | **NEW**, 17 tests against real Postgres |
| `.github/workflows/ci.yml` | Runs the migrations in CI |
| `docs/AUDIT-REGISTER.md` | A30 closed |

## What went wrong

```
ERROR: 42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
```

`CREATE OR REPLACE VIEW` may only APPEND columns. 74 inserted four before 73's
trailing `is_view_only`, so position 16 changed name.

**It reached you because I listed "the DDL is unexecuted" as a caveat instead of
fixing it.** Writing a risk down is not managing it, and I had the means to
execute it all along.

## The harness found a second bug immediately

Re-running 73 after 74: *"cannot drop columns from view"* — replace cannot drop
columns either. Every migration here is written to be re-runnable, and with only
20 of 66 recording themselves (A4) re-running to be sure is normal practice.
**Neither bug was findable by reading.**

## What the 17 tests actually prove

Not just "it applies". They execute the constraints:

- The CHECK accepts `till`/`node`/`office`, **rejects** `kiosk`, allows NULL.
- The unique index **refuses a second confirmed server** for one branch —
  including an office machine trying to sneak past.
- **Clear-then-set is proved to be the only order the index permits.** That is
  the handover sequence `deviceRole.ts` reasons about, now demonstrated rather
  than argued.
- The view exposes both derived booleans and excludes plain tills.
- Documented consequence, tested not assumed: running 73 **alone** after 74
  reverts the view; re-running 74 restores it.

## What was run

```
migrations under PGlite   17/17    ← real Postgres, in CI from now on
server tsc                OK       desktop main tsc -b   OK
schema-audit --strict     total: 0
all 10 check-*.mjs gates  OK       server 20 suites      OK
```

## Still not verified

1. **PGlite is Postgres, but not YOUR Postgres.** No RLS, no Supabase roles, no
   existing data. It catches syntax, DDL semantics and constraint behaviour — it
   does not catch a policy or a permission.
2. The baseline table in the harness is taken from your 08-09 dump, so a column
   that has since changed would not be reflected.
3. Migrations 68 and 72 are still absent from the repo (A4).

## The part worth keeping

Any migration can now be executed before it reaches a database. **The earlier
migrations in this lineage were never run either** — bringing them under the same
harness is the obvious next hardening.

## Rollback

```bash
git checkout f9d29a8 -- .github/workflows/ci.yml docs/AUDIT-REGISTER.md
# restore the previous 73/74 from batch -c, or drop both migration files
rm -f apps/server/test/migration-73-74.test.mjs
```

---

# Batch 2026-08-10-**e** — A31 · the sixth suite was never wired in

Triggered by the owner's target run. **92 desktop tests green under
`better-sqlite3 under Electron 35.7.5 — REAL driver and ABI`** — the first
hardware-equivalent green in this whole lineage, and it converts a stack of
"could not be verified here" caveats into observed fact.

| File | Change |
|---|---|
| `apps/desktop/package.json` | +`test:failover`, +`test:failover:electron`; both added to `test:desktop` |
| `.github/workflows/ci.yml` | +failover-cursors in `desktop-scope` (stand-in driver) |
| `docs/AUDIT-REGISTER.md` | A31 closed · A9 resolved · changelog |

## What the target run proved

- **held orders** 21/21 — including the legacy-blob import, the one path that
  could destroy open tables. Previously untested on hardware.
- **pinCache** 16/16 — including *"a database copied to ANOTHER machine
  authenticates nobody"*, which only means anything against real DPAPI.
- **tokenStore** 14/14 — including *"a .db copied to another machine falls back
  rather than locking out"*, the D5 concern I raised on day one.

## A31 — and it is A16 repeated inside the batch that closed A16

`failover-cursors.test.mjs` was written, committed, and **never added to
`npm run test:desktop`**. Five suites ran on the target; the sixth was silently
absent. A file in a test directory is not a test.

Fixed the way every other suite is wired. Also in CI on the `node:sqlite`
stand-in — which the suite declares in its own output rather than implying a
real green.

**The gate that would have caught it does not exist.** `check-ipc-parity` exists
because a feature reached every layer except the bridge; the equivalent here
asserts every `apps/desktop/test/*.test.mjs` appears in a package script.
Recorded as the next hardening, not built — it is its own change.

## A9 resolved — the audit number was never one number

- `apps/server`: **6 vulnerabilities, 0 critical**, 3 high — and `nodemailer` is
  a **direct runtime** dependency, not build-chain as guessed.
- `apps/desktop`: **23, 3 critical** — confirmed on the owner's machine. That
  was the desktop workspace all along.

## Two loose ends from the target session

1. **`apps/desktop/package-lock.json`** shows 2 insertions / 2 deletions and did
   not come from any zip. Check `git diff` on it; if unintended,
   `git checkout apps/desktop/package-lock.json` before committing.
2. **The migration harness was run from `apps/desktop`.** It needs the repo
   root — see below. Not a defect.

## Still not verified

Migrations 73 and 74 have run against PGlite, **not against Supabase.** No RLS,
no roles, no existing data. And no order has yet been created through the fixed
`orders.ts` path on a live server.

---

# Batch 2026-08-10-**f** — pglite becomes a real dependency

The migration harness needed `npm i --no-save @electric-sql/pglite` first. A
manual install someone forgets is the same class of mistake as A31 — the suite
exists, and the thing that makes it runnable does not travel with it.

| File | Change |
|---|---|
| `apps/server/package.json` | +`@electric-sql/pglite` **devDependency**, +`test:migrations` script |
| `apps/server/package-lock.json` | Lockfile entry |
| `.github/workflows/ci.yml` | Uses `npm run test:migrations`; the `--no-save` install is gone |

**devDependency, not dependency** — verified: it is absent from `dependencies`,
so Render's runtime install does not pull a WASM Postgres into production.

`npm ci` in `apps/server` now installs it, which CI already does, so the harness
is reachable from a clean checkout with no special knowledge.

## Run it

```bash
cd apps/server && npm install       # once, to pick up pglite
npm run test:migrations             # 17/17
```

Verified here: `17 passed, 0 failed`, `server tsc` clean, CI YAML parses, and
the lockfile carries the entry.

---

# Batch 2026-08-10-**g** — A32/A33 · migration tests consolidated

Supersedes **-e** and **-f**. **Apply this instead of -f** — `-f` put pglite in
`apps/server` and that was the wrong place.

| File | Change |
|---|---|
| `scripts/test-migrations-73-74.mjs` | **MOVED** from `apps/server/test/`; Windows path bug fixed |
| `scripts/test-migration-47.mjs` | Hardcoded sandbox path → resolved. **19 assertions run for the first time** |
| `scripts/run-migration-tests.mjs` | **NEW** — discovers and runs every migration test |
| `package.json` (root) | +`test:migrations`, +`@electric-sql/pglite` devDependency |
| `.github/workflows/ci.yml` | Runs **all seven**, not just mine |
| `apps/desktop/package.json` | `test:failover:electron` wired in (from -e) |
| `docs/AUDIT-REGISTER.md` | A32, A33 closed |
| `apps/server/package.json` + lock | **REVERTED** — pglite belongs at the root |

## Two of my own mistakes, and one that was already there

**A33 — the Windows path bug you hit.** `new URL(import.meta.url).pathname`
gives `/C:/swiftpos/…`; `path.resolve` prepends the drive. Every other script in
this repository already used `fileURLToPath` — mine was the only deviation. The
harness now also **fails immediately with the resolved path** when migrations are
missing, instead of letting 17 assertions fail for their own apparent reasons.

**A32 — I built something that already existed.** This repo has tested
migrations against PGlite since migration 41, with six scripts. I wrote a
seventh somewhere else and claimed migrations "now" run against real Postgres.
A rule 17 miss, in the batch that added rule 17. Moved to `scripts/`, renamed to
match.

**And the reason I could miss it:** none of the six ran in CI, so they were
invisible. **`test-migration-47.mjs` pointed at `/home/claude/out4/migrations/…`
— someone's sandbox — and had never run since the day it was committed.**
Nineteen assertions, none ever executed. Path fixed; 19/19 pass.

## The runner discovers rather than lists

A hand-kept list is one more thing to forget, which is the failure being fixed.
Each test runs in its own process so one crash cannot take the rest, and every
failure is reported rather than stopping at the first.

## What was run

```
npm run test:migrations           7 files, ALL PASS
  test-migration-47      19/19    ← first execution ever
  test-migration-48      14/14
  test-migration-50       9/9
  test-migration-51      11/11
  test-migration-52      11/11
  test-migrations-41-42   pass
  test-migrations-73-74  17/17

server tsc OK · desktop main tsc OK · 10 gates OK
schema-audit total: 0 · 20 server suites OK
```

## Still not verified

**A33's fix cannot be proved from Linux** — `fileURLToPath` is
platform-dependent, so only your machine can confirm it. It is the documented API
for this exact case, but that is an argument, not evidence.

## Run it

```bash
npm install                 # root — picks up pglite
npm run test:migrations     # expect 7 files, all pass
```

---

# Batch 2026-08-10-**h** — runner summary (one file)

| File | Change |
|---|---|
| `scripts/run-migration-tests.mjs` | Read both summary conventions |
| `docs/AUDIT-REGISTER.md` | A32/A33 confirmed on target |

`test-migrations-41-42` prints `PASS` lines and `all green` rather than
`N passed, N failed`, so it showed a **blank** summary. It was passing — 29
assertions, and it exits 1 on failure — but a blank summary is indistinguishable
from a file that asserted nothing, and after `test-migration-47` that is not a
thing a runner should display.

**Now: 7 files, 110 assertions.**

**Runner verified, not assumed.** A deliberately failing file was put through it:
`1 of 8 migration test file(s) failed`, exit 1, full output printed. My first
attempt at this mutation appeared to show the runner swallowing a failure — it
had not; the appended `process.exit(1)` never executed because those scripts exit
first. Worth recording, because the wrong conclusion was one step away.

## Confirmed on target

A33 (the Windows path bug) is fixed — proved on the owner's machine, as it could
only be. Second time in one day that only the target could settle a claim.

---

# Batch 2026-08-10-**i** — A34 · CI #42 desktop-scope fix

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | +3 steps in `desktop-scope`: install shared/printing, install apps/desktop without the Electron binary, build `dist/main` |
| `docs/AUDIT-REGISTER.md` | A34 |

## The failure

```
dist/main not built. Run:  npx tsc -b tsconfig.main.json --force
```

Those three suites import compiled output. `npm run test:desktop` builds first,
which is why they pass on the target. **I added the CI steps and not the build**
— and could not have caught it locally, because locally the build had already
happened.

## Verified from a genuinely clean checkout

Not the working tree. `git archive HEAD` extracted to an empty directory with no
`node_modules`, then the three new steps in order:

```
shared/printing  npm ci --ignore-scripts                 exit 0
apps/desktop     npm ci --ignore-scripts (no Electron)   exit 0
apps/desktop     npx tsc -b tsconfig.main.json --force   exit 0  → dist/main built
  logFile             12 passed
  syncEngine-failures 29 passed
  failover-cursors    12 passed  [node:sqlite stand-in, as declared]
```

**shared/printing is the non-obvious one:** it is a project reference of
`tsconfig.main.json` and declares `"types": ["node"]`, so without its own
`node_modules` the build fails on a missing type definition. It cost a cycle to
find the first time too.

`--ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD` keep this to a
typecheck-sized install; nothing in the job launches Electron.

## What else that run told us

The other **five jobs were green**, including `server-suites` — so the 20 server
suites and all **7 migration files ran on a runner for the first time and
passed**. Only `desktop-scope` failed.

## The pattern

CI is the first environment in this project that starts from nothing. Everything
local benefits from state assembled by hand — which is precisely why A31 (a suite
never wired in) and A32 (six migration tests never run) stayed invisible.
**Expect one or two more of these; each is a real gap, not noise.**

---

# Batch 2026-08-10-**j** — A35 · the secret scan had never scanned a PR

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | `permissions: {contents: read, pull-requests: read}` on the `secrets` job; `.env` assertion moved before gitleaks |
| `docs/AUDIT-REGISTER.md` | A35 |

## Not a code failure — a gate that had never been exercised

```
403 Resource not accessible by integration   .../pulls/2/commits
x-accepted-github-permissions: pull_requests=read
```

The workflow declared **no `permissions` block anywhere**, so it inherited the
repository read-only default. `gitleaks-action` needs `pull-requests: read` to
list a PR's commits, and crashed **before scanning anything**.

**Every earlier run was a `push` event, where it never touches the API.** Forty-odd
green ticks, and on the one event type that gates a merge to `main` it had never
worked. A1 was a leaked service-role key; this is the gate that exists because
of it.

## The second half, from the same log

gitleaks ran FIRST and the `.env` assertion second — so when gitleaks crashed,
the job stopped and **one infrastructure fault skipped both secret gates.** The
`.env` check needs no action, no API and no network. It now runs first.

## Verified

```
YAML parses · permissions on `secrets` only, other five jobs unchanged
step order: checkout → .env assertion → gitleaks
.env assertion run locally: "No tracked .env files."
```

## Everything else on CI #44 was green

Type-check, Build, Schema drift, Server suites, **and Desktop row scope** — so
batch `-i`'s build fix worked on the runner.

## Third time today

A check passing for the wrong reason: `test-migration-47` had never run (A32),
`failover-cursors` was never invoked (A31), and now a secret scan that had never
scanned a PR. All three looked like coverage.

---

# Batch 2026-08-10-**k** — D14 measured in production (docs only, NO ZIP per rule 18)

| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | D14 gains the production measurement |

## The before-shot, taken 2026-08-10 ahead of the merge

```
select count(*) from public.user_devices;              ->  0
... where business_id = '<beryl>';                     ->  0
... where key = 'require_device_registration';
   Lovers Rock | require_device_registration | false      (one row, all tenants)
```

**Zero registered devices across the entire fleet.** Ten businesses, seven of
them non-test. One flag row anywhere, set to false.

## This was never a Beryl problem

Device registration has never run for **any** tenant. Everything downstream has
been dead code in production since it was written:

- `lib/deviceBinding.ts` — 181 lines, never executed
- `routes/devices.ts` — 216 lines, mounted and always empty
- migration 43 telemetry — `app_version`, `schema_version`, `last_sync_at`
  never written for any till, which is why every diagnosis needed somebody at
  the machine
- migration 52 branch binding — inert everywhere; a relocated till has been
  undetectable this whole time

## The lesson is not "turn the flag on"

A subsystem with no observable output cannot tell you it is idle. **Nothing
anywhere reported an empty fleet as unusual** — no dashboard warning, no log
line, no gate. The register listed D14 as "the till is not registered," which
read as one client's misconfiguration. It was the whole fleet, for the entire
life of the feature.

Same shape as A31, A32 and A35: something that looked like coverage and was not.
This one just had a much larger blast radius.

## After the merge

Re-run the same three queries. 0 → 1 for Beryl is the test.

---

# Batch 2026-08-10-**l** — A36 (P0) · one word, four dead features

| File | Change |
|---|---|
| `apps/server/src/routes/auth.ts` | `/desktop-login` mints `surface: 'desktop'`, not `'web'` |
| `tests/auth-surface.test.mjs` | **NEW**, 10 tests, mutation-checked |
| `docs/AUDIT-REGISTER.md` | A36 closed · A37 opened |

## The bug

`/desktop-login` set `surface: 'web'`. **The header of the same file has said
`surface='desktop'` since the route was written.** Nothing compared them.

`/verify-pin` issues `surface: req.surface ?? 'web'`, so it propagated into every
staff token. Four things were then false, and silence is what a false branch
produces:

| What broke | Where |
|---|---|
| `offlineAuth` never sent → `staff_pin_cache` EMPTY | `auth.ts:1356` |
| Desktop registration (D14) never ran → `user_devices` empty fleet-wide | `auth.ts:1304` |
| `desktop_licensed` gate never fired — tills traded unlicensed | `pos.ts:87`, `auth.ts:1174` |
| `requireWebSurface` bypassed | `middleware/auth.ts:225` |

**D16 — offline sign-in, a full session on 2026-08-08, 16 passing pinCache tests
— has never worked on a real till.** Measured today: two PINs entered online,
`select count(*) from staff_pin_cache` = **0**. The tests were right, the client
was right; the server withheld the hash.

## Checked before shipping, because this turns dormant gates ON

- **`requireWebSurface`** guards `/api/reports*` only, and `grep` confirms the
  till never calls them. Owners are exempt anyway (`req.isOwner ||`).
- **`desktop_licensed`** — Beryl's Main Branch is licensed since 2026-07-25, so
  the gate passes. **On an unlicensed branch this fix returns 403 and kills the
  catalogue pull.** Check `desktop_licensed` before deploying anywhere else.

## Why the test reads source text

The bug was one word in a literal. A unit test asserting
`payload.surface === 'desktop'` against a stub proves the stub. This reads the
shipped file — the same approach `test-office-role.mjs` uses — and additionally
asserts **the header and the code agree**, which is the exact comparison nobody
was making.

## What was run

```
server tsc OK · desktop main tsc OK · 10 gates OK · schema-audit total: 0
7 migration files OK · 21 server suites OK (was 20)
tests/auth-surface.test.mjs                          10/10
```

**Mutation check:** reinstated `surface: 'web'` → exit 1, 3 failures naming the
consequence. Restored → exit 0.

## Still open

**A37** — `/pos-login` takes `surface` from the request body and gates the
licence on it, so a client sending `surface: 'web'` skips the desktop licence
check. Recorded, not changed: the legitimate web POS uses that path.

## After deploying

1. Owner signs out and back in — **required**, the current token still says
   `web`. "Lock till" is not enough this time; the owner token must be re-minted.
2. Then a PIN sign-in, and check both:

```sql
select count(*) from public.user_devices
where business_id = 'b5096e81-8a8d-4316-97d5-9e6a4bd91751';   -- expect 1
```
```sql
-- on the till
select count(*) from staff_pin_cache;                          -- expect >= 1
```

---

# Batch 2026-08-10-**m** — A38 · the device id header was sent twice

| File | Change |
|---|---|
| `apps/desktop/src/main/syncEngine.ts` | One spelling of the device id header in both builders |
| `apps/server/src/lib/terminalKey.ts` | **NEW** `deviceIdFromRequest()` — takes the first comma-separated value |
| `apps/server/src/routes/sync.ts` | Uses it; split before the length cap |
| `apps/server/src/routes/orders.ts` | Uses it |
| `apps/server/src/routes/shifts.ts` | Uses it |
| `tests/device-id-header.test.mjs` | **NEW**, 10 tests, both halves mutation-checked |
| `docs/AUDIT-REGISTER.md` | A38 |

## Found in your Render log, not by reading

```
[fleet] no user_devices row for device
  24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
```

`pushAuthHeaders()` declared both `'x-device-id'` and `'X-Device-Id'`. Header
names are case-insensitive to HTTP but not to an object literal, so fetch sent
the pair and the server got them comma-joined — then sliced the joined string.

**I saw this duplicate earlier today and called it harmless.** It was not.

## Why the server fix matters more than the client fix

`terminalKeyFromRequest` feeds migration 63's one-open-drawer-per-terminal unique
index. A till updated **mid-shift** would switch from the joined value to the
single one, resolve to a different terminal key, and be allowed a **second open
drawer against the same physical till**.

Normalising on the server means an old build and a new one produce the same key,
so the transition is invisible to that index. The test asserts exactly that.

## The empty fleet had THREE causes

1. `require_device_registration` opt-in never enabled (D14)
2. `/desktop-login` minting `surface: 'web'` (A36)
3. this

Fixing any one alone changes nothing visible — which is why the first two
appeared to do nothing.

## What was run

```
server tsc OK · desktop main tsc OK · 10 gates OK · schema-audit total: 0
7 migration files OK · 22 server suites OK (was 21)
tests/device-id-header.test.mjs   10/10
```

Mutation: split removed → exit 1. Duplicate key restored → exit 1. Both back → 0.

## Still to do on the server

`fca625f` (A36) is pushed to `dev` but **the last Render deploy in the log is
13:51 UTC**, before it. Check Render → Events; if auto-deploy is off, trigger it.
Nothing registers until that build is live.

---

# Batch 2026-08-10-**n** — rule 21 + PHASE6 design (docs only, NO ZIP per rule 18)

| File | Change |
|---|---|
| `docs/HANDOFF-2026-08-08-evening.md` | **+rule 21** — say node or cloud, never "server" |
| `docs/PHASE6-BRANCH-SETTINGS.md` | **NEW** — branch-local settings owned by the node |
| `docs/AUDIT-REGISTER.md` | Rule 21 note · A24 first payload |

## Rule 21

Two machines answer to "the server", which cost an afternoon today. The
vocabulary is not new — `device_role` has been `'till' | 'node' | 'office'` since
Phase 3, and "the node" (105 uses) and "the cloud" (47) already outnumber every
alternative. What is new is banning the ambiguous word.

**`getServerUrl()` returns the CLOUD url** — the most misleading name in the tree,
and the one that produced a wrong diagnosis today. Rename to `getCloudUrl()`; the
`device_config.server_url` column keeps its name because renaming a local-schema
column is what D6 warns about.

## PHASE6 — what the sweep found

Two exclusion mechanisms exist and **neither is branch-local**:

- `business_settings.kitchen_exclusions` — cloud, edited on the web, feeds the
  **ESC/POS thermal** path
- per-till `localStorage` — never syncs, feeds the **HTML fallback** path

The two print paths read different lists from different places, and the one a
manager can edit at the till is the one with no reach.

**`business_settings` has no `branch_id`.** A two-branch business changing
exclusions for one branch changes both — and the Receipt screen states this as
though it were reassurance.

**`branch_prices` is the precedent**: it exists because prices differ per branch,
resolved by COALESCE. PHASE6 applies that same shape, including `updated_by`
('node' | 'cloud') for collision detection.

## One correction recorded

I argued earlier that receipt text should stay owner-only because of the KRA PIN.
Wrong: `etims_branch_config` already carries a per-branch `bhf_id`, so KRA itself
treats branches as distinct, and address/phone are branch facts. Per-branch
receipt text is correct. Only the PIN line stays owner-gated.

## Decisions still needed

1. **Two writers, one value** (§8) — manager at the till vs owner in the
   dashboard while the node is offline. Proposal is last-write-wins on
   `updated_at`, matching `branch_prices`; the consequence is that an offline
   node's edit **can be overwritten** by a later cloud edit on reconnect.
2. Sequencing (§9) — after 0.5.26 has traded a day. The till should not carry two
   unproven changes into one service.

No code in this batch.

---

# Batch 2026-08-10-**o** — A39 · the missing design (docs only, NO ZIP)

| File | Change |
|---|---|
| `docs/BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` | **ADDED** — supplied by the owner; six source files cite it and it was in neither the repo nor its history |
| `docs/PHASE6-BRANCH-SETTINGS.md` | Reconciled — it is an APPLICATION of that design, not a new one |
| `docs/AUDIT-REGISTER.md` | A39 |

## The finding

Six files cite this document **by section**. It was nowhere in the tree. The
citations make it look present, so anyone on a clone reads *"See
BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6"* and finds nothing — and the reasoning
behind `branch_prices`, the effective-price COALESCE and the `updated_by` stamp
is invisible.

**It is the design for most of what this register has been rediscovering.** Its
own status line: *"agreed design, not yet implemented."*

- **A19** (a peer's sales never reach the cloud) = its §1 and §3
- **A24** (reference data goes stale) = its §1, "edits flow DOWN"
- **PHASE5 §4** (offline sign-in) = its §2, "PIN login must also be local"
- **PHASE6** = its §1 applied to settings

`syncEngine.ts:1138-1151` records a deliberate move away from §1/§3 for a sound
engineering reason and with no sign of knowing a design said otherwise. That is
what an untracked specification produces.

## Two open questions it answered

**Two writers** — §5 is better than what PHASE6 proposed and is adopted verbatim:
newest-wins applied immediately, **notify only on a TRUE collision** (both sides
edited since they last agreed), confirm/reject, audit log. The refinement matters:
notifying on plain mismatch would raise a false alarm on every ordinary branch
edit.

**The locked-portal worry was unfounded**, and elegantly so. §4: when web access
lapses the portal is locked, so head office cannot write — one writer remains.
*"A lapse produces zero conflicts."* Nothing accumulates that an unlicensed
business could not resolve.

## One divergence recorded

§1 says *"tills never edit reference data."* The owner wants a manager editing at
the branch. Compatible **only if the manager edits on the NODE** — editing from a
peer would add a second writer inside the branch and lose the one-writer property.
The Printers tab is editable on the node; a peer shows it read-only. Stated in
PHASE6 §8b so it is a designed constraint rather than a surprise.

## Suggested gate, not built

No source comment should cite a `.md` that does not exist in the tree. Cheap,
and it would have caught this the day the citation was written. Alongside A31's
"every test file appears in a package script".

---

# Batch 2026-08-10-**p** — CODE · the cited-documents gate

| File | Change |
|---|---|
| `scripts/check-doc-refs.mjs` | **NEW** — every cited document must exist |
| `.github/workflows/ci.yml` | Runs it in `desktop-scope` |
| `docs/BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` | Added (from batch -o) |
| `docs/AUDIT-REGISTER.md` | A39 updated with the gate and the full missing list |

## What the gate found

More than a manual grep did. **Three of your own documents are cited and absent:**

| Missing | Cited by |
|---|---|
| `DESKTOP_DESIGN.md` | `migrations/18_web_access_remodel.sql:4` **and BRANCH_AUTHORITY itself at :3, :28, :157** |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `apps/server/src/lib/etims/provider.ts:4`, citing §2 |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |

**`DESKTOP_DESIGN.md` blocks PHASE6.** BRANCH_AUTHORITY opens *"Companion to
DESKTOP_DESIGN.md"* and §1 widens the node role *"from DESKTOP_DESIGN.md"*.
Building against BRANCH_AUTHORITY without it is building against half a spec.

## Two design decisions in the gate

- **`docs/history/` is excluded from scanning.** A past handoff naming a
  since-deleted document is an accurate record of what happened; rewriting
  history to satisfy a gate would be the wrong fix. But documents living there
  still count as **present**, so a live doc citing an archived handoff passes.
- **It skips its own file.** A gate that fails on its own documentation trains
  people to ignore it.

## THE GATE IS CURRENTLY RED

Deliberately. It reports a real gap. Add the three documents to `docs/` and it
goes green; after that, the next dangling citation fails the build the day it is
written.

## What was run

```
check-doc-refs: 89 citations across 492 files → 3 missing (exit 1, as intended)
server tsc OK · desktop main tsc OK · 5 gates OK
7 migration files OK · 22 server suites OK
```

---

# Batch 2026-08-10-**p** — cumulative · everything uncommitted since `fca625f`

Base `f9d29a8`. **Supersedes every earlier batch in this file.** Extract at the
repo root; `git status --short` should then show 18 modified and 18 new.

## New since the last code zip (-m)

| File | Change |
|---|---|
| `scripts/check-doc-refs.mjs` | **NEW**, in CI — a comment must not cite a `.md` that is not in the tree (A39) |
| `docs/BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` | **ADDED** — cited by 8 places, was in neither the repo nor its history |
| `docs/PHASE6-BRANCH-SETTINGS.md` | **NEW** — reconciled as an *application* of BRANCH_AUTHORITY, not a new design |
| `docs/HANDOFF-2026-08-08-evening.md` | **+rule 21** — say node or cloud, never "server" |
| `docs/AUDIT-REGISTER.md` | A39 · rule 21 · A24 first payload |

## Three documents still missing — please add before PHASE6 is built

`check-doc-refs` found more than a manual grep did:

| Missing | Cited by |
|---|---|
| **`DESKTOP_DESIGN.md`** | `migrations/18_web_access_remodel.sql:4`, and **BRANCH_AUTHORITY itself at :3, :28, :157** |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `apps/server/src/lib/etims/provider.ts:4`, citing §2 |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |

**`DESKTOP_DESIGN.md` blocks PHASE6.** BRANCH_AUTHORITY opens *"Companion to
DESKTOP_DESIGN.md"* and widens the node role *"from DESKTOP_DESIGN.md"*. Building
against BRANCH_AUTHORITY without it is building against half a specification —
which is the mistake A39 exists to prevent.

`Something.md` in the gate's output is a false positive from prose in the
register. Allowlist it or reword the line.

## A rule 17 failure of my own, recorded

I proposed building a doc-citation gate — and `scripts/check-doc-refs.mjs`
already existed, **written earlier in this same session**, in CI, its header
citing A39. In a session this long I lost track of my own work and broke rule 17
against it. The register entry was already there too.

## What was run

```
server tsc OK · desktop main tsc -b OK · schema-audit total: 0
check-supabase-catch · check-own-rows · check-ipc-parity · check-schema-drift  OK
check-doc-refs        reports 3 missing documents (working as intended)
7 migration files OK · 22 server suites OK
```

## Still not verified

- Migrations 73 and 74 have run against **PGlite, not Supabase** — no RLS, no
  roles, no existing data.
- No till has performed a **failover**; A21's reset is exercised only by tests.
- The **client half of A38** ships with 0.5.26; until then the server-side
  normaliser carries it.
- **`device_role` is NULL** on the registered terminal until 0.5.26.

## Rollback

```bash
git checkout f9d29a8 -- .github/workflows/ci.yml apps/desktop/package.json \
  apps/desktop/src/main apps/server/src/lib/terminalKey.ts apps/server/src/routes \
  docs/AUDIT-REGISTER.md docs/HANDOFF-2026-08-08-evening.md package.json \
  scripts/schema-index.json scripts/test-migration-47.mjs
rm -f migrations/73_device_role.sql migrations/74_device_role_confirmation.sql \
  apps/server/src/lib/deviceRegistry.ts apps/server/src/lib/deviceRole.ts \
  apps/server/src/lib/orderErrors.ts apps/desktop/test/failover-cursors.test.mjs \
  scripts/check-doc-refs.mjs scripts/run-migration-tests.mjs \
  scripts/test-migrations-73-74.mjs tests/auth-surface.test.mjs \
  tests/device-id-header.test.mjs tests/device-registration.test.mjs \
  tests/device-role-confirmation.test.mjs tests/order-error-classification.test.mjs
```

Both migrations are additive and safe to leave applied after a code rollback.

---

# Batch 2026-08-10-**q** — the lost design, and two gates

| File | Change |
|---|---|
| `docs/DESKTOP_DESIGN.md` | **NEW** — records the original as lost and maps each citation to the code |
| `scripts/check-header-keys.mjs` | **NEW**, in CI — one header, one key (A38) |
| `scripts/check-test-registration.mjs` | **NEW**, in CI — every test file is invoked (A31, A32) |
| `scripts/check-doc-refs.mjs` | Allowlist the `Something.md` placeholder |
| `.github/workflows/ci.yml` | Both gates in `desktop-scope` |
| `docs/AUDIT-REGISTER.md` | A40, A41 |

## DESKTOP_DESIGN.md — lost, and recorded as lost

Nothing reconstructed. Every line is a direct quotation from a surviving citation
or a pointer to code that implements it. A plausible reconstruction would be
worse than an honest gap: the next reader could not tell which parts were real.

**PHASE6 is unblocked.** The parts it depends on — the two-products model, the
node role — are implemented and readable. What is lost is the reasoning.

## Both gates caught defects in their own first versions

**`check-header-keys`** silently missed the very bug it was written for. Its
literal-matching regex refused nested braces, so any headers bag containing
`` `Bearer ${token}` `` was skipped — every one that matters. It scanned 23
literals, printed OK, and **passed its mutation test by not looking**. Now
interpolations are blanked, length-preserving so line numbers stay true, and it
names `syncEngine.ts:79` exactly.

**`check-test-registration`** reported **22 false positives** — files a CI shell
glob runs perfectly well. Fixed before shipping. A gate that cries wolf gets
switched off, which is worse than no gate.

Both are recorded because they are the same failure as A31 and A32 at one remove:
a check that looks like coverage and is not.

## What was run

```
server tsc OK · desktop main tsc OK · renderer tsc OK · vite build OK
13 gates: 12 OK, check-doc-refs correctly RED on two genuinely missing documents
schema-audit total: 0 · 7 migration files OK · 22 server suites OK
```

Mutations, both ways:
- reinstate the duplicate header key → `check-header-keys` exit 1, names file and line
- unwire `test:failover:electron` → `check-test-registration` exit 1, names the orphan

## Two documents you still need

| Missing | Cited by |
|---|---|
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `apps/server/src/lib/etims/provider.ts:4`, citing §2 |

`check-doc-refs` stays red until they are added or the references removed. That
is the gate working, not a failure.

## The seam still without a gate

§L: an IPC channel whose two sides disagree about the **payload shape**.
`check-ipc-parity` proves a channel exists, not that its arguments agree — P-09
and P-11 both came through it. That is the next one worth building.

---

# Batch 2026-08-10-**r** — 0.5.27 · the HTML sale path removed, D8 closed

| File | Change |
|---|---|
| `apps/desktop/src/renderer/pages/POSPage.tsx` | Thermal is the only sale path; 76-line HTML branch and the D8 early return removed; skipped stations surfaced |
| `apps/desktop/src/main/ipcHandlers.ts` | `queueThermal` returns `{ skipped }`; new `escpos:kitchenExclusions` |
| `apps/desktop/src/main/escposBridge.ts` | `kitchenExclusions()` exported |
| `apps/desktop/src/main/preload.ts` · `renderer/lib/posApi.ts` | Both channels bridged and typed |
| `apps/desktop/src/renderer/pages/PrintersTab.tsx` | Preview and test print use the LIVE list; the box is read-only |
| `apps/desktop/src/main/localDb.ts` | `escpos_enabled` defaults **1**, plus a guarded one-time backfill |
| `apps/desktop/src/renderer/hooks/usePrinterSettings.ts` | `kitchenExcludeTerms` deprecated |
| `docs/AUDIT-REGISTER.md` | D8 closed |

## The sweep changed the scope, again

"Delete the four HTML modules" would have removed three things nobody has
replaced:

- **Shift and Z-reports.** `escposBridge` exports exactly ONE print function —
  `printSale`. There is no thermal shift report. Closing a drawer would have
  produced nothing.
- **Printer calibration.** `buildCalibrationTicket` is how paper width is
  detected.
- **Test prints and previews** on the Printers tab.

All three kept. What went is the duplicated live-sale branch — 76 lines — and
the early return that WAS D8.

## D8 closed by reporting, not by routing around it

`printSale` has always returned `{ queued, skipped }` and **every caller threw
`skipped` away**. A station with no printer bound was skipped in silence. It now
reaches the cashier: *"Sent 3 items, but nothing printed for: Dispatch"*.

With no fallback there is no second system to catch it, so silence stopped being
survivable.

## Two changes that could have bitten

**`escpos_enabled` defaulted to 0.** Correct while HTML was the fallback;
dangerous now — OFF stopped meaning "print the old way" and started meaning print
nothing. Default flipped, plus a guarded one-time backfill in `maintenance_state`
for tills already holding 0. **Verified against a real SQLite database:** runs
once, and a manager who later turns it off deliberately is not overridden on the
next boot.

**The preview lied.** The Printers tab previewed from per-till localStorage while
the printer used the server-synced list. New `escpos:kitchenExclusions` IPC; the
box is read-only and shows what will actually happen. A control that looks
editable and changes nothing is worse than no control.

## What was run

```
server tsc OK · desktop main tsc OK · renderer tsc OK · vite build OK
12 gates OK (incl. check-ipc-parity 132/132 after the new channel)
test-print-resilience 51 · test-office-role · test-node-ingest · test-events  OK
7 migration files OK · 22 server suites OK
backfill verified against real SQLite: idempotent, respects a deliberate off
```

## Not done, deliberately

**A thermal shift report.** New code, not removal. Deleting the HTML one would
leave the manager screen with nothing. Its own release.

## Before shipping 0.5.27

The till has **no fallback** now. Worth one service watching that dispatch slips
still appear — and if a station is unbound, the cashier should see it named.

---

# Batch 2026-08-10-**s** — the toggle label, and two findings from the till

| File | Change |
|---|---|
| `apps/desktop/src/renderer/screens/PrinterSetupScreen.tsx` | The OFF label no longer reassures |
| `docs/AUDIT-REGISTER.md` | A42 closed · A43 open · A44 closed |

## A42 — the label lied in the most dangerous direction

*"Off. Sales still print the old way; nothing on this screen affects them yet."*
True with the HTML fallback. **From 0.5.27 it means nothing prints at all.**

Now **"OFF — nothing will print. Turn this on before trading."** in amber. Found
because the owner unticked it on a live till and the screen said everything was
fine.

**The backfill is confirmed correct on real hardware.** Marker
`escpos_default_on_0527 = applied` at 12:49:43, column set to 1, and it did NOT
override the owner's later deliberate untick — exactly the property verified
against SQLite before shipping. No bug; the tick had been removed by hand.

## A43 — I built 0.5.27's exclusions box on a screen nobody renders

`ManagerPage.tsx:1116`: *"PrinterSetupScreen supersedes PrintersTab…
PrintersTab.tsx remains in the tree"*. My read-only box, the live-list preview
and the renderer wiring all went into `PrintersTab`. **Unreachable.**

A rule 17 failure of the exact shape the rule names: the file existed, and I
never checked that it renders. The IPC channel and main-process half are live and
correct — only the renderer half is orphaned.

**Not ported across, deliberately.** `PrinterSetupScreen` is station-oriented,
which is the natural home for **per-station** exclusions (PHASE6 §4,
`print_stations.exclude_terms`) rather than a global card bolted onto a
per-station layout. Exclusions stay on the web dashboard until then.

**`PrintersTab.tsx` can now be deleted** — thermal is proven, which was the
condition its retention was gated on. Its own change.

## A44 — adding a station already exists

Web dashboard → **Settings → Stations**. Create, edit, delete, category routing.
`routes/stations.ts` has the endpoints behind `products.manage`. The page header
reads *"A client wanting a 'Barista' station tomorrow meant a code change"* and
the New station placeholder is literally **"Barista"**.

`kind` is constrained to `kitchen | dispatch | receipt`. A Barista station is a
new station NAMED Barista with kind `kitchen` — kind decides behaviour and ticket
layout, the name is what staff call it. It reaches the till on the next catalogue
sync, where a printer is bound.

Nothing to build. Recorded because it is not discoverable from the desktop, which
shows stations but cannot create them.

## What was run

```
renderer tsc OK · main tsc OK · vite build OK
check-ipc-parity · check-header-keys · check-test-registration · check-client-parity  OK
test-print-resilience 51 passed
```

---

# Batch 2026-08-10-**t** — PHASE6 §8c, stations at the branch (docs only, NO ZIP)

| File | Change |
|---|---|
| `docs/PHASE6-BRANCH-SETTINGS.md` | **+§8c** — stations created at the branch, backed up, visible to the owner |
| `docs/AUDIT-REGISTER.md` | A44 extended |

## Why this is PHASE6 and not its own feature

`print_stations` already syncs **downward** to the till. What is missing is the
**write** path and the upward sync — the same `/node/settings` channel per-station
exclusions need. Station creation and exclusions are the same screen, the same
storage, the same sync. **Apart, that sync gets built twice.**

## The licence argument, sharper than for settings

A branch at `locked` cannot open the portal, so today it cannot create a station
at all. A shop that builds a coffee counter would have to renew a *web*
subscription to tell its own till about it. A locked portal blocking a price edit
is annoying; blocking a new counter means a section of the shop cannot open.

## Not behind the tech screen

Tech access needs a reveal code and a signed token, both issued by the admin
portal — the thing that is locked. That routes around a closed door with a key
kept behind it. It is also the wrong shape: tech access is for diagnosing a
machine, not for a manager adding a counter they just built.

**Manager, `products.manage`** — the same permission the dashboard already uses.

## Backed up and visible

Owner: *"so that the owner can tell what is happening on the ground; changes
should be backed up and visible on the manager's dashboard."*

Node authoritative for the branch, cloud the durable copy, dashboard reads it.
A station created at the branch that head office never touched is not a conflict
and syncs silently (BRANCH_AUTHORITY §5).

---

# Batch 2026-08-10-**u** — permissions (docs only, NO ZIP)

| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | A45 open · A46 open |

## A45 — the Receipt tab promises what the server refuses

`ManagerPage.tsx:1083` shows the tab on `isManagerRole`. `business.ts:110`
requires `settings.manage`. Two gates, one action, no comparator — **§L's seam,
this time in permissions.** The manager finds out after typing.

## A46 — measured, and it supports the owner's instinct

**`settings.manage` gates 16 routes across 6 files**, from receipt text to
**KRA fiscal registration** and **revoking a till**. To let a manager type a
branch phone number you must also grant both of those.

`products.manage` is worse by volume — **29 routes** — and includes station
create/delete, which PHASE6 §8c moves to the branch anyway.

Seven-key split proposed in the register. **Every key additive**: a role holding
`settings.manage` today keeps everything. The machinery already exists —
`permissions`, `role_permissions`, `permissions_version` forcing token refresh,
migration 59 backfilling defaults. This is seeding rows and re-pointing gates,
not new infrastructure.

## Sequence, and why the order matters

**Comparator first.** A45 exists because a UI gate and a server gate drifted with
nothing comparing them. Splitting 45 gates before building that comparator would
let them drift again *while being changed* — the worst possible moment.

1. Gate: every permission-gated route has a UI gate naming the same key
2. Split the permissions
3. Re-point the UI gates

That comparator would be the fourth, after `check-ipc-parity`,
`check-header-keys` and `check-doc-refs`. Same seam, fourth instance today.

## Tonight's unblock

Grant the role `settings.manage` on the dashboard, or edit the receipt as the
owner — **knowing it also grants eTIMS registration and till revocation** until
A46 lands.

---

# Batch 2026-08-10-**v** — rules 22 and 23 (docs only, NO ZIP)

Checking that the session's rules had actually been written down surfaced two
that were recorded only as findings. Both cost real time today.

| File | Change |
|---|---|
| `docs/HANDOFF-2026-08-08-evening.md` | **+rules 22, 23** |
| `docs/AUDIT-REGISTER.md` · `docs/HANDOFF-2026-08-10.md` | Pointers updated |

**22 — a delivery zip carries the change, never the version.**
`apps/desktop/package.json` rode along at 0.5.25 and overwrote a 0.5.26 bump
already built. The next `release:patch` produced **a second, different binary
with the same version number**, and the first was already on a till.

**23 — mutation-check the GATE, not only the fix.** Extends rule 10. Both gates
written today failed their own first version, and `check-header-keys` failed
**silently**: its regex refused nested braces, so every headers bag containing
`` `Bearer ${token}` `` was skipped. It scanned 23 literals, printed OK, and
passed its mutation test by not looking.

Rules 1-16 verified intact — 17-23 append rather than renumber, because 9, 10,
14 and 15 are cited by ID throughout the register.
