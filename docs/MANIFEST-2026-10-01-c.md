# MANIFEST 2026-10-01-c — desktop 0.6.29 + cloud + web POS + dashboard + admin portal: the owner's asks after testing

**Base:** origin/dev `0df305f`. **Delivered as:** `swiftpos-2026-10-01-v0.6.29.patch` — includes the version bump (apps/desktop and
`shared/release.ts` → 0.6.29). **No migration.**

Owner, 2026-10-01, after running checklists v0.6.27 (20 pass, D2 fail, D4/D5 not run) and v0.6.28 (23/23 PASS):

## What changes
- **Standard for every client (were switches):** a cashier never sees sales, per-method totals or expected cash (blind close);
  at confirm the manager always sees the cashier's figures. The admin portal lists the other five switches. ("cashiers should
  never see this only the manager should be able to.")
- **The confirm table** (till, web POS, dashboard): cashier name, shift open – close; one row per method — Cashier · Manager —
  and a Reason row under any method where the manager's count differs (required).
- **After payment (till):** a success screen — the order number, Bill, Tip, Delivery fee, Paid, each method, Change, and
  "New order". No receipt view and no print button (owner's choice). The receipt still prints at payment on the thermal printer;
  a till without thermal printing set up no longer has an on-screen print.
- **History (till and web POS):** today's sales, all of them (was the last 30); the Total column is what the customer **paid**
  — bill + tip + delivery fee — with "incl. delivery 500" under it (A374, the D2 failure).

## D2 — where the 400 was
The money was right: the M-Pesa payment row holds bill + fee (shift panel, Z-report, expected per method, the cloud's reports add
payments), and the rider's fee left cash as a pay-out tied to the sale. History showed the BILL (`orders.total`; the fee is
pass-through, not sales), so the fee looked lost. Now History shows what was paid. Re-run as checklist v0.6.29 §D.

## Files
`shared/posFeatures.ts` (+ copies; `STANDARD_POS_FEATURES`), `shared/release.ts` (+ copies) 0.6.29; till: `ipcHandlers.ts`
(History today), `POSPage.tsx` (success screen, History paid), `ConfirmShiftModal.tsx`, `DayCloseTab.tsx`, `ShiftPanel.tsx`;
web: `pages/pos/ShiftModal.tsx`, `pages/pos/POSOrderHistoryTab.tsx`, `components/ShiftConfirmations.tsx`; cloud:
`routes/orders.ts` (list sends `tip_amount`); NEW `tests/owner-0629.test.mjs` (5; mutations bite); pins moved in
`tests/{prospect-features,shift-confirm,cross-sync}`, `apps/desktop/test/{prospect-features,shift-confirm,money-reports}`;
`apps/desktop/package.json` + lock 0.6.29; `docs/AUDIT-REGISTER.md` (results, A370–A373 closed, A374), checklist v0.6.29
(`.md` + `.html`), this file.

## Rollout (owner)
1. Apply, commit, push; CI green.
2. Deploy the cloud, the dashboard and the admin portal (no migration).
3. Tag **v0.6.29** → approve B Foods → T1 updates.
4. Checklist v0.6.29 (it re-runs v0.6.27's D2, D4, D5).
