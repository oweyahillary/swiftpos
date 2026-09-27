# SwiftPOS v0.6.13 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.13.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

Covers everything still open from 0.6.9 → 0.6.13. Do §R first. You need a manager PIN and a cashier PIN that have each signed in online on the till, the owner and a manager login for the dashboard, and the web POS. **Record** = send a screenshot/photo. A **Fail** needs a note saying exactly what you saw.

## §R — Rollout (do these first, in order) — prerequisite for everything below

### R1 — Migration 107 is applied on the live database · **Record**
1. Open the Supabase SQL editor for the database the cloud (Render) uses.
2. Run the two queries below.

```sql
SELECT version, applied_at FROM public.schema_migrations
 WHERE version = '107_open_shifts_never_block_sync';
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname='public' AND tablename='shifts'
   AND indexname IN ('shifts_one_open_per_terminal','shifts_open_by_terminal');
```

**Expected:** Query 1 returns ONE row with today's date. Query 2 returns ONE row, **shifts_open_by_terminal**, whose definition starts **CREATE INDEX** (not CREATE UNIQUE INDEX). **shifts_one_open_per_terminal** is gone.

### R2 — Cloud deployed from dev
1. Render → the API service → deploy the latest dev commit (0e5e1b3 or later).
2. Wait for “Live”.

**Expected:** Deploy finished without errors; the dashboard and web POS still sign in.

### R3 — Dashboard deployed from dev
1. Deploy the dashboard from the same dev commit.
2. Hard-refresh the browser (Ctrl+Shift+R).

**Expected:** Dashboard loads; nothing looks broken.

### R4 — Every till is on 0.6.13 · **Record**
1. Install the 0.6.13 installer on each till (or let auto-update finish and restart).
2. Technician mode / About → read the version.

**Expected:** Each till reads **0.6.13**.

## §H — Sync: one shift never blocks another — closes A338 (0.6.12)

The till that was not syncing while a web shift was open.

### H1 — The stuck till catches up · **Record**
1. BEFORE installing 0.6.13 on the stuck till: Technician mode → Sync card → screenshot the pending count.
2. Install 0.6.13, sign in online, leave it online for about a minute (or press Force sync).
3. Technician mode → Sync card again.
4. Dashboard → Open shifts / Reports → find that till's shift and its sales.

**Expected:** Pending count falls to **0** (no failed items). The till's shift, its sales, floats and expenses now appear on the dashboard.

### H2 — Web and till each with a shift on the same till — both sync
1. On the till (T1) open a shift if none is open.
2. Web POS: sign in and, if offered a picker, choose T1 — if it joins T1's open shift that is fine; to create the clash, use a till that had its own shift before the web opened one (e.g. a till that was offline).
3. Ring one cash sale on the web and one on the till.
4. Wait ~30 s, then check the dashboard.

**Expected:** Both sales reach the dashboard. Nothing stays pending on the till's Sync card.

### H3 — Closing the till's shift does not disturb the web's
1. On the till close its shift (count the cash).
2. Dashboard → Open shifts.

**Expected:** The till's shift shows **closed** on the cloud with the till's expected cash; the web's shift (if any) is still open and untouched.

### H4 — A second shift still cannot be opened BY HAND
1. While T1 has an open shift, on the web POS try to open a NEW shift on T1 with a float.

**Expected:** It does not create a second drawer — it offers to **join** the open one (or says the terminal already has an open drawer).

## §J — Sign-in and staff roles — closes A339, A340 (0.6.13)

### J1 — A manager signing in OFFLINE reaches the manager screen · **Record**
1. On the till turn Wi-Fi / network OFF.
2. Sign out to the PIN pad, enter the MANAGER PIN.
3. Then sign out and enter the CASHIER PIN.
4. Turn the network back ON.

**Expected:** Manager → **manager screen**. Cashier → **till (POS) screen**. A wrong PIN is refused.

### J2 — Till: a manager is not offered Owner · **Record**
1. On the till sign in as the MANAGER (online).
2. Manager screen → Staff → Add staff → open the Role list.

**Expected:** The list has **no Owner, Admin, Manager or Supervisor** — only roles like Cashier. Adding a cashier still works.

### J3 — Dashboard: a manager is not offered Owner, and cannot invite one · **Record**
1. Sign in to the dashboard as a MANAGER (not the owner).
2. Settings (or Users & Access) → Staff → Add staff → open the Role list. Check both the PIN and the “Invite by email” modes.
3. Invite a CASHIER by email.

**Expected:** No Owner / Admin / Manager / Supervisor in the list in either mode. The cashier invite succeeds and the new person is on the manager's own branch.

### J4 — The owner is unaffected
1. Sign in to the dashboard as the OWNER.
2. Staff → Add staff → Role list.

**Expected:** Every role is listed, including Owner and Manager. (Creating a second owner is optional — only if you want one.)

## §B — Shared shift, web opens first (re-run of B5–B7) — closes A334, A273 follow-up

Use one till (T1) and the web POS. Start with no open shift on T1.

### B1 — Web opens T1's shift
1. Web POS as Cashier A → pick T1 → opening float e.g. 1,000 → open.

**Expected:** Shift opens on the web.

### B2 — Same cashier on the till goes straight in
1. On the till sign in as Cashier A.

**Expected:** Straight to selling — no “open shift” prompt, no notice.

### B3 — Another cashier is told whose shift it is · **Record**
1. Sign out; sign in as Cashier B on the till.

**Expected:** “T1 — … is already open — opened by Cashier A at HH:MM on the web POS” → Continue → selling, no float asked, no second drawer.

### B4 — One sale on each
1. Ring one CASH sale on the web (e.g. 700) and one CASH sale on the till (e.g. 400).

**Expected:** Both complete.

### B5 — The till's shift panel counts each sale ONCE · **Record**
1. On the till open the shift panel (close screen).

**Expected:** Expected cash = **float + till sale + web sale** (e.g. 1,000 + 400 + 700 = **2,100**) — not more. It says “Includes the web POS on this drawer: 1 sale, … cash”.

### B6 — Close on the till balances · **Record**
1. Close the shift on the till counting exactly the expected cash.

**Expected:** Variance **0**, no note required.

### B7 — The dashboard agrees
1. Wait ~30 s. Dashboard → Open shifts / Reports.

**Expected:** The shift is **closed** with the same expected cash, and T1 has one shift for it (not two).

## §F — Web sales appear on the till — closes A336 stage 1, A335 (0.6.10)

Needs a shift open on T1 shared with the web (as in §B).

### F1 — A web sale shows on the till · **Record**
1. Ring a sale on the web POS on T1's shift.
2. Wait ~20 s. On the till open the POS recent orders list.

**Expected:** The sale is listed with a small **web** tag.

### F2 — …and is in the till's shift figures
1. Open the till's shift panel.

**Expected:** Order count includes it; cash (if cash) is in expected cash exactly once.

### F3 — A void on the web reaches the till
1. On the web, void that sale as a manager (within 30 min).
2. Wait ~20 s; check the till's recent orders and shift panel.

**Expected:** It shows **voided** on the till and expected cash drops by its amount.

### F4 — Branch view: all tills from the cloud · **Record**
1. Till → Manager screen → Orders → switch to **All tills at this branch**.
2. Then turn the network OFF and look again; turn it back ON.

**Expected:** Online: other tills' sales are listed, this till's marked “this till”. Offline: an amber line “The cloud could not be reached — showing this till only.”

### F5 — Void and refund a TILL sale from the till
1. Ring a sale on the till; within 30 min void it (manager PIN).
2. Ring another; refund it (owner/manager).

**Expected:** Both succeed — no “Order not found”. The dashboard shows them voided / refunded.

### F6 — Shift changes reach the cloud fast
1. Open a shift on the till; watch the dashboard's Open shifts.

**Expected:** It appears within about **30 s**.

## §G — Reports (0.6.11) — closes A337

### G1 — Expenses on the shift report — the lines add up · **Record**
1. On the till: Shift → Expenses → record an expense, e.g. 150 “Gas”.
2. Manager screen → Shift → Shift report.

**Expected:** The report shows “**− Expenses 150**” and an EXPENSES section (Gas, who paid). Opening float + Cash sales + Float in − Float out − Expenses = Expected cash.

### G2 — The printed report matches · **Record**
1. Print report.
2. Also record an expense with a long description and print again (58 mm if you have it).

**Expected:** Paper shows the same “- Expenses” line and EXPENSES section; a long description wraps fully with the amount under it.

### G3 — Previous shift reports · **Record**
1. Close the shift.
2. Manager screen → Shift → Shift report → open the picker.
3. Choose the shift you just closed → Print report.

**Expected:** The picker lists past shifts (date/time → close · cashier). The chosen one opens as its Z-report (closed, counted, variance) and prints.

### G4 — Expenses screen
1. Manager screen → **Expenses** (new tab).
2. Switch the range Today → Last 7 days.

**Expected:** Today's expense(s) with who paid and a total; the range changes the list.

### G5 — Daily Sales Report is colour-coded, numbers unchanged · **Record**
1. Manager screen → Orders → Daily Sales Report (.xlsx) → open in Excel.

**Expected:** Teal title band, dark-teal section bands, pale-teal column headings, gray section totals, **amber Total Gross** and collections Total, red warnings if any. The numbers match what 0.6.10 gave for the same day.

## §D/E — Light mode (not reported last round) — closes A332, A333

Dashboard → sidebar → Light mode.

### D5 — Web POS light mode with a theme ON and with themes OFF · **Record**
1. With a theme on (e.g. Violet): open the web POS; hover Charge / Pay / Apply; click into a text box.
2. Repeat with themes OFF.

**Expected:** Labels stay readable on hover, the focus ring is the theme colour (teal when off). One screenshot per mode.

### E1 — Back office readable in light mode · **Record**
1. Purchase orders, Staff, Reports, Overview.

**Expected:** Status badges (active, received), red OUT/low, amber pills, blue tags and links are all readable; row lines are faint.

### E2 — Sign-in page stays dark
1. Sign out.

**Expected:** White text on navy — not dark text.

### E3 — Dark mode unchanged
1. Switch back to dark mode and look over the same screens.

**Expected:** Everything looks as before.

## §X — Regression (release-blocker if any fail)

### X1 — Normal sale and receipt
1. Ring a sale, take payment, print the receipt.

**Expected:** Receipt prints as before.

### X2 — Kitchen ticket
1. Ring an item that goes to the kitchen (if you use one).

**Expected:** Kitchen ticket prints as before.

### X3 — Day close
1. Close all shifts, then Manager → Close Day.

**Expected:** Day closes; figures look right.

### X4 — Sync healthy at the end · **Record**
1. Technician mode → Sync card.

**Expected:** Pending 0, no failures, no red errors.

### X5 — Second till (if you have one)
1. Sign in on T2 and ring a sale.

**Expected:** Works; its sale reaches the dashboard.
