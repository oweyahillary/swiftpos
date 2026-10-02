# MANIFEST 2026-09-07-h — A250: print parity Phase 3a (kitchen exclusions)

**Base:** on top of delivery -g (A249). **Ship after -g.**
**Delivery:** zip, extract over repo root. **Web-only.** No server change. No migration. No exe rebuild.

## Why
`/api/pos/init` already returns `kitchenExclusions`, but the web ignored them — so
owner-excluded items (drinks) still printed on kitchen tickets. The desktop strips them.
(Reading the source also corrected the plan: the web already routes by category via each
printer's `category_ids`; routing was NOT the gap.)

## What changed (web-only)
- Bundled the shared `isExcludedFromKitchen` (A249) into `escposRenderer.js` — one copy,
  same rule as desktop; bundle stays byte-reproducible.
- `usePOSData` consumes + exposes `kitchenExclusions`.
- Kitchen-kind tickets drop excluded items; everything else keeps them:
  `printKOTs` filters `kitchen`/`kot` printers; `printBill` renders the KITCHEN (kot) copy
  from an exclusion-filtered order (receipt + dispatcher keep the full order). Threaded via
  `CashierScreen` (both Send-to-Kitchen calls + Print Bill).

## Files
| File | Change | ID |
|---|---|---|
| `scripts/escpos-renderer/entry.ts` | export `isExcludedFromKitchen` | A250 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated (adds the export) — reproducible | A250 |
| `apps/dashboard/src/lib/escposRenderer.d.ts` | type for it | A250 |
| `apps/dashboard/src/pages/pos/cashier/types.ts` | `POSInitResponse.kitchenExclusions` | A250 |
| `apps/dashboard/src/pages/pos/cashier/usePOSData.ts` | consume + expose | A250 |
| `apps/dashboard/src/lib/printBill.ts` | KITCHEN copy filtered by exclusions | A250 |
| `apps/dashboard/src/lib/printKOT.ts` | strip exclusions from kitchen-kind printers | A250 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | thread `kitchenExclusions` | A250 |
| `tests/tiny-bridge-printing.test.mjs` | 24 → 25 | A250 |
| `docs/AUDIT-REGISTER.md` | A250 entry; A-P2 29→30 | A250 |
| `docs/MANIFEST-2026-09-07-h.md` | this manifest | — |

## What ran + output (rule 7)
```
smoke: exclude ['soda']
  KITCHEN -> "1 items to cook" (Soda dropped);  RECEIPT -> Wings + Soda both present
tests/tiny-bridge-printing.test.mjs   -> 25/25 green
escposRenderer.js                     -> byte-reproducible via scripts/build-escpos-renderer.mjs
esbuild transpile (all changed TS)    -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): live kitchen print with exclusions on the till.

## Deferred (design fork, surfaced not built)
Component-level routing — routing each combo component by its OWN category (drink → packer,
chicken → fryer). The web routes by the LINE's category (per-printer `category_ids`); the
desktop uses `category_stations` + station kinds. Matching it needs a paradigm decision.

## Rollback (rule 2)
Web-only, code-only. `git revert <this commit>` and redeploy the dashboard.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc gates.
3. Redeploy the dashboard. Set kitchen exclusions (owner receipt/menu settings) and confirm
   excluded items no longer appear on the kitchen ticket while staying on the receipt.
