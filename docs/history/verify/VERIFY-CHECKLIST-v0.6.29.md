# SwiftPOS v0.6.29 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.29.html`. 0.6.29: the owner's asks after testing 0.6.27/0.6.28 — blind close
and the cashier's figures at confirm standard for every client; the confirm screen as one table; a success screen after payment
(no print button); History = today's sales, showing what was paid incl. the delivery fee (A374). Also re-runs v0.6.27's D2, D4,
D5. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout
Cloud, dashboard and admin portal first (no migration in this release).

### R0 — Deploy the cloud, the dashboard and the admin portal · **Record**
1. Deploy all three from dev; hard-refresh.
2. Dashboard sidebar: the release line.

**Expected:** “SwiftPOS v0.6.29 · <commit>” and “cloud v0.6.29 · <commit>”, not amber.

### R1 — Tag v0.6.29, approve B Foods
1. Tag v0.6.29 → Release desktop green.
2. Admin portal → B Foods → 0.6.29 → Approve; T1 updates.

**Expected:** T1 reads 0.6.29 (top-left).

## §S — Standard for every client — A369

### S1 — Two switches gone from the admin portal · **Record**
1. Admin portal → B Foods → Features → POS switches.

**Expected:** Five switches: Delivery fee and rider, Cashiers see only their own sales, No reprint for cashiers, Kitchen voids need a manager, Pay before kitchen. No “Blind shift close”, no “Manager sees the cashier's figures”.

### S2 — A cashier never sees the shift figures · **Record**
1. Sign in on T1 as Test Cashier → Shift.
2. Close the shift (enter cash and each method).

**Expected:** No sales, per-method totals or expected cash anywhere — open shift, close, close result. Eugene (owner) still sees them.

## §T — The confirm table — A369
Close a shift as a cashier, then confirm it as a manager.

### T1 — Till: one table · **Record**
1. Manager: confirm the shift (Shift panel or Manager → Close day).
2. Enter a different cash figure from the cashier's.

**Expected:** Top: Cashier name, Shift open – close. Table: Method · Cashier · Manager; the differing row turns amber and a Reason box appears under it; Confirm needs the reason.

### T2 — Web POS and dashboard: the same table
1. Web POS: close and Manager: confirm now.
2. Dashboard → Shifts: confirm an awaiting shift.

**Expected:** The same table on both, reason required where the counts differ.

## §P — After payment

### P1 — A success screen, no print button · **Record**
1. Ring a sale with a tip, pay part cash with change.

**Expected:** “Payment successful”, the order number; Bill, Tip, Paid, each method, Change; one button: New order. No receipt view, no Print receipt. The receipt still prints at payment.

### P2 — A delivery
1. Delivery, rider + fee 500, an item of 3,250 → M-Pesa 3,750.

**Expected:** Bill 3,250 · Delivery fee (rider) 500 · Paid 3,750 · M-Pesa 3,750.

## §H — History — A374

### H1 — All of today's sales
1. Ring more than 30 sales today (or check a busy day).
2. Open History.

**Expected:** Heading “Today's orders …”; every sale of today is listed, not only 30. Yesterday's are not.

### H2 — What was paid, delivery fee included · **Record**
1. Open History after P2.

**Expected:** Total 3,750 with “incl. delivery 500” under it (it showed 3,250).

### H3 — Web POS History
1. Web POS → History.

**Expected:** Today's sales only; a delivery shows the paid amount with “(incl. delivery …)”.

## §D — The delivery fee in the money (re-run of v0.6.27) — A369, A374
Delivery fee and rider switch ON.

### D1 — 3,000 + 400 fee paid by M-Pesa · **Record**
1. Note expected cash and M-Pesa (as a manager: Shift).
2. Delivery, an item of 3,000, fee 400 → M-Pesa 3,400.
3. Look again; print the Z-report.

**Expected:** M-Pesa 400 more than the items (3,400); expected cash 400 lower (the rider's pay-out). Z-report: Delivery fees (in payments) 400, − Paid to riders 400.

### D2 — Voiding a delivery puts the rider's money back (v0.6.27 D4)
1. Void D1's sale (manager).

**Expected:** Expected cash back where it was before D1.

### D3 — The web POS delivery (v0.6.27 D5)
1. Web POS → Delivery → rider + fee 200 → Charge.

**Expected:** Rider and fee required; the total includes 200; the web Z-Report shows Float Out 200.
