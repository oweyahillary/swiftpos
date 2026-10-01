# MANIFEST 2026-09-30-d — desktop 0.6.27 + cloud + migration 111 + dashboard + admin portal: a prospect's requests, per-client switches (A369)

**Base:** origin/dev `94ef7dd` **plus the 0.6.26 patch** (`swiftpos-2026-09-30-v0.6.26.patch`, not yet pushed). **Delivered as a
patch applied AFTER 0.6.26's:** `swiftpos-2026-09-30-v0.6.27.patch`. It **includes the version bump** (apps/desktop → 0.6.27) and
**migration 111** (run it before deploying the cloud). Local schema 59 (`REQUIRED_DESKTOP_SCHEMA` 59; a till on 58 keeps syncing).

Owner, 2026-09-30, after a meeting with a prospect — nine requests, and: "we can find a way of turning this features on and off
per clients requests rather than killing some of them totally".

## The switches (admin portal → client → Features → POS switches; every one OFF unless set)
| Switch | What it does |
|---|---|
| **Blind shift close** | A cashier closing a shift sees no sales, per-method totals or expected cash — a box for each method used, no variance note. A manager closing sees all. |
| **Delivery fee and rider** | A delivery needs the rider's name and a delivery fee before payment. The customer pays the fee on top of the bill; the rider is paid it in cash from the drawer, recorded automatically. |
| **Cashiers see only their own sales** | History shows a cashier only the sales they rang (till and web POS). Managers see all. |
| **No reprint for cashiers** | No Reprint in History for a cashier (till and web POS; the till refuses it in main too). Managers can. |
| **Manager sees the cashier's figures when confirming** | "Cashier entered …" beside each box; the manager keys in their own count and must give a reason where the two differ. |

Only the admin portal switches them; a client's own settings cannot (`PUT /api/flags` refuses these keys). The till and the web POS
pick them up at their next catalogue pull (≤ 10 min, or Sync); a branch node relays them to its peers.

## For every client (no switch)
- **History:** filter by payment and by type, "Order by" time / payment / type; a delivery reads **"Delivery — Eugene"** (till + web).
- **Expenses — "Paid with"** (till, web POS, dashboard): only **cash** leaves the drawer; an expense paid by M-Pesa (card…) comes off
  that method's expected total instead. Every earlier expense reads as cash (it was).
- **Z-report:** each expense line shows its **type** first, then what it was for, then the method when not cash; an "EXPENSES NOT
  FROM THE DRAWER" section; with deliveries, "Delivery fees (in payments)" and "− Paid to riders".

## The delivery fee, in money (owner's example)
A 1,000 order + 300 delivery fee, paid by M-Pesa 1,300: sales **1,000** (the fee is not sales or VAT); M-Pesa expected **1,300**;
the rider is paid 300 from the drawer → expected cash **300 lower**. The Z-report says so on two lines. Paid in cash instead: 1,300
in, 300 out to the rider. The receipt prints the fee after the total; PAY = 1,300. Voiding the sale puts the 300 back into the
drawer (a pay-in) while the shift is open. A **refund** returns everything the customer paid, fee included (it reverses every
payment, as for any sale); the rider keeps what they were paid — that pay-out stays, since the delivery happened.

## Found on the way (fixed)
- **A370 (P1):** adding an expense from the dashboard (Expenses page, manager dashboard) was refused "Validation failed" — the cloud's
  check asked for fields no page sends. Since the repository's first commit. Till and web POS expenses were unaffected.
- **A371 (P3):** the till's on-screen receipt after a sale showed a tip as "Round Off" and counted it twice in PAY (the printed
  receipt was right).

## Files
| Area | Files |
|---|---|
| Shared (copied, `check-shared-sync`) | NEW `posFeatures.ts`, `delivery.ts`, `expenseMethod.ts`, `confirmReasons.ts`, `historyView.ts`; `shiftConfirm.ts` (reason line) |
| Migration | NEW `migrations/111_prospect_requests.sql` (orders.delivery_fee + create_order_atomic, float_transactions.order_id, expenses.payment_method, shifts.confirm_reasons), NEW `scripts/test-migration-111.mjs`; `scripts/schema-index.json`, `schema-parity-exceptions.json` (expenses.expense_type_name, local) |
| Cloud | `routes/pos.ts` (posFeatures), `flags.ts` (refuses POS keys), `orders.ts` (fee, rider pay-out for web sales, void puts it back, own-sales list, filters, can_reprint), `shifts.ts` (cash-only drawer expenses, per-method expected, blind close, confirm reasons, confirm-view, fee in foreign-orders), `expenses.ts`, `sync.ts` (payment_method), `lib/schemas.ts` (A370), NEW `lib/posFeatureFlags.ts`, `lib/riderPayout.ts`; `desktopSchema.ts` 59 |
| Till (main) | `deviceConfig.ts`, `localDb.ts` (59), `referenceBundle.ts`, `syncEngine.ts` (switches, fee + rider pay-out, reasons push), `shiftService.ts` (Z-report lines, expected per method, historyScope, blind close, reasons), `ipcHandlers.ts`, `ipcSchemas.ts`, `preload.ts`, `managerReports.ts`, `webSales.ts` (reverseRiderPayout), `nodeIngest.ts`, `escposBridge.ts` |
| Till (screens) | `POSPage.tsx` (fee field, checks, History), `PaymentModal.tsx`, `ReceiptView.tsx` (A371), `ShiftPanel.tsx` (Paid with, blind), `ConfirmShiftModal.tsx`, `ZReportView.tsx`, `lib/printShiftReport.ts`, `lib/heldOrders.ts`, `lib/posApi.ts` |
| Printing | `shared/printing/src/{types,render,shiftReport}.ts`, NEW `test/delivery-and-expenses.test.ts`; `apps/dashboard/src/lib/escposRenderer.js` rebuilt |
| Web POS / dashboard | `CashierScreen.tsx`, `PaymentModal.tsx`, `ReceiptView.tsx`, `ShiftModal.tsx`, `POSOrderHistoryTab.tsx`, `cashier/usePOSData.ts`, `cashier/types.ts`, `lib/buildReceiptOrder.ts`, `pages/expenses/ExpensesPage.tsx`, `components/ShiftConfirmations.tsx` |
| Admin portal | `AdminPortal.tsx` (POS switches, named) |
| Tests | NEW `apps/desktop/test/prospect-features.test.mjs` (33; CI step), NEW `tests/prospect-features.test.mjs` (19); pins moved in catalogue-refresh-signal, money-reports, order-notes (till + cloud), shift-confirm (till + cloud), shift-reports, cross-sync, expense-recorder, foreign-cash, web-receipt-money |
| Docs | `docs/AUDIT-REGISTER.md` (A369–A371, Tree v0.6.27), `docs/checklists/VERIFY-CHECKLIST-v0.6.27.html` + `.md`, this file |

## Verification (bench)
```
prospect-features (till) 33/33 · 9 mutations bite · prospect-features (cloud) 19/19 · 7 mutations bite · migration 111 10/10
(PGlite, the real create_order_atomic) · 5 mutations bite · printing delivery-and-expenses 5/5 · 3 mutations bite · printing npm
test (golden files unchanged) · every desktop test · every cloud suite (without shared/printing built, as CI) · 34 migration tests ·
every gate (shared-sync, register, schema audit, schema parity, api routes) · typecheck ratchet · desktop main + renderer, cloud,
dashboard and admin builds.
```

## Rollout (owner)
1. Apply **0.6.26's patch first**, commit, push. Then apply this one, commit, push; CI green.
2. **Run migration 111** (the cloud writes the new columns — deploy it before the cloud). Then deploy the **cloud**, the
   **dashboard** and the **admin portal**.
3. Tag **v0.6.27** → approve B Foods → T1 updates (0.6.26 need not be approved first — 0.6.27 contains it).
4. Checklist v0.6.27. To test the switches on B Foods, turn them on in the admin portal (and off again after, if B Foods should not
   keep them).

## Rollback
The switches off in the admin portal return every client to 0.6.26's behaviour for items 1, 2/3, 6, 7, 8. Migration 111 is additive
(a 0.6.26 cloud ignores the columns).
