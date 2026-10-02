# MANIFEST 2026-09-07-aa — A264: web POS cart converges on the desktop shared core

**Base:** origin/dev @ caabdc7 (fresh pull; all green). **Web-only (dashboard).** No server, no migration.

## Why
Web and desktop POS should feel like one interface — same actions, same placement (muscle
memory) — with the web keeping its premium extras. The web cart had no in-cart order-type
selector and hid Send to Kitchen in `pay_first`.

## Fix (`CashierScreen.tsx`)
- **Order-type selector** (Dine in / Takeaway / Delivery) at the top of the cart, matching the
  desktop toggle. `setActiveOrderType` sets the active order's recorded type.
- **Send to Kitchen · Hold** shown for every restaurant order in BOTH modes (was order_first
  only). Send to Kitchen is amber (distinct from green Charge); Hold reuses `parkOrder`.
- **Web-only premium extras** (Print Bill / Transfer / Split / Room) moved BELOW Charge so they
  never displace the shared core.

## Confirmed while reading both carts
- Desktop cart has NO coursing, Print Bill, Transfer, Split, or Room — those stay web-only.
- Coursing ("No course") is web richness; left web-only (not added to desktop).

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | order-type selector; unified Send-to-Kitchen · Hold → Charge → extras |
| `tests/pos-cart-parity.test.mjs` | new guard (4) |
| `docs/AUDIT-REGISTER.md` | A264 entry |
| `docs/MANIFEST-2026-09-07-aa.md` | this manifest |

## What ran (rule 7)
```
tests/pos-cart-parity.test.mjs -> 4/4 ; esbuild transpile CashierScreen -> clean ; gates green
```
NOT verified here (rule 16): the live cart on the till (order-type switch, Send to Kitchen in
pay_first, Hold, and the extras below Charge).

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 4 green; gates; deploy
the dashboard. On the till POS: a table order shows Dine in/Takeaway/Delivery at the top,
Send to Kitchen · Hold above Charge, and Print Bill/Transfer/Split/Room below.
