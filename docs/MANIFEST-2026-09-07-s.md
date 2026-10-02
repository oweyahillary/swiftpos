# MANIFEST 2026-09-07-s — Owner UI review: A258 (Overview layout) + A259 (reports fixes)

**Base:** origin/dev @ 0825458 (fresh pull). **Web + server code.** No migration. No exe build.
Two of five UI issues built; A260/A261/A262 filed with build plans (see register).

## Fixes
- **A258** — manager Overview: Hourly full-width, then Top Items + Payment Methods share a 2-col
  grid (no blank space); payment methods restacked for the narrower column.
- **A259** — reports: (1) cashier name falls back to `email` when `name` is null (was rendering
  "Unknown"); (2) the Shifts tab + Summary Z-report now include an OPEN shift opened before the
  period (was `opened_at BETWEEN start AND end`, excluding a still-running 76h shift).

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | 2-col Top Items + Payment Methods | A258 |
| `apps/server/src/routes/reports.ts` | name→email fallback; open-shift inclusion (2 queries) | A259 |
| `tests/ui-reports-fixes.test.mjs` | new guard (3) | A258/A259 |
| `docs/AUDIT-REGISTER.md` | A258–A262 entries; A-P2 34→36, A-P3 16→19 | — |
| `docs/MANIFEST-2026-09-07-s.md` | this manifest | — |

## What ran + output (rule 7)
```
tests/ui-reports-fixes.test.mjs -> 3/3 green
esbuild transpile (ManagerDashboard, reports.ts) -> clean
register/doc/root gates -> green
```
NOT verified here (rule 16): the rendered Overview + the live reports on the DB.

## Filed for the next build (not in this zip)
- **A260** documents print "SwiftPOS" not the client name (BusinessContext null for managers).
- **A261** Reprint-receipt action on Orders (renderer supports `ctx.reprint`; needs order-items fetch).
- **A262** Shift report under Shifts (reuse `/api/reports/shifts` + Z-report behind a printable view).

## Diagnostic I need for A259 (if "Unknown" persists)
If a cashier still shows "Unknown" after deploy, send me one such order's `cashier_id` — if it
doesn't match any `users.id` (likely offline-synced), that's a different (attribution) bug.

## Rollback (rule 2)
`git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `node --test tests/ui-reports-fixes.test.mjs` -> 3 green; gates.
3. Deploy server + dashboard. Check: Overview shows Top Items + Payment side by side; Reports →
   Staff names the cashier; Reports → Shifts shows the running shift.
