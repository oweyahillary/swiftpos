# SwiftPOS v0.6.14 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.14.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.14 adds A342 (closing on the till closes the web’s shift on that till), A343 (web till: join or start your own), A344 (payment colours), and carries the 8 checks skipped on 0.6.13. Do §R first. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (do these first, in order) — prerequisite for everything below

No migration this time.

### R1 — Cloud deployed from dev
1. Render → the API service → deploy the latest dev commit.
2. Wait for “Live”.

**Expected:** Deploy finished; the dashboard and web POS still sign in.

### R2 — Dashboard deployed from dev
1. Deploy the dashboard from the same commit.
2. Hard-refresh the browser (Ctrl+Shift+R).

**Expected:** Dashboard loads; nothing looks broken.

### R3 — Every till is on 0.6.14 · **Record**
1. Install 0.6.14 (or let auto-update finish and restart).
2. Technician mode / About → version.

**Expected:** Each till reads **0.6.14**.

## §K — Closing on the till also closes the web’s shift on that till — closes A342

You need the web POS with its OWN shift on T1 while T1 has its own (a till that was offline when the web opened T1, as in H2 last time).

### K1 — The till’s shift panel says the web’s shift is counted here · **Record**
1. Ring a cash sale on the web’s shift (e.g. 230) and one on the till’s (e.g. 400).
2. On the till open the shift panel (close screen).

**Expected:** An amber line: “Also counted in this drawer: the web POS’s own shift on this till (<name>), expected … Closing here closes it too.” Expected cash = till float + till cash + the web shift’s expected (its float + its cash).

### K2 — One count balances both · **Record**
1. Count the drawer and close on the till, entering exactly the expected cash.

**Expected:** Variance **0**, no note required. The Z-report shows “+ Web shift on this till”, on screen and on paper.

### K3 — The dashboard shows BOTH shifts closed · **Record**
1. Wait ~30 s. Dashboard → shifts / reports for today.

**Expected:** The till’s shift closed with the combined expected; the web’s shift **closed** too, with the note “Closed with T1’s count (shift …) — its cash was counted in that drawer.”

### K4 — A web close never closes the till’s shift
1. Set up the two shifts again; this time close the WEB shift first (from the web POS).
2. Look at the till.

**Expected:** The till’s shift is still open and selling.

## §L — Web sign-in: join the running shift, or your own on the web till — closes A343

Use two cashiers, A and B, and one till T1. The web till is named “<Branch> Web Till”.

### L1 — The cashier who opened the till’s shift goes straight in on the web
1. On the till (T1) sign in as A and open a shift.
2. On the web POS sign in as A.

**Expected:** Straight to selling in A’s T1 shift — no picker, no float.

### L2 — Another cashier is asked: join it, or start their own · **Record**
1. On the web POS sign out; sign in as B.

**Expected:** The shift picker opens. It says “A’s shift is running on T1 … Join it, or start your own shift on **<Branch> Web Till**”, and the list starts with “<Branch> Web Till · your own shift”.

### L3 — B starts their OWN shift on the web till · **Record**
1. Choose “<Branch> Web Till”, enter an opening float (e.g. 500), Open Shift.
2. Ring a sale.

**Expected:** B is selling in their own shift. On the dashboard it shows as B’s shift, separate from A’s on T1.

### L4 — B signs in again on the web → straight into B’s own shift
1. Sign out; sign in as B on the web again.

**Expected:** Straight to selling in B’s web-till shift — no picker.

### L5 — On the till nothing changes
1. On T1 sign out; sign in as B.

**Expected:** B proceeds into T1’s running shift (A’s), as before — with the usual “already open” notice.

### L6 — Joining is remembered
1. On the web, sign in as a third cashier C (or as B after B closes their own shift). Choose T1 → Join this drawer.
2. Sign out and sign in as the same cashier again on the same browser.

**Expected:** Second time: straight in, no picker.

## §M — Payment methods in colour — closes A344

Compare with the preview image sent with 0.6.14.

### M1 — Till payment buttons · **Record**
1. Ring a sale → Charge.
2. Look at Cash / M-Pesa / Card / Glovo (and any custom tender); tap each in turn.

**Expected:** Each unselected button is tinted in its own colour with a coloured dot (Cash amber, M-Pesa green, Card blue, Glovo orange). The selected one shows the usual theme highlight. All labels readable.

### M2 — Web POS payment buttons — dark and light · **Record**
1. Web POS → Charge; look at the method buttons.
2. Switch the POS to light mode and look again.

**Expected:** Same colours in both modes; On Account violet; labels readable; the selected one uses the theme.

### M3 — Dots in the till’s lists · **Record**
1. Till: POS recent orders; Manager → Orders; Manager → Overview (payment breakdown); Shift panel.

**Expected:** Each method name has its coloured dot; the Overview breakdown bars are in the method colours.

### M4 — Dots in the web POS lists
1. Web POS: Order history; Reports (payment breakdown).

**Expected:** Method dots in order history; the report’s method bars in the method colours.

## §S — Skipped last round (0.6.13) — A339, A334, A336, A335

### J1 — A manager signing in OFFLINE reaches the manager screen · **Record**
1. On the till turn Wi-Fi / network OFF.
2. Sign out to the PIN pad, enter the MANAGER PIN.
3. Then sign out and enter the CASHIER PIN.
4. Turn the network back ON.

**Expected:** Manager → **manager screen**. Cashier → **till (POS) screen**. A wrong PIN is refused.

### B3 — Another cashier is told whose shift it is · **Record**
1. Sign out; sign in as Cashier B on the till.

**Expected:** “T1 — … is already open — opened by Cashier A at HH:MM on the web POS” → Continue → selling, no float asked, no second drawer.

### B6 — Close on the till balances · **Record**
1. Close the shift on the till counting exactly the expected cash.

**Expected:** Variance **0**, no note required.

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

### X3 — Day close
1. Close all shifts, then Manager → Close Day.

**Expected:** Day closes; figures look right.

### X4 — Sync healthy at the end · **Record**
1. Technician mode → Sync card.

**Expected:** Pending 0, no failures, no red errors.
