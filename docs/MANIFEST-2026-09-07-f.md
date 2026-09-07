# MANIFEST 2026-09-07-f — A248: print parity Phase 1 (combo components + category)

**Base:** on top of delivery -e (A247). **Ship after -e.**
**Delivery:** zip, extract over repo root. **Server + dashboard.** No migration. No exe rebuild.
**Server needs a Render deploy** for the web to receive `category_id`.

## Why
The web sold a combo as one flat line, so kitchen/dispatch tickets showed only the combo name.
Phase 1 of `docs/PLAN-web-print-parity.md`: carry the combo components (and each component's
category) so tickets can show — and later route — the breakdown, exactly like the desktop.

## What changed (data path only; no routing yet)
- **Server** `/api/pos/init` — combo query selects each component's `category_id`; the
  `comboItems` flatten carries it. Additive.
- **Web** — `usePOSData` consumes `init.comboItems` (was ignored) and exposes it; new
  `ComboComponent` type. Resolved at **print time** (cart unchanged — the Phase-1 gate).
- `buildReceiptOrder` expands each combo line into component units (priceDelta 0 → totals
  unchanged), carrying `is_kitchen`/`category_id` for Phase 3; `printBill` + `CashierScreen`
  thread the map through.

## Files
| File | Change | ID |
|---|---|---|
| `apps/server/src/routes/pos.ts` | comboItems gains `category_id` | A248 |
| `apps/dashboard/src/types/index.ts` | `ComboComponent` type | A248 |
| `apps/dashboard/src/pages/pos/cashier/types.ts` | `POSInitResponse.comboItems` | A248 |
| `apps/dashboard/src/pages/pos/cashier/usePOSData.ts` | consume + expose `comboItems` | A248 |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | expand combos into component units | A248 |
| `apps/dashboard/src/lib/printBill.ts` | thread `comboItems` | A248 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | pass `comboItems` | A248 |
| `tests/tiny-bridge-printing.test.mjs` | 23 → 24 (Phase 1 guard) | A248 |
| `docs/AUDIT-REGISTER.md` | A248 entry; A-P2 27→28 | A248 |
| `docs/MANIFEST-2026-09-07-f.md` | this manifest | — |

## What ran + output (rule 7)
```
smoke: combo line → components on KITCHEN ticket
  1  3PC CHICKEN COMBO / 3PC Chicken / Fries large / Soda 1.25L / Spice: all spicy
tests/tiny-bridge-printing.test.mjs   -> 24/24 green
esbuild transpile (server pos.ts, buildReceiptOrder, printBill, usePOSData, CashierScreen, types) -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): live combo print on the till; full dashboard/server tsc (CI does that on push).

## Honest scope
Every component still prints on **every** station (no routing yet). Category routing + kitchen
exclusions = Phase 3; send-vs-pay timing = Phase 4; persistent spool = Phase 5.

## Rollback (rule 2)
Code-only, no schema. `git revert <this commit>`; redeploy server + dashboard together.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc gates.
3. **Deploy the server** (Render) so `/api/pos/init` returns `category_id`, then redeploy the dashboard.
4. Ring a combo → its components appear on the kitchen/dispatch tickets.

## Next
Phase 2 — lift `toUnits` + `stationsForCategory` into `shared/` so web and desktop run the same
routing logic; then Phase 3 wires web category routing + exclusions.
