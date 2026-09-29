# SwiftPOS v0.6.21 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.21.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.21 is a till-only fix (A364): a day close is a cash-up — a shift opened after today’s day was closed reopens it (was “That record already exists.”), and the next close counts only the cash since while the row keeps the whole day. It carries the 0.6.20 checks not yet run (§O §S §L §X). **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout

Till only — no cloud or dashboard deploy, no migration. The cloud already accepts a trading day going from closed back to open.

### R1 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.21 → Actions → Release desktop green (incl. “Verify the release”) → Releases.

**Expected:** One v0.6.21 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R2 — Approve B Foods for 0.6.21
1. Admin portal → B Foods → 0.6.21 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.21.

## §D — A day close is a cash-up; the next shift reopens the day — A364

On T1, today — the day was already closed this afternoon.

### D1 — A cashier opens a shift after the day was closed · **Record**
1. Sign in as the CASHIER → Open your drawer → count the float → Start selling.

**Expected:** The shift opens and selling works. **No “That record already exists.”**

### D2 — The Day Close screen shows only the cash since · **Record**
1. Ring a cash sale; End Shift (count the drawer).
2. Manager → Close the day; reveal the expected cash.

**Expected:** The screen says “This is a cash-up …”. Expected cash covers ONLY the shift(s) since the reopen, not the morning’s.

### D3 — Close it again
1. Enter your count → Close the day.

**Expected:** Closes as usual; a variance only if your count differs from the shift(s) since the reopen.

### D4 — The cloud row holds the whole day
1. After a sync, run in the Supabase SQL editor:
```sql
select business_date, status, counted_cash, expected_cash, cash_variance, notes
  from business_days
 where device_id = 'ed377ee4-bbe6-46c1-8fd7-e851d9edadb9'
 order by business_date desc limit 2;
```

**Expected:** One row for today, status closed; counted/expected = morning cash-up + this one; the notes have a “Cashed up HH:MM: counted … Reopened HH:MM by …” line.

### D5 — Still one shift per till at a time
1. With a shift open on T1, sign in as another cashier → try to open a drawer.

**Expected:** Refused: “A shift opened by … is already running. Close it first.” (overlapping cashiers use another till).

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

After an hour or two of normal trading on 0.6.21.

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
