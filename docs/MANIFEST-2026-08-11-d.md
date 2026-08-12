# MANIFEST — 2026-08-11-d

**Supersedes `-a`, `-b`, `-c`. Cumulative — apply this one only** (rule 3).
**Base:** `0215475` (`dev`) · **No `version` field touched** (rule 22).
**No desktop file touched** — no version bump due (rule 15).
**NO NEW MIGRATION.** Migration 75 (already run) registered `receipt.manage`;
this batch only enforces it.

| File | Change |
|---|---|
| `apps/server/src/routes/business.ts` | **A45.** Route takes `receipt.manage` \| `settings.manage`; per-key allow-list before any write. |
| `apps/server/src/middleware/rbac.ts` | `hasFullSettingsAccess()` extracted and exported so the test drives the real predicate. |
| `tests/receipt-permission.test.mjs` | **NEW** — 21 assertions against compiled `dist`. |
| `docs/AUDIT-REGISTER.md` | A45 closed cloud-side · **A59 opened**. |
| *(from `-c`, unchanged)* | migration 75 · `test-migration-75` · `check-permission-parity` + baseline · `devices/tables/etims.ts` · `ci.yml` · `mailer.ts` · `mailer-transport.test.mjs` |

## Rollback

```
git checkout 0215475 -- apps/server/src/routes/business.ts \
  apps/server/src/middleware/rbac.ts docs/AUDIT-REGISTER.md
rm tests/receipt-permission.test.mjs
```
(plus `-c`'s rollback for the rest). Migration 75 needs no undo — this batch adds
no schema. Reverting restores the A45 behaviour: managers see Receipt and cannot save.

## What was run, and what it printed (rule 7)

Environment: **Linux, Node 22.22.2.** No desktop, SQLite or Electron code touched,
so the platform gap does not weaken these greens (rule 9).

```
15 gates                 all OK except check-doc-refs
check-doc-refs           RED — PRE-EXISTING (BRANCH-SERVER-PLAN.md). Unchanged.
run-migration-tests      All 8 migration test file(s) passed
receipt-permission       21 passed, 0 failed        <- new
mailer-transport         26 passed, 0 failed
server tsc               OK        typecheck-ratchet  server 0, dashboard 0
check-permission-parity  17 enforced · 22 registered · unregistered 0, ungated 2, phantom 0
```

## Mutation checks (rules 10, 23) — each confirmed applied first

| # | Defect introduced | Result |
|---|---|---|
| 1 | Move the per-key guard **below** the bcrypt branch | RED — *it runs BEFORE the bcrypt branch* |
| 2 | Add `supervisor_pin` to the allow-list | RED — two assertions |
| 3 | `hasFullSettingsAccess` also accepts `receipt.manage` | RED — *receipt.manage -> NOT full* |
| 4 | Drop `settings.manage` from the route gate | RED — *the ROUTE still names settings.manage* |
| 5 | Drop `receipt.manage` from the route gate | RED — *the ROUTE names receipt.manage* |

**Mutation 4 exposed a real hole first time round.** Section 1 constructs its own
gate, so it proved `requireAnyPermission` is additive but never read the route's
own wiring. Removing `settings.manage` from the actual route left all nineteen
assertions green — while every role holding it would have lost every business
setting on deploy. Two assertions added that read the route itself; 4 and 5 now
both bite.

## THE ONE STEP LEFT, and it is yours (rule 16)

**Grant `receipt.manage` to the Manager role in the dashboard Roles screen.**
Migration 75 registered the key, so this is a tick-box, not a migration. Until
somebody holds it, the Receipt tab still refuses and A45 looks unfixed.

Then have a manager open Receipt on the till, edit the address, and save. That is
the only proof that matters — a manager is the one thing this bench cannot simulate.

**Not granted by migration, deliberately.** Which roles may change what a customer
sees on a receipt is a business decision, and migration 75 applied the same
reasoning to A46's keys.

While you are in there, the two confirmations still outstanding from `-c`: do
**Orders / Turnover / Inventory** now show for a manager, and does the A57 query
return six rows.

## A KNOWN LIMIT OF check-permission-parity, recorded rather than hidden

It reads **migrations, not the live database**. Granting `receipt.manage` through
the Roles UI will not move its `ungated` count, so the key stays classified
owner-only and the gate stays green while a manager holds it. The ratchet catches
drift introduced in the repo; it cannot see grants made in production. Closing
that would mean giving CI database access, which is a bigger decision than the gate.

## Deliberately NOT done (rule 12)

- **A59 — the till's role-vs-key vocabulary gap.** See the register. It needs
  permission keys delivered to the till (not in the staff token today), a
  `hasPermission` on the renderer, 14 gates re-pointed, and a decision about what
  an offline till shows. Design decision, then a phase — not a batch.
- **`shifts.force_close`** — desktop UI (rules 9, 15).
- **`products.manage`'s 29 routes** — same pattern as `-c`, four times the size.
