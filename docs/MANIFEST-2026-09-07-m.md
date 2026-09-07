# MANIFEST 2026-09-07-m — A253: print parity Phase 4 (send-vs-pay timing split)

**Base:** origin/dev @ cff3c5f (fresh pull). **Web-only.** No migration. No exe rebuild.

## Why
Matching the desktop's rule that food fires before payment, and unifying the web onto one
routed fan-out.

## What changed
- **Send to Kitchen** → `printRoutedStations({ kinds: ['kitchen','dispatch'] })` (was printKOTs).
- **Charge (pay-first)** → `printRoutedStations({ kinds: ['kitchen','dispatch'] })`.
- **Print Bill** → `printRoutedStations({ kinds: ['receipt'] })` — customer proforma only.
- Receipt at payment (PaymentModal) unchanged.
- `printKOT.ts` stripped to types (`BranchPrinter`/`KOTContext`); `printKOTs`/`buildKotEscPos`/
  `buildKOTHtml` retired. `printBill.ts` deleted (inert since A252).

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | 3 triggers → printRouted with timing kinds; drop printKOTs import |
| `apps/dashboard/src/lib/printKOT.ts` | stripped to types-only |
| `apps/dashboard/src/lib/printBill.ts` | **deleted** |
| `tests/tiny-bridge-printing.test.mjs` | retire KOT-fn guards; add Phase-4 timing guard (24) |
| `docs/AUDIT-REGISTER.md` | A253 entry; A-P2 31→32 |
| `docs/MANIFEST-2026-09-07-m.md` | this manifest |

## What ran + output (rule 7)
```
tiny-bridge-printing.test.mjs  -> 24/24 green
esbuild transpile (CashierScreen, printKOT, printRouted) -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): live send-then-pay sequence on the till.

## Behaviour note
The routed path is bridge-only — the old printKOTs `window.print` kitchen fallback is gone.
If the bridge is down, kitchen/dispatch tickets don't print (errors are caught, never block the
order). Acceptable for the silent-bridge model; the receipt keeps PaymentModal's browser fallback.

## Rollback (rule 2)
`git revert <this commit>` (restores printKOTs + printBill.ts).

## Apply
1. Extract over repo root, then: `git rm apps/dashboard/src/lib/printBill.ts`
2. `node --test tests/tiny-bridge-printing.test.mjs` -> 24 green; register/doc gates.
3. Redeploy the dashboard. Verify: Send to Kitchen prints food tickets; Charge prints the
   receipt; Print Bill prints only the customer proforma.
