# MANIFEST 2026-09-07-af — A269: Print Bill is a proforma BILL (+ A268 kitchen double)

**Base:** origin/dev @ 16c3787. **Web + shared renderer.** No server, no migration.
**Self-contained:** `CashierScreen.tsx` here has A268 (kitchen double) + A269 (proforma) —
applies whether or not `-ae` (A268) is in; supersedes it.

## Fix (A269 — receipt double)
Print Bill printed a full receipt with a throwaway `generateOrderNumber()`, so Print Bill then
payment gave two receipts with different numbers. Added a `proforma` flag end-to-end so Print
Bill prints a marked BILL, distinct from the fiscal receipt:
- `shared/printing/src/types.ts` — `PrintContext.proforma`.
- `shared/printing/src/render.ts` — "BILL - NOT A RECEIPT" header; omit the fiscal `Bill No.`.
- `scripts/escpos-renderer/entry.ts` — `renderStationEscPos` reads `station.proforma`. Bundle regenerated (reproducible).
- `apps/dashboard/src/lib/printRouted.ts` — applies proforma to the receipt station only.
- `apps/dashboard/src/pages/pos/CashierScreen.tsx` — Print Bill sets `proforma:true`, no fiscal number.

Payment receipt unchanged (the one fiscal receipt).

## Files
| File | Change | ID |
|---|---|---|
| `shared/printing/src/types.ts` | `PrintContext.proforma` | A269 |
| `shared/printing/src/render.ts` | proforma header + omit Bill No. | A269 |
| `scripts/escpos-renderer/entry.ts` | thread `station.proforma` | A269 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — reproducible | A269 |
| `apps/dashboard/src/lib/printRouted.ts` | proforma on receipt station | A269 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Print Bill proforma; A268 kitchen double | A268/A269 |
| `tests/pos-cart-parity.test.mjs` | guards (9) | A268/A269 |
| `docs/AUDIT-REGISTER.md` | A268 + A269 | — |
| `docs/MANIFEST-2026-09-07-ae.md` + `-af` | delivery records | — |

## What ran (rule 7)
```
smoke: Print Bill -> "BILL - NOT A RECEIPT", no Bill No.;  payment -> "Bill No.: <real>"
tests/pos-cart-parity.test.mjs -> 9/9 ; escposRenderer.js reproducible ; transpile clean ; gates green
```
NOT verified here (rule 16): on-paper on the till (Print Bill = a BILL, payment = one receipt).

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 9 green; gates; deploy.
