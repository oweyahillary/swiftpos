# MANIFEST 2026-09-07-z — A262: shift report under Shifts (desktop renderer on web)

**Base:** origin/dev @ 4104fb7. **Web + server.** No migration. Last of the 5 owner UI asks.

## What
A "Shift report" button on the manager's Shifts card that prints the shift's Z-report using the
SAME shared renderer as the desktop (`renderShiftReport`) — cashier, open/close, sales by method,
orders, gross, and the cash reconciliation (opening float + cash sales + float in − float out =
expected cash), plus counted/variance once closed.

## Fixes
- `scripts/escpos-renderer/entry.ts` — bundle `renderShiftReportEscPos` (wraps the shared
  `renderShiftReport`). Bundle regenerated (byte-reproducible).
- `apps/server/src/routes/shifts.ts` — `GET /:id` now returns `by_method`, `cash_sales`,
  `float_in`, `float_out`, `expected_cash_computed` (live) alongside the shift.
- `apps/dashboard/src/lib/printShiftReport.ts` — **new**; fetch shift → map to `ShiftReportData`
  → print via bridge (till only).
- `apps/dashboard/src/pages/manager/ManagerShiftTab.tsx` — "Shift report" button on each card.

## Files
| File | Change |
|---|---|
| `scripts/escpos-renderer/entry.ts` | bundle `renderShiftReportEscPos` |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — reproducible |
| `apps/server/src/routes/shifts.ts` | `GET /:id` returns breakdown + reconciliation |
| `apps/dashboard/src/lib/printShiftReport.ts` | **new** — fetch/map/print |
| `apps/dashboard/src/pages/manager/ManagerShiftTab.tsx` | "Shift report" button |
| `tests/ui-reports-fixes.test.mjs` | +1 guard (8) |
| `docs/AUDIT-REGISTER.md` | A262 FIX BUILT |
| `docs/MANIFEST-2026-09-07-z.md` | this manifest |

## What ran + output (rule 7)
```
smoke: SHIFT REPORT (LIVE) / B Fastfoods / Eugene / Cash (3) 13,600 / Expected 29,970.00 + cut
tests/ui-reports-fixes.test.mjs -> 8/8 ; escposRenderer.js reproducible ; transpile clean ; gates green
```
NOT verified here (rule 16): a physical shift-report print on the till.

## Apply
Extract over repo root; `node --test tests/ui-reports-fixes.test.mjs` -> 8 green; gates; deploy
server + dashboard. Manager → Shifts → "Shift report" prints the Z-report on the till.
