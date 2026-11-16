# SwiftPOS v0.6.17 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.17.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `R1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

0.6.17 adds A351 (the manager menu in groups: Sales, Close, Settings) and is the first build that must reach ONLY the business you approve (A348 U1–U5), released as one pre-release (A350). It carries the printer-free money checks from 0.6.16 (A349 M3–M5) and the printer ones for when a printer is back. Desktop only — no migration, no cloud or admin deploy. Do §R first; do not install 0.6.17 by hand. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout (do these first, in order) — closes A350

Desktop only: no migration, no cloud or admin deploy this time. Bump 0.6.17, push, tag.

### R1 — The tag comes out as ONE pre-release · **Record**
1. After the tag: GitHub → Actions → Release desktop → the run for v0.6.17.
2. GitHub → Releases.

**Expected:** The run is green, including the step **“Verify the release (one copy, latest.yml + installer)”**. Releases shows **one** v0.6.17, marked **Pre-release**, with latest.yml and SwiftPOS-0.6.17-x64.exe. No second copy, no draft.

### R2 — Leave it a pre-release
1. Do **not** edit it, untick “pre-release” or set it as latest.

**Expected:** v0.6.16 stays the **Latest** release on GitHub. (From now on every build stays a pre-release; you release it per client in the admin portal.)

## §U — Updates approved per client (held by default) — closes A348

Admin portal → Clients → a client → the “Desktop updates” box (under Web access expiry). This is the real test of the hold: 0.6.17 must reach only the business you approve.

### U1 — Every client starts HELD · **Record**
1. Open two or three clients in the admin portal (do not approve anything yet).

**Expected:** Each says **Held — tills stay on the version they run.** The version list shows **0.6.17 (pre-release)** and 0.6.16.

### U2 — Nothing moves while held
1. Leave your till open (online) for an hour, or restart it.

**Expected:** Your till stays on **0.6.16** — no “update ready”. (Before 0.6.16 a new release reached every till by itself.)

### U3 — Approve your own business · **Record**
1. On YOUR business choose 0.6.17 → Approve → confirm.
2. Admin portal → Audit.

**Expected:** The box says **Approved: 0.6.17**. The audit log has **desktop_update.approve** for your business.

### U4 — Your till updates; the others do not · **Record**
1. Restart your till (or wait up to an hour online). When it says the update is ready, close the till and open it again.
2. Technician mode / About → version. If you have a till of ANOTHER client (still held), check its version too.

**Expected:** Your till reads **0.6.17**. The other client’s till stays on 0.6.16.

### U5 — Hold again — never a downgrade
1. Press **Hold** on your business → confirm. Restart your till.

**Expected:** The audit log has **desktop_update.hold**. Your till stays on 0.6.17 (holding never takes a till back). Approve again afterwards if you want it approved.

## §G — The manager menu in groups — closes A351

Sign in on 0.6.17 as the MANAGER (or owner), online.

### G1 — The shorter menu · **Record**
1. Look at the manager sidebar.

**Expected:** **Overview · Sales · Expenses · Close · Menu · Settings** (and **Stock** when the web POS is on), then Open POS and Lock till at the bottom. No separate Orders, Shift, Close Day, Close Branch, Staff or Printing items.

### G2 — Sales · **Record**
1. Tap **Sales**. Use each tab across the top.
2. Current shift, then Shift report → pick a previous shift → Print report (if you have a printer).

**Expected:** Tabs: **Orders · Item Mix · Current shift · Shift report** (Item Mix only for a restaurant). Each opens the same page as before; one tap each; the sidebar does not move.

### G3 — Close
1. Tap **Close**.

**Expected:** It opens on **Close Day**, with **Close Branch** as the second tab. Both work as before (Close Branch still explains when this till is not the branch node).

### G4 — Settings · **Record**
1. Tap **Settings**. Use each tab.
2. Inside Printing: Stations, Printers, Exclusions, Receipt.

**Expected:** Tabs: **General · Printing · Staff**. General is the old Settings (24-hour operation, payment methods). Printing and Staff are the pages you had before, unchanged.

### G5 — Each group remembers its tab
1. Settings → **Printing**. Tap Overview. Tap Settings again.
2. Same with Sales → Shift report.

**Expected:** Settings reopens on **Printing**; Sales on **Shift report**. (After locking the till, groups open on their first tab again.)

### G6 — Menu → Import stays in Menu
1. Menu → Import / export.

**Expected:** The sidebar keeps **Menu** highlighted and the title says Menu.

### G7 — A cashier cannot reach it
1. Lock the till; sign in with a CASHIER PIN.

**Expected:** The cashier goes to the till as before, with no Manager button — the manager menu is not reachable.

## §M — Money on receipts and reports (carried from 0.6.16) — A349

M3–M5 need no printer. M1, M2, M7, M8 need one — SKIP them until you have a printer. On a till of a CTL business (VAT 16 %, CTL 2 %) unless a check says otherwise.

### M3 — Overview shows VAT and CTL · **Record**
1. Manager → Overview (today).

**Expected:** Under the four boxes: **VAT … CTL …** (and Tips / Discounts when there were any).

### M4 — A refund is taken off everywhere · **Record**
1. Refund one sale (online, owner/manager).
2. Look at Overview, then Sales → Orders → export the Daily Sales Report.

**Expected:** Overview revenue drops by the refund and shows **Refunds −…**; VAT and CTL drop by the refund's share. The Daily report's **Total Gross** equals the Overview revenue; its Total Sale is not negative.

### M5 — Z-report shows the shift's money in full (screen) · **Record**
1. Sales → Shift report → this shift, on screen.

**Expected:** Gross sales, − Refunds, = Net sales, incl. VAT, incl. **CTL**, Tips (when any). Expected cash as before.

### M1 — A DISCOUNTED sale prints its receipt (printer) · **Record**
1. Ring 2–3 items, apply a 10 % discount, take cash.
2. Compare the printed receipt with the screen.

**Expected:** The receipt **prints**. It shows Discount, SubTotal, CTL, VAT, Round Off, Total — and they add up to the Total.

### M2 — A TIP is on the receipt (printer) · **Record**
1. Ring a sale, add a tip (e.g. 50), pay.

**Expected:** Paper: **Tip 50.00** after Total, and **PAY = Total + tip**. Screen receipt: Round Off 0.00 (not −50).

### M7 — Web POS receipt, CTL business (printer) · **Record**
1. On the web POS, ring a discounted sale with a tip and print to the thermal printer.

**Expected:** It prints straight to the printer (no browser dialog), with the **CTL** line, and the same VAT/CTL as the till would show.

### M8 — A business WITHOUT CTL (printer)
1. On a VAT-only business (or a test one), print a receipt.

**Expected:** No “CTL (0%)” line.

## §X — Regression (release-blocker if any fail)

### X1 — Normal sale and receipt
1. Ring a sale, take payment (print the receipt if you have a printer).

**Expected:** The sale completes; the receipt prints as before (or the on-screen receipt shows, without a printer).

### X2 — Kitchen ticket
1. Ring an item that goes to the kitchen (if you use one and have a printer).

**Expected:** Kitchen ticket prints as before.

### X3 — Online sign-in unchanged
1. Network ON: sign in as a cashier, then as the manager.

**Expected:** Cashier → till; manager → manager screen; Menu and Staff editable straight away.

### X4 — Sync healthy at the end · **Record**
1. Technician mode → Sync card.

**Expected:** Pending 0, no failures, no red errors.

### X5 — Second till (if you have one)
1. Sign in on T2 and ring a sale.

**Expected:** Works; its sale reaches the dashboard.
