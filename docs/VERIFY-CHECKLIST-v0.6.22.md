# SwiftPOS v0.6.22 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.22.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.22 (A365): a manager confirms every shift — the cashier declares every payment method at End Shift, a manager recounts every method blind (now or later; till, web POS, dashboard), and Close Day waits for them. **Migration 110 before the cloud.** It carries the 0.6.20 checks not yet run (§O §S §L §X). **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (in order)

Migration first (the cloud writes the new columns), then the cloud, the dashboard, then 0.6.22 on the till through the approval.

### R1 — Migration 110 applied · **Record**
1. Supabase → SQL editor → run migrations/110_shift_confirmation.sql, then:
```sql
select column_name, data_type from information_schema.columns
 where table_name = 'shifts' and column_name in
 ('declared_methods','expected_methods','confirmed_methods','confirmed_by','confirmed_at','confirm_self');
```

**Expected:** Six rows: declared_methods, expected_methods, confirmed_methods (jsonb), confirmed_by (uuid), confirmed_at (timestamptz), confirm_self (boolean).

### R2 — Cloud and dashboard deployed from dev
1. Deploy the cloud, then the dashboard, from the commit that applied the patch; hard-refresh the dashboard.

**Expected:** Both load; the web POS signs in.

### R3 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.22 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.22 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R4 — Approve B Foods for 0.6.22
1. Admin portal → B Foods → 0.6.22 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.22.

## §M — A manager confirms every shift — A365

On T1 with a cashier and a manager; ring one cash, one M-Pesa and one card sale first.

### M1 — The cashier declares every method · **Record**
1. Cashier → Shift → Close shift.

**Expected:** Besides the cash count it asks for M-Pesa, Card, Glovo (and any custom tender) totals; Close is refused until each has a number (0 if none).

### M2 — Confirm now, blind · **Record**
1. After the close: **Manager: confirm now**. Enter your own counts (enter cash 100 LESS than the drawer to test) and your manager PIN.

**Expected:** No cashier or expected figure is shown before saving. After: a line per method — cashier / counted / expected; cash shows “short 100”, highlighted where your count differs from the cashier’s.

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

After an hour or two of normal trading on 0.6.22.

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
