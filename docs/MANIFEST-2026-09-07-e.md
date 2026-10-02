# MANIFEST 2026-09-07-e — A247: Print-Bill station order + desktop-parity plan

**Base:** on top of delivery -d (A246). **Ship after -d.**
**Delivery:** zip, extract over repo root. Dashboard-only. **No exe rebuild. No migration.**

## Why
All three station tickets print (A246), but in arbitrary order (the `branchPrinters`
array order from the API). Owner's required order: **kitchen → customer → dispatcher.**

## What changed
- `printBill.ts` — a `STATION_ORDER` map (`kot:0, receipt:1, expeditor:2`) sorts the
  filtered full-order printers before the fan-out, so tickets emit kitchen → customer →
  dispatcher.
- `docs/PLAN-web-print-parity.md` — full study of the desktop print path and a phased plan
  to reach parity (combo-component data, category routing, kitchen exclusions, send-vs-pay
  timing, persistent spool). No code beyond the ordering fix in this delivery.

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/lib/printBill.ts` | kitchen → customer → dispatcher order | A247 |
| `tests/tiny-bridge-printing.test.mjs` | 22 → 23 (order guard) | A247 |
| `docs/PLAN-web-print-parity.md` | **new** — desktop study + phased parity plan | A247 |
| `docs/AUDIT-REGISTER.md` | A247 entry; A-P3 13→14 | A247 |
| `docs/MANIFEST-2026-09-07-e.md` | this manifest | — |

## What ran + output (rule 7)
```
tests/tiny-bridge-printing.test.mjs   -> 23/23 green
esbuild transpile (printBill.ts)      -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): the physical print order on the till.

## Rollback (rule 2)
Code-only. `git revert <this commit>` and redeploy the dashboard.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc gates.
3. Redeploy the dashboard. Print Bill now emits kitchen → customer → dispatcher.

## Next
`docs/PLAN-web-print-parity.md` Phase 1 (enrich the web cart with combo components +
category) is the foundation for true desktop parity — its own register ID + two-till check.
