# MANIFEST — 2026-08-11-e

**Supersedes `-a` … `-d`. Cumulative — apply this one only** (rule 3).
**Base:** `0215475` (`dev`) · **No `version` field touched** (rule 22).
**No desktop file touched** — no version bump due (rule 15).

**MIGRATIONS 75, 76 AND 77 MUST BE RUN, IN THAT ORDER.** 75 ships corrected in
this batch (see A61) — if you already ran the `-c`/`-d` copy, run it again; it is
idempotent and the corrected version grants rows the first one missed.

Five items closed: **A55 · A60 · A61 · A7**, and **A53** ratcheted.

| File | Change |
|---|---|
| `migrations/77_increment_customer_spend.sql` | **NEW** — A55. `increment_customer_spend`, `adjust_customer_visits`. |
| `migrations/76_role_name_grant_backfill.sql` | **NEW** — A61. Backfills grants 24/49/75 missed. |
| `migrations/75_permission_registry.sql` | **CORRECTED** — A61 at source. Role-name match normalised. |
| `apps/server/src/routes/orders.ts` | A55. Three racy `total_spent` writes → RPCs; void path fully atomic. |
| `scripts/test-migration-77.mjs` | **NEW** — 13 assertions; §2 *runs* the race. |
| `scripts/check-register-consistency.mjs` | **NEW** — A60 + A53 ratchet. |
| `scripts/register-orphan-baseline.json` | **NEW** — `{orphans: 21}` |
| `scripts/check-schema-drift.mjs` | Self-clearing pending declaration (see below). |
| `scripts/schema-pending.json` | **NEW** — declares 77 as written-but-not-run. |
| `docs/AUDIT-REGISTER.md` | A55/A60/A61 entries · A7 closed · A53 ratcheted · **ten duplicate IDs merged** · header re-derived. |
| `README.md` | A7. Business-type table corrected; accuracy note added. |
| `.github/workflows/ci.yml` | New gate step. |
| *(from `-d`, unchanged)* | `business.ts` · `rbac.ts` · `devices/tables/etims.ts` · `mailer.ts` · `check-permission-parity` + baseline · `test-migration-75` · both test suites |

## Rollback

```
git checkout 0215475 -- apps/server/src/routes/orders.ts README.md \
  scripts/check-schema-drift.mjs docs/AUDIT-REGISTER.md .github/workflows/ci.yml \
  apps/server/src/routes/business.ts apps/server/src/middleware/rbac.ts \
  apps/server/src/routes/devices.ts apps/server/src/routes/tables.ts \
  apps/server/src/routes/etims.ts apps/server/src/lib/mailer.ts \
  tests/mailer-transport.test.mjs
rm scripts/check-register-consistency.mjs scripts/register-orphan-baseline.json \
   scripts/schema-pending.json scripts/test-migration-77.mjs \
   scripts/check-permission-parity.mjs scripts/permission-parity-baseline.json \
   scripts/test-migration-75.mjs tests/receipt-permission.test.mjs \
   migrations/7[567]_*.sql docs/MANIFEST-2026-08-11-*.md
```

All three migrations are additive — no drops, no renames, all idempotent.

## What was run, and what it printed (rule 7)

Environment: **Linux, Node 22.22.2.** No desktop, SQLite or Electron code
touched, so the platform gap does not weaken these greens (rule 9).

```
check-register-consistency OK (new)   check-own-rows           OK
check-permission-parity    OK         check-sql-binds          OK
check-schema-drift         OK         check-row-attribution    OK
check-ipc-parity           OK         check-table-usage        OK
check-header-keys          OK         check-rls-coverage       OK
check-test-registration    OK         check-supabase-catch     OK
check-shared-sync          OK         check-auth-retry         OK
check-client-parity        OK

check-doc-refs             RED — PRE-EXISTING (BRANCH-SERVER-PLAN.md,
                           SESSION-HANDOFF-2026-08-02.md). Red before this
                           batch and after it. Not touched, not masked.

run-migration-tests        All 9 migration test file(s) passed
  test-migration-77          13 passed, 0 failed   <- new
receipt-permission         21 passed, 0 failed
mailer-transport           26 passed, 0 failed
server tsc                 OK
typecheck-ratchet          server 0, dashboard 0 — baseline held
```

## Mutation checks (rules 10, 23) — each confirmed applied first

| # | Defect introduced | Result |
|---|---|---|
| R1 | Duplicate a register entry | RED — *A17 2 entries — CONTRADICTORY: OPEN and CLOSED* |
| R2 | Fudge a header count to `0 P0` | RED — *header says 0, body has 1* (the original bug, reproduced) |
| R3 | Cite `audit Z9`, an ID nothing defines | RED — *ORPHAN AUDIT CITATIONS ROSE: 21 -> 22* |
| P1 | Declare a migration pending whose functions ARE live | RED — *stale, and is now suppressing real signature checks* |
| P2 | Declare a pending file with no `CREATE FUNCTION` | RED — *declares no functions* |

**A55 is not mutation-checked — it is raced.** `test-migration-77.mjs` §2 runs
the OLD read-modify-write shape and shows it banking 100 + 250 and recording
**250**, then runs the new form under the same interleaving and shows 350, then
lands twenty concurrent increments. An assertion that only read the SQL would
have passed against the racy version, which is the failure this repo keeps finding.

## THE GATE CAUGHT ME TWICE WHILE I WAS USING IT

1. **`check-register-consistency` failed on my own edit.** Closing A7 and A53
   without updating the header counts is the identical defect it was written for,
   caught within minutes of writing it.
2. **`check-schema-drift` correctly went red on migration 77.** See below.

## The schema-drift decision, which is the one to scrutinise

Migration 77 is written but not run, so the gate said its functions are missing
from the database. **That is true, and the gate is right.**

**I did not refresh `schema-index.json` to make it green.** That would claim
production has functions it does not — the A49 shape, a false claim in the exact
position where a false claim silences a check. Instead `scripts/schema-pending.json`
declares the window, and is **deliberately self-clearing**: the moment those
functions appear in the snapshot, the stale entry FAILS the gate until deleted
(mutation P1). An entry naming a file with no `CREATE FUNCTION` also fails (P2).
So a declaration buys the deploy window and nothing else.

Getting there took a mistake worth recording: my first version used bare
`readFileSync` in a script that uses `fs.` / `path.` namespaces, so it threw and
the `catch {}` swallowed it — the gate stayed red and told me nothing about why.

**After you run 77, refresh `schema-index.json` from the live database and delete
the entry from `schema-pending.json`.** The gate will tell you if you forget.

## What only you can verify (rule 16)

1. **Run 75 (again — corrected), then 76, then 77.**
2. **Migration 76 grants access.** It carries a SELECT listing exactly which
   roles were missed — run that first if you want the blast radius. If a role
   named "Branch Manager" was meant NOT to have what "branch_manager" has, do
   not run it; rename the role instead.
3. **Refresh `schema-index.json`, delete the `schema-pending.json` entry.**
4. Still outstanding from earlier batches: grant `receipt.manage` to Manager;
   confirm Orders / Turnover / Inventory appear; run the A57 query.

## Deliberately NOT done (rule 12)

- **A37** was in the original plan and came out. `/pos-login` is not called by
  the desktop app at all — only the dashboard's web POS. So the bypass is not a
  forged field; it is that `/pos-login` is a licence-free path to a POS session.
  Closing it means deciding whether web POS needs a licence, which is a
  commercial decision, not a code one.
- **A49 and A12** need a product decision (point the report at `stock_movements`,
  or drop the table).
- **A17, A18, A19, A20, A43** are desktop — unverifiable from this bench (rule 9).
