# MANIFEST 2026-09-07-k — DELIVERY RECONCILE: complete A250 + A251, delete printBill.ts

**Base:** `origin/dev` @ 786ac58 (has A248 + A249 + A252 code). **Corrective — apply next.**
**Delivery:** zip, extract over repo root. Web + desktop code. No migration. No exe rebuild.

## Why
A pull of origin showed the code had drifted from the register: A248/A249/A252 landed, but
**A250 (kitchen exclusions) and A251 (desktop shared routing) did not**, and the retired
`printBill.ts` was still present. Result: the print test and the dashboard `tsc` are RED on
origin (`CashierScreen` destructures `kitchenExclusions`, which `usePOSData` does not expose).
The `-h`/`-i` zips were skipped when `-j` was applied. This brings the tree to the consistent
A252 state.

## Files (the exact deltas vs origin)
| File | Change | Completes |
|---|---|---|
| `apps/dashboard/src/pages/pos/cashier/usePOSData.ts` | expose `kitchenExclusions` (+ it already has `comboItems`) | A250 |
| `apps/dashboard/src/pages/pos/cashier/types.ts` | `POSInitResponse.kitchenExclusions` | A250 |
| `apps/dashboard/src/lib/printKOT.ts` | strip exclusions from kitchen-kind printers | A250 |
| `apps/desktop/src/main/escposBridge.ts` | use shared routing + `buildCategoryRouting`; drop private copies | A251 |
| `apps/dashboard/src/lib/printBill.ts` | **delete** (retired in A252) | A252 |
| `docs/AUDIT-REGISTER.md` | reconcile changelog note | — |
| `docs/MANIFEST-2026-09-07-k.md` | this manifest | — |

Already correct on origin (unchanged here): `escposRenderer.js`/`.d.ts`, `CashierScreen.tsx`,
`printRouted.ts`, `routing.ts`, server `pos.ts`, `buildReceiptOrder.ts`, `types/index.ts`.

## What ran + output (rule 7)
```
tests/tiny-bridge-printing.test.mjs   -> 25/25 green (was RED on origin)
shared routing.test.ts                -> 11/11 green
esbuild transpile (all four files)    -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): desktop `tsc` (CI on push) + live print. **A251 is a desktop
print-routing change → the release gate applies: dev-flavour two-till trade before production.**

## Rollback (rule 2)
Code-only. `git revert <this commit>` (restores printBill.ts + the desktop private copy).

## Apply
1. Extract over repo root, then: `git rm apps/dashboard/src/lib/printBill.ts`
2. `node --test tests/tiny-bridge-printing.test.mjs` → 25 green; register/doc gates.
3. Push. **Confirm CI (dashboard + desktop tsc) goes green** — that's the proof this fixes it.
4. Only after CI is green should we start Phase 4.
