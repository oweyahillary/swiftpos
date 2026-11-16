# SwiftPOS v0.6.19 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.19.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.19 adds A358 (History for cashiers again; standalone sauces off the kitchen ticket; “+ Add type” on the Expenses page) and A359 (refund on the web POS and the manager dashboard), and carries the printed-receipt checks of A349. Dashboard, then the till through the approval. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (in order)

No cloud change this time: the dashboard (web refund, web kitchen tickets), then 0.6.19 on the till through the approval.

### R1 — Dashboard deployed from dev
1. Deploy the dashboard from the commit that applied the patch; hard-refresh it (and check the Vercel deploy was promoted).

**Expected:** It loads; the web POS signs in.

### R2 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.19 → Actions → Release desktop green (incl. “Verify the release”) → Releases.

**Expected:** One v0.6.19 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R3 — Approve B Foods for 0.6.19 · **Record**
1. Admin portal → B Foods → 0.6.19 → Approve; restart the till, close and reopen when the update is ready.

**Expected:** The till reads 0.6.19.

## §H — History on the till — A358, A355

POS screen → History (top bar).

### H1 — A cashier sees History again — all orders · **Record**
1. Sign in as a CASHIER; open History.

**Expected:** The list of the last 30 orders (all cashiers’), with Reprint — and **no** Void / Refund buttons.

### H2 — A manager sees the buttons
1. Sign in as the manager; open History.

**Expected:** “Void / Refund” on sales under 30 minutes old, “Refund” on older ones, “refunded” tag on refunded ones.

### H3 — No sideways scrolling · **Record**
1. Look at the History window.

**Expected:** All columns and buttons fit; no horizontal scrollbar.

## §W — Refund on the web — A359

Web POS signed in as the MANAGER (and the dashboard for W2).

### W1 — Refund from the web POS · **Record**
1. Web POS → POS Menu → Orders → Order History → open a completed sale → **Refund** → a reason → your own PIN → confirm.

**Expected:** “Refunded KES …”; the order shows a **refunded** tag; the dashboard and reports show the refund.

### W2 — Refund from the manager dashboard
1. Manager dashboard → Orders → another completed sale → Refund → reason → your PIN.

**Expected:** The same.

### W3 — A wrong PIN says so plainly
1. Try with a wrong PIN.

**Expected:** “That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.”

### W4 — A cashier cannot refund on the web
1. Web POS as a cashier (if they can open Order History).

**Expected:** No Refund button.

### W5 — Already refunded = no second refund
1. Open a sale you refunded (W1).

**Expected:** No Refund button; the refunded tag shows.

## §K — Sauces off the kitchen ticket (printer) — A358

On the till, then the web POS.

### K1 — Till: a meal + standalone sauces · **Record**
1. Ring a combo plus BBQ Sauce and Honey Mustard Sauce; send to kitchen.

**Expected:** Kitchen ticket: the cooked food, **no sauces**. Dispatch: everything, sauces included.

### K2 — Web POS: the same order · **Record**
1. Same on the web POS.

**Expected:** Same result.

### K3 — Drinks still off
1. Add a Soda to either order.

**Expected:** No Soda on the kitchen ticket (as in 0.6.18).

## §E — Expense types — A358, A341

Online, as the manager.

### E1 — On the Expenses page · **Record**
1. Manager → Expenses.

**Expected:** An “Expense types” box lists the types, with **+ Add type**. Add “Gas refill” → it appears in the list.

### E2 — Still in Shift → Expenses
1. POS → Shift → Expenses.

**Expected:** “+ Add type” is there too; “Gas refill” is in the picker; record an expense with it.

### E3 — No duplicates
1. Add “gas REFILL”.

**Expected:** “already an expense type” (Expenses page) / the existing one selected (Shift); no second copy.

### E4 — A cashier cannot add types
1. Cashier → Shift → Expenses.

**Expected:** No “+ Add type”.

## §P — Printed receipts (carried from 0.6.16 — now you have the printer) — A349

A CTL business (VAT 16 %, CTL 2 %) unless stated.

### P1 — A DISCOUNTED sale prints · **Record**
1. Ring 2–3 items, 10 % discount, cash.

**Expected:** The receipt prints with Discount, SubTotal, CTL, VAT, Round Off, Total — and they add up.

### P2 — A TIP on the receipt · **Record**
1. A sale with a 50 tip.

**Expected:** Tip 50.00 after Total; PAY = Total + tip.

### P3 — Web POS receipt with CTL · **Record**
1. On the web POS, a discounted sale with a tip, printed.

**Expected:** Prints straight to the printer with the CTL line.

### P4 — A business WITHOUT CTL (skip if none)
1. Print a receipt on a VAT-only business.

**Expected:** No “CTL (0%)” line.

## §X — Regression (release-blocker if any fail)

### X1 — Normal sale
1. Ring a sale, take payment, print.

**Expected:** As before.

### X2 — Kitchen ticket
1. Ring a cooked item; send to kitchen.

**Expected:** Prints as before, nothing missing.

### X3 — Sign-in unchanged
1. Cashier → till; manager → manager screen.

**Expected:** As before.

### X4 — Sync healthy · **Record**
1. Technician → Sync.

**Expected:** Pending 0, no errors.

### X5 — Second till (if you have one)
1. Sign in on T2 and ring a sale.

**Expected:** Works; reaches the dashboard.
