# MANIFEST 2026-09-07-ae — A268: stop the kitchen double-print on payment

**Base:** origin/dev @ 16c3787. **Web-only (dashboard).** No server, no migration.

## Fix (kitchen double)
Pay-first `onSuccess` fired the kitchen + dispatcher tickets on payment unconditionally. Since
A264 surfaced Send to Kitchen in pay-first, an order already sent got a SECOND kitchen/dispatch
ticket. Now `onSuccess` skips the fire when `sentOrderIds[activeKey]` is set — the kitchen prints
once (either at Send to Kitchen, or at payment, never both).

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | pay-first onSuccess skips kitchen fire if already sent |
| `tests/pos-cart-parity.test.mjs` | guard (8) |
| `docs/AUDIT-REGISTER.md` | A268 entry |
| `docs/MANIFEST-2026-09-07-ae.md` | this manifest |

## What ran (rule 7)
```
tests/pos-cart-parity.test.mjs -> 8/8 ; esbuild transpile CashierScreen -> clean ; gates green
```
NOT verified here (rule 16): on the till — Send to Kitchen then pay prints ONE kitchen ticket.

## Still open (owner decision) — the RECEIPT double
Print Bill prints a full receipt (throwaway number) + payment auto-prints the fiscal receipt =
two receipts, different numbers. Correct fix is to mark Print Bill a proforma ("BILL / not a
receipt", no fiscal number) — a small renderer flag — pending the owner's workflow call.

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 8 green; gates; deploy.
