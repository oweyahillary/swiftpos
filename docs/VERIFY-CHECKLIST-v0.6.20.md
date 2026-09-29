# SwiftPOS v0.6.20 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.20.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.20 is a sync-reliability release (A363): an offline close-and-reopen never strands a drawer (the cloud writes closing days first; the till re-sends a parked day/shift once), sync status for managers only, “Last synced”, the Z-report note, and a truthful log. It also carries the expense checks A360–A362. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (in order)

Cloud first (it writes closing trading days first), then the dashboard, then 0.6.20 on the till through the approval. No migration.

### R1 — Cloud and dashboard deployed from dev
1. Deploy the cloud, then the dashboard, from the commit that applied the patch; hard-refresh the dashboard.

**Expected:** Both load; the web POS signs in.

### R2 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.20 → Actions → Release desktop green (incl. “Verify the release”) → Releases.

**Expected:** One v0.6.20 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R3 — Approve B Foods for 0.6.20 · **Record**
1. Admin portal → B Foods → 0.6.20 → Approve; restart T1, close and reopen when the update is ready. **Do not close today’s shift on T1 before U1.**

**Expected:** T1 reads 0.6.20.

## §U — Unstick T1 (this morning’s shift) — A363

T1 online, on 0.6.20, left signed in for two minutes.

### U1 — Today’s shift reaches the cloud by itself · **Record**
1. Technician mode → Sync card.
2. Open %APPDATA%\SwiftPOS\swiftpos.log (Notepad), look at the last lines.

**Expected:** Pending 0, nothing parked. The log has “A363 re-sending once after a trading-day clash: 1 day(s), 1 shift(s)”.

### U2 — The two morning sales are on the dashboard
1. Dashboard → Orders, today, T1.

**Expected:** The 1,390 Glovo and 3,250 M-Pesa sales of 09:55–09:56 are there.

### U3 — The web joins T1 without a float · **Record**
1. Web POS → sign in → the till picker.

**Expected:** “T1 — Left Till · open — Eugene, since 09:55”; choosing it goes straight in, **no opening float**.

## §O — An offline close-and-reopen never strands a drawer — A363

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

After an hour or two of normal trading on 0.6.20.

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
