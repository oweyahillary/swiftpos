# MANIFEST 2026-09-07-ac — A266: fix blank receipt preview + auto-print on payment

**Base:** origin/dev @ caabdc7. **Web-only (dashboard).** No server, no migration.

## Why
After Charge, the success screen showed a blank white box (the receipt preview) and the receipt
didn't print. `ReceiptView` returns an empty div when `business` is null, and `useBusiness()` is
null on the POS surface for managers (the context gap A260 tackled at the token layer but which
still leaves this component without a business). There was also no auto-print — only a manual
Print button.

## Fix (`PaymentModal.tsx`)
- **Resolve the business**: when the `business` prop is null, fetch `/api/business` (works via the
  POS token, same as `reprintReceipt`) into `resolvedBusiness`, and use it for the preview
  (`ReceiptView`) and for building the printed receipt — so both always carry the business.
- **Auto-print on success**: extracted a silent bridge print (`printViaBridge`) and fire it once
  on payment success (bridge path only, no browser dialog), matching the desktop. The Print
  button remains for a reprint; WhatsApp unchanged.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | resolve business via fetch; auto-print on success |
| `tests/pos-cart-parity.test.mjs` | guard (6) |
| `docs/AUDIT-REGISTER.md` | A266 entry |
| `docs/MANIFEST-2026-09-07-ac.md` | this manifest |

## What ran (rule 7)
```
tests/pos-cart-parity.test.mjs -> 6/6 ; esbuild transpile PaymentModal -> clean ; gates green
sweep: no remaining bare business.* access that could throw on null
```
NOT verified here (rule 16): a live Charge → auto-print + a filled (non-blank) preview on the till.

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 6 green; gates; deploy the
dashboard. After Charge the receipt preview shows the receipt and it prints automatically.
