# MANIFEST 2026-09-07-o — A255: receipt content + Print-Bill drawer (ships WITH A254)

**Base:** origin/dev @ 9b132f4 (fresh pull). **Web-only.** No migration. No exe rebuild.
**This zip contains BOTH A254 and A255** — the whole print bug-fix sweep — so it applies once.

## Fixes
### A254 (from -n, folded in here)
- toEscPos cut/feed/drawer opts were never passed → no cut (continuous), no bottom margin;
  all renderers now go through `emit()`.
- Master KOT rendered as a 2nd dispatch → type-aware config (kot = all-items KITCHEN copy).
- Blank routed tickets → `printRouted` skips a routed station with no matching items.

### A255 (this sweep)
- Receipts were missing **branch name, owner address header, paybill/delivery footer, and
  "Powered by SwiftPOS"** — `receiptHeader`/`receiptFooter` weren't loaded and
  `buildReceiptBusinessConfig` didn't set them; the owner footer maps to `thankYouMessage`
  (not the ignored `footerText`). Now fully wired.
- **Print Bill opened the cash drawer** — routed receipt is now `openCashDrawer:false`; the
  drawer opens only on the payment receipt.

## Files
| File | Change | ID |
|---|---|---|
| `scripts/escpos-renderer/entry.ts` | emit() opts; type-aware station; stationHasContent; proforma drawer off | A254/A255 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — byte-reproducible | A254/A255 |
| `apps/dashboard/src/lib/printRouted.ts` | type-aware routing; skip empty; pass branch/header/footer | A254/A255 |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | config carries branch/header/footer/credit; receipt_footer→thankYouMessage | A255 |
| `apps/dashboard/src/pages/pos/cashier/usePOSData.ts` | load receiptHeader/receiptFooter | A255 |
| `apps/dashboard/src/pages/pos/cashier/types.ts` | POSInitResponse fields | A255 |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | receipt props + config | A255 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | thread receiptHeader/receiptFooter | A255 |
| `tests/tiny-bridge-printing.test.mjs` | 24 → 29 guards | A254/A255 |
| `docs/AUDIT-REGISTER.md` | A254 + A255 entries | — |
| `docs/MANIFEST-2026-09-07-n.md`, `docs/MANIFEST-2026-09-07-o.md` | delivery records | — |

## What ran + output (rule 7)
```
smoke: receipt -> B Fastfoods / Main Branch / Kilimani Rd / PIN / Tel ... Payment Detail /
       CASH / CHANGE / Buy Goods:3423273 / For Delivery... / Thank you / TAX RECEIPT / Powered by SwiftPOS
       Master KOT -> KITCHEN ; Dispatcher -> DISPATCH ; feed+cut present ; empty station skipped
       payment receipt kicks drawer (ESC p) ; Print Bill proforma does NOT
tiny-bridge-printing.test.mjs -> 29/29 green
escposRenderer.js -> byte-reproducible ; all TS transpiles
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): on-paper receipt content, physical cut, and drawer on the till.

## Rollback (rule 2)
Web-only. `git revert <this commit>`.

## Apply (one commit for the morning)
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` -> 29 green; register/doc gates.
3. Redeploy the dashboard. Ring a combo spanning kitchen+bar → Send to Kitchen (food splits by
   station, cuts, bottom margin), Charge (full receipt: branch/header/footer, drawer kicks),
   Print Bill (proforma, no drawer).
