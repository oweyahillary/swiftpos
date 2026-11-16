# SwiftPOS v0.6.18 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.18.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.18 adds A355 (void/refund from History at any time, approved with the manager’s own PIN; cashiers see no buttons), A336 stage 2 (web POS sales reversed from the till), A276 (drinks never on the kitchen ticket, till and web), A279 (the POS names its filter), A341 (a manager adds expense types), A357 (VAT once on the Overview) and A356 (admin portal release list). Cloud, then dashboard and admin portal, then the till through the approval. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (do these first, in order)

Cloud first (the new approval and the release list), then the dashboard and the admin portal, then 0.6.18 on the tills through the approval.

### R1 — Cloud deployed from dev
1. Render → the API service → deploy the latest dev commit; wait for “Live”.

**Expected:** Deploy finished; the web POS and dashboard still sign in.

### R2 — Dashboard and admin portal deployed from dev
1. Deploy both from the same commit; hard-refresh them.

**Expected:** Both load. (The dashboard carries the web POS’s kitchen-ticket fix; the portal the shorter version list.)

### R3 — The tag comes out as ONE pre-release · **Record**
1. After tagging v0.6.18: Actions → Release desktop → the run is green, including “Verify the release”.
2. Releases: one v0.6.18, marked Pre-release. Do **not** untick it.

**Expected:** One v0.6.18 pre-release with latest.yml and the installer; v0.6.16 (or whichever you set) stays Latest.

### R4 — Approve B Foods for 0.6.18 · **Record**
1. Admin portal → B Foods → Desktop updates → 0.6.18 → Approve.
2. Restart the till; when the update is ready, close and reopen it.

**Expected:** The till reads **0.6.18**. The audit log has desktop_update.approve.

## §V — Void and refund from the till — A355, A336

Sign in as the MANAGER unless a check says cashier. “Your PIN” = the PIN you sign in with. POS screen → **History** (top bar).

### V1 — A cashier sees no void/refund
1. Lock the till; sign in with a CASHIER PIN; open History.

**Expected:** The list shows (with Reprint) but **no** “Void / Refund” or “Refund” buttons.

### V2 — Void a new sale with your own PIN · **Record**
1. As the manager, ring a cash sale.
2. History → that sale → **Void / Refund** → keep “Void” → a reason → **your own sign-in PIN**.

**Expected:** It goes through (no “Invalid supervisor PIN”). The sale shows “voided”; the dashboard shows it voided.

### V3 — Refund a sale older than 30 minutes · **Record**
1. Pick a sale more than 30 minutes old in History — its button now reads **Refund** (it used to disappear).
2. Refund → a reason → your own PIN.

**Expected:** Refunded; the row shows a “refunded” tag and no button. Overview shows **Refunds −…**, revenue and VAT/CTL down by it; the Daily Sales Report’s Total Gross matches the Overview (the old M4).

### V4 — A wrong PIN says so plainly
1. Try another refund with a wrong PIN, then with the CASHIER’s PIN.

**Expected:** Both: “That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.” — never “Invalid supervisor PIN”.

### V5 — Refund a WEB POS sale from the till · **Record**
1. On the web POS, ring a cash sale on this till’s drawer (as for §F last time).
2. On the till: History → the sale (tagged “web”) → Refund → your PIN.
3. Shift panel → expected cash.

**Expected:** Refunded; the dashboard shows it refunded; expected cash drops by the sale ONCE (not twice).

### V6 — An override PIN set before still works (skip if none)
1. If a staff member has an override PIN, use it for one refund.

**Expected:** Accepted, as before.

## §K — Drinks never on the kitchen ticket (needs the printer) — A276

Ring on the till first, then the same on the web POS. Keep the tickets.

### K1 — Till: combo + soda · **Record**
1. Ring a spicy combo and a standalone Soda; Send to Kitchen (or pay, for a counter sale).

**Expected:** Kitchen ticket: the combo’s cooked items, **no Soda**. Dispatch ticket: everything, Soda included.

### K2 — Web POS: the same order · **Record**
1. Same order on the web POS, printed to the thermal printers.

**Expected:** Same result: no Soda on the kitchen ticket, Soda on dispatch.

### K3 — A cooked dish named after a sauce stays (skip if none)
1. Ring an item like “Wings in BBQ Sauce” if the menu has one.

**Expected:** It IS on the kitchen ticket.

## §F — The POS says which filter it shows — A279

### F1 — A category filter is named, with Clear · **Record**
1. On the POS, tap a category (e.g. Soft Drinks), then type in search.

**Expected:** Under the tabs: “Showing Soft Drinks · "…" — N items” and **Clear ✕**. Clear brings back All with the search emptied.

### F2 — An empty grid explains itself
1. Search for something that doesn’t exist.

**Expected:** “Nothing matches this filter.” with **Show all products**, which restores the grid.

## §E — A manager adds an expense type — A341

Online. POS → Shift → Expenses.

### E1 — Add a type and use it · **Record**
1. As the manager: **+ Add type** → e.g. “Gas refill” → Save.
2. Record an expense with it.

**Expected:** The new type is selected straight away; the expense saves; the dashboard’s Expenses shows the type.

### E2 — No duplicates
1. + Add type → type an existing name in other capitals (e.g. “gas REFILL”).

**Expected:** The existing type is selected; no second copy is created.

### E3 — A cashier cannot add types
1. Sign in as a cashier → Shift → Expenses.

**Expected:** No “+ Add type” button (the list still works).

## §M — Money on the Overview — A357, A349

### M1 — VAT shown once · **Record**
1. Manager → Overview (after a sale today).

**Expected:** VAT is in the “VAT collected” box only; the strip below shows CTL (if the business levies it), Refunds, Discounts, Tips — and no strip when none apply.

### M2 — Z-report on screen (carried M5)
1. Sales → Shift report → this shift.

**Expected:** Gross, − Refunds, = Net, incl. VAT, incl. CTL, Tips. (It passed on 0.6.17 — confirm still right after V3.)

## §A — Admin portal: releases — A356

Admin portal → a client → Desktop updates.

### A1 — The short list · **Record**
1. Open the version list.

**Expected:** The newest 5 (0.6.18 marked pre-release), plus the client’s approved version if older; “Show all N versions” reveals the rest.

### A2 — A GitHub hiccup does not blank it (skip unless it happens)
1. Only if GitHub refuses: note the message.

**Expected:** It names the cause (e.g. rate limit → GITHUB_RELEASES_TOKEN) and still shows the last list it read.

## §X — Regression (release-blocker if any fail)

### X1 — Normal sale
1. Ring a sale, take payment (print if you have the printer).

**Expected:** Completes; receipt as before.

### X2 — Kitchen ticket
1. Ring a cooked item; send to kitchen.

**Expected:** Prints as before, nothing missing.

### X3 — Sign-in unchanged
1. Cashier → till; manager → manager screen.

**Expected:** As before.

### X4 — Sync healthy · **Record**
1. Technician → Sync.

**Expected:** Pending 0, no errors.

### X5 — Second till (if you have one)
1. Sign in on T2 and ring a sale.

**Expected:** Works; its sale reaches the dashboard.
