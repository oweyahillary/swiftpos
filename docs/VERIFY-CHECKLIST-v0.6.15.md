# SwiftPOS v0.6.15 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.15.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.15 adds A345 (a manager signed in offline: the right message, the saved menu and staff read-only, and unlocking by itself when the network returns), and carries the 3 checks skipped on 0.6.14. Till only — nothing to deploy on the cloud or the dashboard. Do §R first. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout — prerequisite for everything below

Till only this time — nothing to deploy on the cloud or the dashboard, no migration.

### R1 — Every till is on 0.6.15 · **Record**
1. Install 0.6.15 (or let auto-update finish and restart).
2. Technician mode / About → version.

**Expected:** Each till reads **0.6.15**.

## §O — A manager signed in OFFLINE — closes A345

You need a MANAGER PIN that has signed in on this till online at least once, and a cashier PIN. “Network off” = unplug the cable / turn Wi-Fi off on the till.

### O1 — Staff page offline says so and shows the saved staff · **Record**
1. Network OFF. Sign out to the PIN pad; enter the MANAGER PIN (you land on the manager screen).
2. Open **Staff**.

**Expected:** An amber box: “**You signed in while offline.** Menu, staff and settings changes are saved on the cloud — once the till is online they unlock by themselves (or lock the till and sign in again). Selling is not affected.” Under it: “Showing the staff who have signed in on this till — read-only.” The list shows names and roles. **No** “Add staff member”, **no** Deactivate. Never “This till is not signed in”.

### O2 — Menu page offline shows the till’s menu, read-only · **Record**
1. Still offline, open **Menu**.
2. Try to change a price. Click a combo item.

**Expected:** The same amber box, then “Showing the menu saved on this till — read-only.” The items, categories and prices the till sells (“N of N items”, not “0 of 0”). Prices cannot be changed; no Import / export button. A combo shows a read-only card with its price and “Comes with”.

### O3 — Settings → Payment methods offline
1. Still offline, open **Settings** → Payment methods.

**Expected:** It says “You signed in while offline … Showing what’s active on this till.” (not “Can’t reach the server”). The till’s methods are listed.

### O4 — Selling is not affected
1. Still offline: Open POS, ring a cash sale, print the receipt.

**Expected:** The sale goes through and prints as usual.

### O5 — Network back → the manager screens unlock by themselves · **Record**
1. Network ON. Stay signed in — do **not** sign out.
2. Wait about a minute, then go to Menu → **Try again** (or Refresh), then Staff.

**Expected:** No PIN asked. Menu: no amber box, prices editable, Import / export back. Staff: the full list from the cloud and “Add staff member” back. (If it is still amber after 2 minutes, press Try again once more, then note what it says.)

### O6 — The offline sale reached the cloud
1. Technician mode → Sync card; then the dashboard’s orders for today.

**Expected:** Pending 0. The O4 sale is on the dashboard with the manager as cashier.

### O7 — Signed in online, then the network drops
1. Sign out; sign in as the manager with the network ON.
2. Network OFF. Open Menu, then Staff.

**Expected:** Amber box “No connection — menu and staff changes need internet …” and the saved menu / staff, read-only, as in O1–O2. Network ON → Try again → editable again.

### O8 — A void by the offline-signed-in manager
1. Network OFF; sign in as the manager (offline). Network ON; **straight away** void a sale from this shift (manager PIN).

**Expected:** The void goes through (the till turns the offline sign-in into an online one first) — no “This till is not signed in”.

## §S — Skipped last round (0.6.14) — A342, A335

### K4 — A web close never closes the till’s shift
1. Set up two shifts on T1 as for §K last time (till offline while the web opens T1, then back online).
2. Close the WEB shift first (from the web POS).
3. Look at the till.

**Expected:** The till’s shift is still open and selling.

### F5 — Void and refund a TILL sale from the till
1. Ring a sale on the till; within 30 min void it (manager PIN).
2. Ring another; refund it (owner/manager).

**Expected:** Both succeed — no “Order not found”. The dashboard shows them voided / refunded.

### X5 — Second till (if you have one)
1. Sign in on T2 and ring a sale.

**Expected:** Works; its sale reaches the dashboard.

## §X — Regression (release-blocker if any fail)

### X1 — Normal sale and receipt
1. Ring a sale, take payment, print the receipt.

**Expected:** Receipt prints as before.

### X2 — Kitchen ticket
1. Ring an item that goes to the kitchen (if you use one).

**Expected:** Kitchen ticket prints as before.

### X3 — Online sign-in unchanged
1. Network ON: sign in as a cashier, then as the manager.

**Expected:** Cashier → till; manager → manager screen; Menu and Staff editable straight away.

### X4 — Sync healthy at the end · **Record**
1. Technician mode → Sync card.

**Expected:** Pending 0, no failures, no red errors.
