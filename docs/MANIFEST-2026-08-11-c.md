# MANIFEST — 2026-08-11-c

**Supersedes `-a` and `-b`. Cumulative — apply this one only** (rule 3).
**Base:** `0215475` (`dev`) · **No `version` field touched** (rule 22).
**No desktop file touched** — no version bump due (rule 15).

**MIGRATION 75 MUST BE RUN.** It is idempotent and a no-op where production is
already seeded, but section 3 makes one deliberate behaviour change — read it
before running.

| File | Change |
|---|---|
| `migrations/75_permission_registry.sql` | **NEW** — registers all 12 keys (A57, A46, A58). |
| `scripts/test-migration-75.mjs` | **NEW** — 11 PGlite assertions. |
| `apps/server/src/middleware/rbac.ts` | **NEW** `requireAnyPermission()` — additive any-of gate. |
| `apps/server/src/routes/devices.ts` | 5 routes → `devices.approve` \| `settings.manage` |
| `apps/server/src/routes/tables.ts` | 4 routes → `tables.manage` \| `settings.manage` |
| `apps/server/src/routes/etims.ts` | 4 routes → `etims.manage` \| `settings.manage` |
| `scripts/check-permission-parity.mjs` | Sees `requireAnyPermission`; `ungated` ratchets on grantable keys only; self-check added. |
| `scripts/permission-parity-baseline.json` | `6/6/2` → **`0/2/0`** |
| `docs/AUDIT-REGISTER.md` | A46 partly closed · A57 closed · A58 fix shipped. |
| *(from `-a`/`-b`, unchanged)* | `mailer.ts` · `mailer-transport.test.mjs` · `ci.yml` |

## Rollback

```
git checkout 0215475 -- apps/server/src/middleware/rbac.ts \
  apps/server/src/routes/devices.ts apps/server/src/routes/tables.ts \
  apps/server/src/routes/etims.ts apps/server/src/lib/mailer.ts \
  tests/mailer-transport.test.mjs .github/workflows/ci.yml docs/AUDIT-REGISTER.md
rm scripts/check-permission-parity.mjs scripts/permission-parity-baseline.json \
   scripts/test-migration-75.mjs migrations/75_permission_registry.sql \
   docs/MANIFEST-2026-08-11-{a,b,c}.md
```

Migration 75 is additive only — no drops, no renames. To undo just the A58 grant:
```sql
DELETE FROM role_permissions rp USING permissions p
WHERE rp.permission_id = p.id AND p.key IN ('orders.view_all','inventory.view');
```

## What was run, and what it printed (rule 7)

Environment: **Linux, Node 22.22.2.** No desktop, SQLite or Electron code is
touched, so the platform gap does not weaken these greens (rule 9).

```
15 gates                 all OK except check-doc-refs
check-doc-refs           RED — PRE-EXISTING (BRANCH-SERVER-PLAN.md). Unchanged.
run-migration-tests      All 8 migration test file(s) passed
  test-migration-75        11 passed, 0 failed   <- new, real Postgres via PGlite
mailer-transport         26 passed, 0 failed
server tsc               OK
typecheck-ratchet        server 0, dashboard 0 — baseline held

check-permission-parity: 16 key(s) enforced · 22 registered · 10 named by UI
   unregistered 6 -> 0     phantom 2 -> 0     ungated 2 (was 6 raw)
```

## Mutation checks (rules 10, 23) — each mutation confirmed applied first

| # | Defect introduced | Result |
|---|---|---|
| A | `DO NOTHING` → `DO UPDATE` | RED — *a pre-existing row keeps its own label* |
| B | Drop `products.manage` from the seed | RED — *all six A57 keys exist* |
| C | Grant `etims.manage` to roles | RED — *A46 keys are granted to NO role* |
| D | Rename the scanner's `requireAnyPermission` pattern | RED — *IS BLIND: source has 14 call sites, pattern matched 0* |
| E | Break only the key extraction | RED — *IS BLIND: matched 14, pulled 0 keys* |

**D and E each took three attempts, and that is the finding.** The scanner
originally could not see `requireAnyPermission` at all: on the very commit
introducing the split it reported 13 enforced keys instead of 16 and **exited 0**,
because the keys it missed happened not to move any ratcheted counter. A gate
blind to the change it guards is rule 23's defect in the gate built to catch it.
The first self-check then compared the extraction pattern **against itself**, so
renaming it found zero sites, satisfied "nothing to check", and passed green —
the same defect one level up. Ground truth is now a literal string count.

## THE ONE THING TO SCRUTINISE

`ungated` now ratchets only on keys **granted to some role** in a migration.
Rationale: `devices.approve` gates approve / reject / delete / authorise-handover,
and `FleetPage.tsx` is **read-only with zero write calls** — those four routes have
no dashboard UI at all. "No UI gate names the key" there means "there is no UI",
which is not two gates disagreeing and cannot be fixed by adding one.

**Be suspicious of this. I changed a metric while adding three keys that it then
exempted** — the exact shape rule 20 forbids. The argument that it is not a
loosening: the raw number is still printed, the exemption is *derived from the
role_permissions seeds* rather than asserted in prose (A49), and a key becomes
ratcheted the moment anyone grants it — which is also the moment a missing UI
gate starts to matter. If you disagree, revert this file and the baseline; the
route split stands on its own without it.

## What only you can verify (rule 16)

1. **Run migration 75**, having decided on section 3 (the A58 grant). Turnover
   shows branch revenue; if a branch manager should not see it, delete that block.
2. **After running, confirm the three manager tabs appear** — Orders, Turnover,
   Inventory. That confirms A58 and tells us whether it was a live fault or only
   a rebuild gap.
3. **The A57 query** in the register — six rows means this was always a rebuild
   gap; fewer means those routes were owner-only in the field.
4. **A manager with only `settings.manage` must still be able to do everything
   they could yesterday.** That is the additive claim, and only a real role can
   prove it.

## Deliberately NOT done (rule 12)

- **`receipt.manage` — A45's actual fix.** A per-key check inside a handler that
  also writes `supervisor_pin` hashes and encrypted M-Pesa secrets. Different
  mechanism, security-sensitive, own batch. The key is already registered, so
  that batch needs no migration.
- **`shifts.force_close`** — its UI is a desktop file (rules 9, 15).
- **`products.manage`'s 29 routes** — same pattern, but four times the size.
