# SwiftPOS v0.6.24 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.24.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.24: only the cashier who opened a shift, or a manager, can close it (A366); the update bar no longer covers the till (C5); notes on an item and on the order (A367, §N). Nothing carried — every earlier check has passed. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout

The cloud and dashboard deploy, then 0.6.24 on the till through the approval. No migration.

### R1 — Cloud and dashboard deployed from dev
1. Deploy the cloud, then the dashboard; hard-refresh.

**Expected:** The web POS signs in.

### R2 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.24 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.24 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R3 — Approve B Foods for 0.6.24
1. Admin portal → B Foods → 0.6.24 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.24.

## §C — Only the shift’s owner or a manager closes it — A366

On T1 with cashier A, cashier B and a manager.

### C1 — Another cashier cannot close it · **Record**
1. Cashier A opens a shift and rings a sale.
2. Lock / switch: sign in as cashier B → Shift.

**Expected:** No count form: “This shift belongs to A. Only A or a manager can close it — ask them to sign in.” B can still sell, pay in/out and record expenses.

### C2 — The owner closes it
1. Sign in as A → Shift → Close shift.

**Expected:** The count form is there; the close works as usual (then the manager confirms).

### C3 — A manager can close someone else’s shift
1. Open a shift as A; sign in as the MANAGER → Shift.

**Expected:** The count form is there; the manager can close it (closed by the manager).

### C4 — The web POS · **Record**
1. Web POS: sign in as cashier B on a shift A opened (or joined T1’s) → Close Shift.

**Expected:** “This shift belongs to A. Only A or a manager can close it.” As A or a manager, the form appears.

### C5 — The update bar never covers the screen · **Record**
1. With an update downloaded (the "Update ready" bar at the bottom), go to Close → Close Day and scroll to the bottom.
2. Open POS: ring a sale and look at the Pay button; with a sync notice showing, look at where it sits.

**Expected:** The page ends above the bar — the Close the day button, Pay and the rest are all visible and clickable. The sync
notice sits above the bar, not under it. A dialog (payment, PIN) covers the bar, not the other way round.

### C6 — The locked till shows the logo and reads clearly · **Record**
1. With a logo set (Branding), wait for the till to lock (or let it idle), with a busy screen behind it.

**Expected:** The client's logo on a white card above "Till locked"; nothing from the screen behind shows through; "Enter …'s
PIN to continue" and "Nothing was lost…" are easy to read. Without a logo, the padlock as before.

## §N — Notes in the order — A367
On T1 (0.6.24) and the web POS. A kitchen printer helps; without one, look at the KDS and the receipt.

### N1 — A note on a line · **Record**
1. Ring 5 × Chicken Piece. Under the line press **+ Note**, type `3 normal`, new line `2 spicy` → Save note.

**Expected:** Under the line: `» 3 normal` / `» 2 spicy`. The price and total do not change.

### N2 — Quick picks
1. Ring a Pizza → **+ Note** → tap **Extra cheese**, then tap it again, then tap **Extra cheese** and **No onions** → Save.

**Expected:** The second tap takes the pick off; the saved note reads `» Extra cheese` / `» No onions`.

### N3 — A plain tap does not join a noted line
1. With the noted Chicken Piece line in the cart, tap Chicken Piece on the grid once.

**Expected:** A new plain line (qty 1) appears; the noted line stays 5 with its note.

### N4 — A note on the whole order · **Record**
1. Press **+ Note for the order** above the totals → `Deliver to gate B` → Save. Send to kitchen, then charge the sale.

**Expected:** The kitchen ticket shows `NOTE: Deliver to gate B` under the header and `** 3 normal` / `** 2 spicy` under the
chicken; the receipt shows `Note: Deliver to gate B` and the `**` lines. A sale with no notes prints as before.

### N5 — Hold and recall
1. Put notes on a line and the order → Hold → recall the tab.

**Expected:** Both notes come back. Changing a line's note after Send to kitchen sends that line again.

### N6 — The cloud and the KDS · **Record**
1. After N4 syncs: open the KDS (if used) and, in Supabase, `select order_number, notes from orders order by created_at desc limit 1;`

**Expected:** The KDS shows the order note above the dishes and each line's note. The query shows `Deliver to gate B`.

### N7 — The owner's quick picks
1. Dashboard → Settings → Business → **Restaurant setup** → **🍽 Service** → **Quick notes for orders** (below "Keep off the kitchen ticket"): remove one, add `Half portion`, click outside the box.
2. On T1: Sync (or wait for the next sync) → open a note.

**Expected:** The till offers the new list. Emptying the box and syncing leaves no quick picks (typing still works).

### N8 — The web POS
1. Web POS (restaurant cashier screen): add a note to a line and the order, Send to kitchen / charge.

**Expected:** Same editor and picks; the kitchen print and the receipt carry the notes; the KDS shows them.

## Recorded before this build (2026-09-30)
0.6.23 F1–F9 PASS · 0.6.22 M1–M9 PASS · carried S1–S4, O1, L1, X1–X5 PASS — no longer carried (A365, A363, A360–A362 closed).
0.6.21 D1–D5 all PASS (A364 closed).
