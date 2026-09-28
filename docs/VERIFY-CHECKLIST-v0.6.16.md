# SwiftPOS v0.6.16 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.16.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.16 adds A348 (desktop updates approved per client in the admin portal, held by default; tills ask the cloud, never GitHub) A349 (money: discounted receipts print, tips on receipts, CTL in the Overview and Z-report, reports refund-true, web receipts with CTL) and A347 (teal icon), and carries every 0.6.15 check (Stock only with the web POS, a manager signed in offline) plus the 3 skipped on 0.6.14. Migration 108, then the cloud and admin portal, then 0.6.16 on the tills. Do §R first. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (do these first, in order) — prerequisite for everything below

Migration 108 first, then the cloud and the admin portal, then 0.6.16 on the tills.

### R1 — Migration 108 applied to prod · **Record**
1. Supabase → SQL editor → run: `SELECT column_name FROM information_schema.columns WHERE table_name='businesses' AND column_name='desktop_approved_version';`

**Expected:** One row: **desktop_approved_version**. Paste the output.

### R2 — Cloud deployed from dev
1. Render → the API service → deploy the latest dev commit.
2. Wait for “Live”.

**Expected:** Deploy finished; the web POS and dashboard still sign in.

### R3 — Admin portal deployed from dev
1. Deploy the admin portal from the same commit; hard-refresh it.

**Expected:** It loads and you can open a client.

### R4 — 0.6.16 published ONCE as a normal release · **Record**
1. GitHub → Releases → v0.6.16. If there are two copies, keep the one with all three files (.exe, .exe.blockmap, latest.yml) and delete the other.
2. Edit it: **untick “Set as a pre-release”**, tick “Set as the latest release”, Publish.

**Expected:** v0.6.16 is the Latest release, with all three files. (This is the last version that goes to every till at once — from now on you approve per client.)

### R5 — Every till is on 0.6.16 · **Record**
1. Let tills auto-update (installs when each is closed) or install by hand.
2. Technician mode / About → version.

**Expected:** Each till reads **0.6.16**.

## §U — Updates approved per client (held by default) — closes A348

Admin portal → Clients → a client → the “Desktop updates” box (under Web access expiry).

### U1 — Every client starts HELD · **Record**
1. Open two or three clients in the admin portal.

**Expected:** Each says **Held — tills stay on the version they run.** The version list shows 0.6.16 (and later builds as “(pre-release)”).

### U2 — Approve your own business · **Record**
1. On YOUR business choose 0.6.16 → Approve → confirm.
2. Admin portal → Audit.

**Expected:** The box says **Approved: 0.6.16**. The audit log has **desktop_update.approve** for your business. (Your 0.6.16 tills do nothing — they are already on it.)

### U3 — Hold again
1. Press **Hold** on your business → confirm.

**Expected:** Back to “Held”; the audit log has **desktop_update.hold**. Leave it held or approved — your choice.

### U4 — A new build reaches nobody until approved (do when the next version exists)
1. When the next build (e.g. 0.6.17) is tagged: it appears on GitHub as a **pre-release** — do NOT untick it.
2. Leave every client held; approve only your own business.
3. Wait up to an hour with your till open (or restart it).

**Expected:** Your till shows “update ready” and installs on close. Another client’s till stays on 0.6.16. Mark SKIP until a newer build exists.

### U5 — The new teal icon · **Record**
1. On a till on 0.6.16: desktop shortcut, taskbar, the window’s title-bar icon. (Restart the PC if Windows still shows the old one.)

**Expected:** The S and border are **teal**, not green.

## §M — Money on receipts and reports (pre-release review) — closes A349

On a till of a CTL business (e.g. VAT 16 %, CTL 2 %) unless a check says otherwise. Keep the receipts.

### M1 — A DISCOUNTED sale prints its receipt · **Record**
1. Ring 2–3 items, apply a 10 % discount, take cash.
2. Compare the printed receipt with the screen.

**Expected:** The receipt **prints** (it used not to). It shows Discount, SubTotal, CTL, VAT, Round Off, Total — and they add up to the Total.

### M2 — A TIP is on the receipt · **Record**
1. Ring a sale, add a tip (e.g. 50), pay.

**Expected:** Paper: **Tip 50.00** after Total, and **PAY = Total + tip**. Screen receipt: Round Off 0.00 (not −50).

### M3 — Overview shows VAT and CTL · **Record**
1. Manager → Overview (today).

**Expected:** Under the four boxes: **VAT … CTL …** (and Tips / Discounts when there were any).

### M4 — A refund is taken off everywhere · **Record**
1. Refund one sale (online, owner/manager).
2. Look at Overview, then Orders → export the Daily Sales Report.

**Expected:** Overview revenue drops by the refund and shows **Refunds −…**; VAT and CTL drop by the refund's share. The Daily report's **Total Gross** equals the Overview revenue; its Total Sale is not negative.

### M5 — Z-report shows the shift's money in full · **Record**
1. Shift → the Z-report, on screen and printed.

**Expected:** Gross sales, − Refunds, = Net sales, incl. VAT, incl. **CTL**, Tips (when any). Expected cash as before.

### M6 — Overview hours are local time
1. Look at the hourly chart.

**Expected:** A sale at 10:15 is in the **10:00** bar (it used to show 07:00).

### M7 — Web POS receipt (CTL business) · **Record**
1. On the web POS, ring a discounted sale with a tip and print to the thermal printer.

**Expected:** It prints straight to the printer (no browser dialog), with the **CTL** line, and the same VAT/CTL as the till would show.

### M8 — A business WITHOUT CTL
1. On a VAT-only business (or a test one), print a receipt.

**Expected:** No “CTL (0%)” line.

## §N — Stock only with the web POS — closes A346

Stock is a web POS (pro) feature. The till learns whether the business has the web POS on its catalogue sync — after installing, sign in online once (or Technician → Force sync) before N1.

### N1 — A business WITH the web POS sees Stock · **Record**
1. On a till of a business that has web access (e.g. B Foods), sign in as the manager, online.
2. Look at the manager menu.

**Expected:** **Stock** is in the menu (if any item tracks stock) and opens the stock levels.

### N2 — A business WITHOUT the web POS does not · **Record**
1. Admin portal → that business (or a test business) → switch web access OFF (or use a business that never had it).
2. On its till: Technician → Force sync (or wait for the next sync), then lock and sign in again as the manager.
3. Switch web access back ON afterwards if it was a real business, and sync again.

**Expected:** With web access off: **no Stock** in the manager menu. Back on + sync: Stock returns.

### N3 — Selling is unchanged
1. With web access off, ring a sale of an item that tracks stock.

**Expected:** The sale goes through as before — only the Stock screen is hidden.

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

## §S — Carried from 0.6.14 (skipped) — K4, F5, X5 — A342, A335

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
