# MANIFEST 2026-10-02-d — desktop 0.6.33: free delivery — the shop pays the rider, the customer pays no fee (A379)

**Base:** origin/dev `4d9d8af` (the first 0.6.33 patch, "the fee may be left empty" — corrected here). **Delivered as:**
`swiftpos-2026-10-02-v0.6.33-b.patch`. Version stays 0.6.33 (already bumped). **Migration 115** (applied by the production migrate run on merge to main).
Cloud, web and till; local schema 63 (the cloud then requires it).

Owner, 2026-10-02: "can we add an option of free delivery … that can be turned on and of by the hotel owner" — then:
"though this free delivery the rider is still paid by the shop so delivery fee is a must but the customer does not pay it".

## What changes
- A new owner switch, **Allow free delivery** (off by default): web Settings › Business › **Voids, refunds & delivery**
  (renamed from "Voids & refunds"), and on the till Manager → Settings (signed in as the owner). Only the owner can change it.
- With it on, on a client whose deliveries carry a fee (the admin portal's "Delivery fee and rider" switch), the cashier
  sees a **Free delivery** tick next to the fee (till and web POS). The fee is still required and the rider is still paid
  it in cash from the drawer (as on every delivery). Ticked: the customer pays the bill alone.
- Receipt: "Delivery: FREE" (the fee is not printed and not in PAY). Success screen: "Delivery (rider) FREE".
- Z-report: "Delivery fees (in payments)" = what customers paid; **"Free deliveries (shop paid)"** = the riders' fees the
  shop covered; "Paid to riders" = both (why expected cash is lower). History: what the customer paid.
- **Free delivery from a bill of …** (owner, same screens; empty = off): a delivery whose bill reaches the amount is free
  automatically — the tick shows ticked and locked ("Free delivery (over 2,000)"); the money is the same as a ticked one.
- **Riders** on the till's Z-report (screen and paper): each rider — deliveries, what they were paid, and the free ones the
  shop paid. Voided sales are left out; a cashier's blind close shows none.
- With it off, or not ticked: unchanged.

## Files
Migration `115_free_delivery.sql` (+ `scripts/test-migration-115.mjs`, `scripts/schema-index.json`); `shared/delivery.ts`
(+ 4 copies: `customerDeliveryFee`, `isFreeDelivery`), `shared/reversalRules.ts` (+ 4 copies: `delivery_free_allowed`);
`shared/printing` (types, render, shiftReport, its delivery test). Cloud: `routes/orders.ts` (sale + /pay + reads),
`routes/shifts.ts`, `routes/business.ts`, `lib/desktopSchema.ts` (63). Till: `main/localDb.ts` (63), `syncEngine.ts`,
`ipcHandlers.ts`, `escposBridge.ts`, `shiftService.ts`, `managerReports.ts`, `webSales.ts`, `nodeIngest.ts`;
`renderer/pages/POSPage.tsx`, `components/ReversalRulesPanel.tsx`, `components/ZReportView.tsx`, `lib/printShiftReport.ts`,
`lib/heldOrders.ts`, `lib/posApi.ts`. Web: `pages/pos/CashierScreen.tsx`, `PaymentModal.tsx`, `ReceiptView.tsx`,
`POSOrderHistoryTab.tsx`, `cashier/usePOSData.ts`, `cashier/types.ts`, `lib/buildReceiptOrder.ts`,
`pages/settings/VoidRefundRulesTab.tsx`, `BusinessPage.tsx`. Version 0.6.33. Tests: NEW `tests/free-delivery.test.mjs` (12),
`apps/desktop/test/free-delivery.test.mjs` (10; CI step added); pins moved in `reversal-rules`, `prospect-features`,
`cross-sync`, `owner-0629`, `web-receipt-money`, desktop `order-notes`. `docs/AUDIT-REGISTER.md` (A379), this file.

## Rollout (owner)
1. Apply, commit, push to dev; CI green. Merge to main → the production migrate run applies **115** (green) → deploy.
   (Deploy after the migrate run: the cloud now reads `orders.delivery_free`.)
2. Tag **v0.6.33** from dev: `git fetch origin && git push origin origin/dev:refs/tags/v0.6.33` → Release desktop green.
3. Approve 0.6.33 for a test client; T1 updates. As the owner: Manager → Settings → **Allow free delivery** on.
4. Ring a delivery: rider Eugene, fee 300, tick **Free delivery**, the customer pays the bill by M-Pesa. The receipt says
   "Delivery: FREE"; the drawer shows a 300 pay-out to Eugene; the Z-report shows "Free deliveries (shop paid) 300".
5. A delivery without the tick: the customer pays bill + 300, as before. Switch the rule off → the tick is gone.
6. Set **Free delivery from a bill of 2000**: a 2,500 delivery shows the tick ticked and locked; a 1,500 one does not.
7. End the shift as a manager: the Z-report lists the riders (Eugene (2) … incl. 1 free (shop paid)).
