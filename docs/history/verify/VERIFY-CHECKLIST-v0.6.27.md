# SwiftPOS v0.6.27 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.27.html`. 0.6.27: a prospect's requests as per-client switches (admin
portal) — delivery fee paid to the rider, expense payment method, cashier-only History, no reprint, blind close, the manager's
reasons (A369); the dashboard's Add expense fixed (A370); the till's on-screen receipt tip (A371). It contains 0.6.26 — run
v0.6.26's §X too if not yet run. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout
Apply 0.6.26's patch first, then this one. Migration 111 BEFORE the cloud.

### R0 — Migration 111, then cloud, dashboard, admin portal
1. Run migration 111 on the database.
2. Deploy the cloud, the dashboard and the admin portal; hard-refresh.

**Expected:** The web POS signs in; the dashboard and admin portal load.

### R1 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.27 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.27 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R2 — Approve B Foods for 0.6.27
1. Admin portal → B Foods → 0.6.27 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.27.

## §S — The switches — A369
Admin portal → B Foods → Features.

### S1 — Five named POS switches, all off · **Record**
1. Open Features.

**Expected:** “POS switches”: Blind shift close, Delivery fee and rider, Cashiers see only their own sales, No reprint for cashiers, Manager sees the cashier's figures when confirming — each with a line saying what it does, all OFF.

### S2 — Switch them on for the test
1. Turn all five on.
2. On T1 press Sync (or wait 10 minutes); refresh the web POS.

**Expected:** They stay on after a page refresh. (Turn them off again after testing if B Foods should not keep them.)

## §D — Delivery fee — A369, A371
Switch “Delivery fee and rider” on. Restaurant mode, order type Delivery.

### D1 — Rider and fee are required
1. On T1: Delivery → add an item → Pay without a rider or fee.
2. Enter the rider, still no fee → Pay.

**Expected:** “Enter the rider's name for this delivery.” then “Enter the delivery fee for this delivery.” — payment does not open.

### D2 — A 1,000 order + 300 fee paid by M-Pesa · **Record**
1. Note T1's expected cash (Shift).
2. Delivery, rider Eugene, fee 300, an item of 1,000 → Pay → M-Pesa 1,300.
3. Look at the receipt, History and the Shift panel.

**Expected:** Payment says Delivery fee — Eugene 300, total due 1,300. Receipt: Total 1,000, Delivery fee 300, PAY 1,300. History type “Delivery — Eugene”. Expected cash 300 lower; Z-report: Delivery fees (in payments) 300, − Paid to riders 300; M-Pesa 1,300.

### D3 — The on-screen receipt with a tip
1. Ring any sale with a tip of 50 (Discount / tip) and pay.

**Expected:** The on-screen receipt shows Tip 50 once and PAY = bill + 50 (no “Round Off” of 50).

### D4 — Voiding a delivery puts the rider's money back
1. Void the D2 sale (manager, within the window).
2. Look at the Shift panel.

**Expected:** Expected cash is back where it was before D2 (the 300 pay-out is returned).

### D5 — The web POS · **Record**
1. Web POS → a table/order → Delivery → rider + fee 200 → Charge (M-Pesa or cash).

**Expected:** Rider and fee required; the payment total includes 200; the web receipt shows Delivery fee 200; the web POS Z-Report shows Float Out 200 (the rider's pay-out).

## §E — Expenses — A369, A370

### E1 — An M-Pesa expense is not taken from the drawer · **Record**
1. On T1: Shift → Expenses → type Transport, description boda, 200, Paid with M-Pesa → Save.
2. Look at the Shift panel and print the Z-report.

**Expected:** Expected cash unchanged; M-Pesa expected 200 lower (at confirm). Z-report: “Transport — boda · M-Pesa” and EXPENSES NOT FROM THE DRAWER − M-PESA 200.

### E2 — The Z-report shows the expense type
1. Record a cash expense with a type (e.g. Gas) and a description.

**Expected:** The Z-report line reads “Gas — <description>” (the type first).

### E3 — Adding an expense from the dashboard works · **Record**
1. Dashboard → Expenses → Add expense (any type, Paid with M-Pesa) → Save.

**Expected:** Saved (it used to fail “Validation failed”); the list shows it with Paid With M-Pesa.

## §H — History — A369
Switches “Cashiers see only their own sales” and “No reprint for cashiers” on.

### H1 — A cashier sees only their own sales, no Reprint · **Record**
1. Sign in on T1 as cashier A, ring a sale; as cashier B, ring one.
2. As B open History.

**Expected:** Only B's sale; “Your last 30 sales”; no Reprint button.

### H2 — Filters and order
1. In History pick a payment method, then a type; change “Order by”.

**Expected:** The list narrows to that payment / type; Order by Payment method or Type groups them.

### H3 — A manager sees all and can reprint
1. Sign in as a manager → History.

**Expected:** Every sale; Reprint is there.

### H4 — The web POS
1. Web POS as a cashier → Orders.

**Expected:** Only their sales (“Your sales only”), no Reprint receipt; type / payment filters work.

## §B — Blind shift close — A369
Switch “Blind shift close” on.

### B1 — A cashier closes without seeing figures · **Record**
1. On T1 as a cashier: Shift.
2. Enter the counted cash and each method → Close (with a difference on purpose).

**Expected:** No sales, per-method totals or expected cash anywhere; no note is demanded; after closing: “Your count is saved. A manager checks it…”, no Print Z-report.

### B2 — A manager closing sees everything
1. As a manager, open and close a shift.

**Expected:** The usual figures and expected cash.

### B3 — The web POS
1. Web POS as a cashier → Close Shift.

**Expected:** Only a box per method used; the result shows no expected cash or variance.

## §C — The manager sees the cashier's figures — A369
Switch “Manager sees the cashier's figures when confirming” on.

### C1 — Confirm on the till with a reason · **Record**
1. Confirm B1's shift (Manager: confirm now, or Manager → Close).
2. Enter a different cash count than the cashier.

**Expected:** “Cashier entered …” beside each box; a reason box appears for the differing method and is required; after saving, the reason shows and prints on the Z-report.

### C2 — Dashboard and web POS
1. Dashboard → Shift confirmations → Confirm (or web POS → Manager: confirm now).

**Expected:** The same: the cashier's figures, a required reason where different; the dashboard list shows the reason.

## §O — Switches off — A369

### O1 — Everything as 0.6.26
1. Turn all five off in the admin portal; Sync T1.

**Expected:** Delivery without a fee as before; cashiers see all History with Reprint; the close shows figures; the confirm is blind.
