# SwiftPOS v0.6.23 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.23.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.23 (A365 follow-ups): a method with nothing recorded is not asked, the mouse wheel never changes a number, “include the opening float”, a manager already signed in confirms without a PIN, and the new dashboard Shift Reports. M1 and M2 passed on 0.6.22. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout

The dashboard (web POS) deploy, then 0.6.23 on the till through the approval. No migration; the cloud is unchanged.

### R1 — Dashboard deployed from dev
1. Deploy the dashboard from the commit that applied the patch; hard-refresh.

**Expected:** The web POS signs in.

### R2 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.23 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.23 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R3 — Approve B Foods for 0.6.23
1. Admin portal → B Foods → 0.6.23 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.23.

## §F — The owner’s follow-ups — A365

On T1 and the web POS.

### F1 — A method with nothing recorded is not asked · **Record**
1. Ring cash and card only (no M-Pesa, no Glovo). Cashier → Close shift.

**Expected:** It asks for the cash and the Card total only — no M-Pesa, no Glovo.

### F2 — The manager counts only what has money on it
1. Manager: confirm now.

**Expected:** Cash and Card only. (A method the till recorded but the cashier put at 0 would still show.)

### F3 — The mouse wheel never changes a number
1. Type 12740 in the cash field, keep the pointer over it and turn the wheel up and down.

**Expected:** The number does not change (the panel may scroll); no up/down arrows on the field.

### F4 — The float reminder
1. Look at the cash label on Close shift (till and web POS).

**Expected:** “Counted cash in drawer (KES) — include the opening float” (web: “Cash Counted (KES) — include the opening float”).

### F5 — A signed-in manager is not asked for a PIN · **Record**
1. Sign in on T1 as the MANAGER; confirm a shift (Manager → Close → Confirm, or confirm now).

**Expected:** No PIN field; confirmed by you. Signed in as a CASHIER, the PIN field is there.

### F7 — Shift Reports: the list · **Record**
1. Dashboard → Finance → Shift Reports (last 7 days).

**Expected:** A row per shift: cashier, till, date/time, status (Running / Awaiting manager check / Confirmed by … / Self-confirmed …), the difference (e.g. “Cash −100”), and View.

### F8 — Shift Reports: View · **Record**
1. Click View on the shift confirmed in M2.

**Expected:** A table per method: Cashier said · Manager counted · Till recorded · Variance — cash −100 in red, the cashier’s different figure highlighted; who confirmed and when. **Print report** gives an A4 “SHIFT REPORT” document (business header, the table, totals, Cashier / Manager signatures) — not a picture of the page. On the list, **Print report** gives the “SHIFT REPORTS” document.

### F9 — Shift Reports: filters and CSV
1. Click Problems, then Running; then Export CSV.

**Expected:** Problems lists only shifts with something off or still awaiting; Running only open shifts; the CSV opens in Excel with the same rows.

### F6 — The same on the web POS
1. Web POS signed in as a manager → close a shift → Manager: confirm now.

**Expected:** Only methods with money on them; no PIN field.

## §M — (0.6.22, carried) A manager confirms every shift — A365

On T1 with a cashier and a manager; ring one cash, one M-Pesa and one card sale first.

### M3 — Close Day waits for every shift · **Record**
1. Open and close another cashier shift (declare every method) — do NOT confirm it.
2. Manager → Close.

**Expected:** “1 shift awaits a manager’s check” with a Confirm button; the close button is held. After Confirm, the day closes as usual (your cash count).

### M4 — A manager’s own shift
1. Manager opens, sells, closes a shift, then confirms it with their own PIN.

**Expected:** Confirmed, marked “(self-confirmed)” on the till and the dashboard.

### M5 — A cashier’s PIN cannot confirm
1. On a closed shift, Confirm with a CASHIER’s PIN.

**Expected:** “That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.”

### M6 — It reaches the cloud; the dashboard shows it · **Record**
1. Wait a minute (till online). Dashboard → Open Shifts → Shift confirmations.

**Expected:** The M2 shift under recent confirmations: confirmed by you, cash counted / expected, the cashier’s different figure shown.

### M7 — Web POS: declare and confirm
1. Web POS as a cashier → Close Shift (declare every method) → Manager: confirm now (manager PIN).

**Expected:** Same as M1–M2 on the web.

### M8 — Dashboard: confirm later
1. Close a web or till shift without confirming. Dashboard → Open Shifts → Shift confirmations → Confirm (as a signed-in manager).

**Expected:** No PIN asked; the recount is blind; the shift moves to recent confirmations.

### M9 — The Z-report says it · **Record**
1. Print the Z-report of the M2 shift (till).

**Expected:** “CONFIRMED BY … HH:MM”, a line per method with counted / expected (short 100) and “cashier said …” where it differs.

## §O — (0.6.20, carried) An offline close-and-reopen never strands a drawer — A363

At a quiet moment, on T1.

### O1 — Close and reopen offline, then reconnect · **Record**
1. Unplug T1’s internet.
2. End Shift (count the drawer), then open a new shift and ring one small sale.
3. Reconnect; wait two minutes.

**Expected:** Sync card: Pending 0, nothing refused. The web picker shows T1 open (the new shift).

## §S — Sync status: managers only — A363

On T1.

### S1 — A cashier sees no sync status · **Record**
1. Sign in as a CASHIER; look at the POS top bar.

**Expected:** No dot, no “Synced”, no “pending”, no Sync button; selling works as always.

### S2 — A manager gets a small notice when something waits · **Record**
1. Sign in as the MANAGER; unplug the internet; ring a sale.
2. Reconnect; press **Sync now** on the notice.

**Expected:** At the bottom: “1 record waiting to sync (offline) · last synced today HH:MM” with Sync now; after it, the notice disappears.

### S3 — “Last synced” on the manager screen
1. Manager screen, top right under your name.

**Expected:** “Last synced: today HH:MM” — plain grey text.

### S4 — The Z-report says what is not backed up · **Record**
1. Internet off; ring a sale; open the shift report (Z) — on screen and printed.
2. Reconnect, sync, open it again.

**Expected:** First: “NOT BACKED UP YET: 1 sale of this shift is only on this till until it syncs.” After syncing: no such line.

## §L — The log tells the truth — A363

After an hour or two of normal trading on 0.6.23.

### L1 — No 401 storm, no false “recovered”
1. Open swiftpos.log; look at the last hour.

**Expected:** No run of “web sales pull failed: HTTP 401” lines, and no “recovered after” line straight after each failure.

## §X — Expenses (carried: built, not yet checked) — A360, A361, A362

Cloud and dashboard deployed (R1).

### X1 — A cashier picks an expense type at the till
1. T1 as a CASHIER → Shift → Expenses.

**Expected:** The type list is filled; record one with a type.

### X2 — Recorded By on the dashboard · **Record**
1. Sync; dashboard → Expenses.

**Expected:** The X1 expense shows its type and **Recorded By** = that cashier.

### X3 — A cashier records an expense on the web POS · **Record**
1. Web POS as a cashier → 🧾 Expense → a type → “Gas refill”, 500 → Record.

**Expected:** “Expense recorded … under your name”; the dashboard lists it (type, Recorded By = the cashier).

### X4 — It comes off the shift’s expected cash
1. End Shift on the web (or the till that shares the drawer).

**Expected:** Expected cash is 500 lower.

### X5 — A web expense by the owner
1. Dashboard → Expenses → Add Expense (any Paid By).

**Expected:** Recorded By = you, whatever Paid By says.
