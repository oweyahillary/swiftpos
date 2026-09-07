# MANIFEST 2026-09-07-j — A252: print parity Phase 3b (B-engine, component routing)

**Base:** on top of -i (A251). **Apply after -f/-g/-h/-i.**
**Delivery:** zip, extract over repo root. **Web-only.** No server change. No migration. No exe rebuild.

## Why
Combos went wholesale to whichever station matched the combo's category — a combo's drink and
its food could not split to the bar and the grill. B-engine runs the shared routing engine
(A249) fed from the existing `branch_printers`, so each combo COMPONENT routes on its own
category. No printer-config migration, no Printers-UI change (that would be B-full).

## What changed (web-only)
- **NEW `printRouted.ts`** — builds `CategoryRouting` from `branch_printers`
  (kitchen/bar = routed stations, kot/expeditor = all-items, receipt = receipt) +
  `categories.is_kitchen`; expands each line with shared `toUnits`; renders each printer with
  `renderStationEscPos({id, kind, paperWidthMm})` so units route by `station.id`. A247 order
  (kitchen → customer → dispatcher); strips kitchen-exclusions from kitchen-kind stations.
- **Bundle** now exports `renderStationEscPos` + `toUnits`/`stationsForCategory`/`idsByKind`
  (byte-reproducible). `Category.is_kitchen` added to the type.
- **Print Bill** uses `printRoutedStations`; the old all-items `printBill.ts` is **deleted**.

## Files
| File | Change | ID |
|---|---|---|
| `scripts/escpos-renderer/entry.ts` | `renderStationEscPos` + export routing helpers | A252 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — reproducible | A252 |
| `apps/dashboard/src/lib/escposRenderer.d.ts` | new export types | A252 |
| `apps/dashboard/src/lib/printRouted.ts` | **new** — B-engine fan-out | A252 |
| `apps/dashboard/src/lib/printBill.ts` | **deleted** (superseded) | A252 |
| `apps/dashboard/src/types/index.ts` | `Category.is_kitchen` | A252 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Print Bill → `printRoutedStations` | A252 |
| `tests/tiny-bridge-printing.test.mjs` | guards repointed to `printRouted` | A252 |
| `docs/AUDIT-REGISTER.md` | A252 entry; A-P2 30→31 | A252 |
| `docs/MANIFEST-2026-09-07-j.md` | this manifest | — |

## What ran + output (rule 7)
```
smoke: combo Chicken(catFood→grill) + Soda(catDrink→bar)
  GRILL ticket -> "CHICKEN+SODA COMBO / Chicken"     (only the grill component)
  BAR   ticket -> "CHICKEN+SODA COMBO / Soda"        (only the bar component)
tests/tiny-bridge-printing.test.mjs   -> 25/25 green
shared routing.test.ts                -> 11/11 green
escposRenderer.js                     -> byte-reproducible
esbuild transpile (all changed)       -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): live routed print on the till.

## Deferred
- **B-full** — merge `branch_printers` onto `print_stations`/`category_stations` + migrate live
  config + rewrite the Printers UI. Bigger; not needed for component routing.
- `printKOTs` (Send-to-Kitchen) still line-level; fold onto `printRouted` with Phase 4 timing.

## Rollback (rule 2)
Web-only. `git revert <this commit>` restores `printBill.ts` and the old fan-out.

## Apply
1. Extract over repo root, then remove the retired file: `git rm apps/dashboard/src/lib/printBill.ts`
   (a zip cannot carry a deletion).
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc gates.
3. Redeploy the dashboard. Configure a Kitchen and a Bar station (each with its categories), ring a
   combo that spans both, and confirm each component lands on the right station.
