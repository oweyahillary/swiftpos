# MANIFEST 2026-09-13-c — A275 remote day close (Option i-A)

**Base:** `4fcddc8` (`dev`), on top of deliveries -a and -b. **No `version` field
touched** (rule 22). **Migration 102** included — additive/idempotent/reversible,
mirrors the proven `node_instructions` shape. Cash custody, cross-stack (migration +
cloud + till + web) → not a deploy-window change (rule 13).

## What this delivers
- **A275 → FIX BUILT** (P1): an off-site manager can close a till's trading day
  **remotely**. The manager queues a close (entering the cash the cashier counted at
  the till); the till pulls it on its normal cloud sync, runs `executeCloseDay`
  **locally** (computing its own expected cash + variance), closes its own day, and
  acks. The cloud never writes a `business_days` close directly — closes flow up only,
  and the till stays the cash authority.

## Files
| File | Change | Why |
|---|---|---|
| `migrations/102_day_close_instructions.sql` | NEW — cloud relay table (mirror of `node_instructions`) + one-pending-per-(business,till,date) partial unique index | Carry a `close_day` instruction the till pulls; one live count per till per day |
| `apps/server/src/routes/day-close.ts` | NEW — `POST /instruct` + `GET /overview` (manager: shifts.force_close\|settings.manage); `GET /pending` + `POST /ack` (till: device-scoped via X-Device-Id, same as /api/sync) | The relay lifecycle |
| `apps/server/src/routes/index.ts` | Mount `/day-close` | Wire the route |
| `apps/desktop/src/main/syncEngine.ts` | `syncAll` pulls pending instructions and runs `executeCloseDay` verbatim, then acks (idempotent, best-effort, never breaks sync) | The till executes its own close — same cash arithmetic as the on-prem central close |
| `apps/dashboard/src/pages/manager/RemoteDayClose.tsx` | NEW — manager panel: open trading days, queue a close against a counted amount, poll for the ack + variance | Lets the off-site manager drive it |
| `apps/dashboard/src/pages/manager/ManagerShiftTab.tsx` | Mount the panel | Surface it where shift oversight already lives |
| `tests/day-close-relay.test.mjs` | NEW — 5 guards (mutation-checked) | Endpoint gating, count-required, replace-pending, device scoping, reads-open-days-only |
| `tests/day-close-till.test.mjs` | NEW — 4 guards (mutation-checked) | Reuses executeCloseDay, pulls+acks, idempotent, best-effort in syncAll |
| `tests/day-close-web.test.mjs` | NEW — 4 guards (mutation-checked) | Panel gating, real-count-only, mounted, migration shape |
| `scripts/test-migration-102.mjs` | NEW — PGlite migration test (CI) | Convention (100/101 have one); pins table + partial unique index + idempotency |
| `docs/SHIFT-DAY-WEB-PARITY-DESIGN.md` | Phase 3 BUILT + follow-ups | Living design |
| `docs/AUDIT-REGISTER.md` | A275 → FIX BUILT + changelog | Rule 14 |
| `docs/MANIFEST-2026-09-13-c.md` | NEW — this file | Rule 2 |

## Design note — Option i-A
The count is entered **remotely by the manager** (the count the cashier made at the
till), and the till computes expected cash + variance — exactly as the manager enters
each till's count at the on-prem node screen today. The relay never closes on estimated
cash. If you'd rather the cashier physically enter the count at the till on an incoming
instruction (i-B), that's a follow-up; the instruction + ack shapes already support it.

## Verification (rule 7)
- `node tests/day-close-relay.test.mjs` → **5 passed**; `day-close-till` → **4**;
  `day-close-web` → **4**.
- Mutation checks (rule 10/23): dropped `MANAGER` from `/instruct` → relay gating
  assertion **red**; replaced `executeCloseDay(ins.payload)` with a stub → till
  assertion **red**; both restored → green.
- `check-register-consistency`, `check-doc-refs`, `check-root-clean`,
  `check-test-registration` → **all green**.

## NOT verified here — target-only (rule 16)
- The **whole live loop**: manager queues → till pulls on cloud sync → closes locally
  with correct expected/variance → acks → manager sees it. Plus date-mismatch refusal,
  and the idempotent re-run after an ack drop.
- **server tsc**, **dashboard tsc**, and **`scripts/test-migration-102.mjs`** — no
  `node_modules`/Postgres on the bench; run the typecheck ratchet + migration tests on CI.

## Rollback
```
git checkout 4fcddc8 -- apps/server/src/routes/index.ts apps/desktop/src/main/syncEngine.ts apps/dashboard/src/pages/manager/ManagerShiftTab.tsx docs/AUDIT-REGISTER.md docs/SHIFT-DAY-WEB-PARITY-DESIGN.md
git rm migrations/102_day_close_instructions.sql apps/server/src/routes/day-close.ts apps/dashboard/src/pages/manager/RemoteDayClose.tsx tests/day-close-relay.test.mjs tests/day-close-till.test.mjs tests/day-close-web.test.mjs scripts/test-migration-102.mjs docs/MANIFEST-2026-09-13-c.md
```
Migration 102 is additive; if it already ran, `DROP TABLE IF EXISTS public.day_close_instructions;` and delete its `schema_migrations` row.
