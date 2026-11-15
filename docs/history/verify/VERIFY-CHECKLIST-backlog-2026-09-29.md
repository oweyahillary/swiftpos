# SwiftPOS — backlog verification (built, never checked on target)

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-backlog-2026-09-29.html` (Pass / Fail / Skip, a note required on a Fail, progress kept in the browser, results in the `S1: PASS — note … Summary … Failed:` format). This markdown is the same list, generated from it.

Register items marked FIX BUILT that were never checked on a real till. Nothing to deploy: it checks what is live on desktop 0.6.19. §N needs a second till. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §S — Sales and money reach the cloud (one till) — A129, A179, A267, A168

Till online unless stated. “Sync” = Technician mode → Sync card.

### S1 — A delivery sale reaches the dashboard · **Record**
1. On the till, ring a **Delivery** order (pick a rider if asked) and take payment.
2. Sync → Pending 0.
3. Dashboard → Orders.

**Expected:** The sale is there, type **delivery**, right total. (Delivery sales used to be refused by the cloud and never arrive.)

### S2 — A till expense reaches the dashboard
1. On the till: Shift → Expenses → record one (with a type).
2. Sync → Pending 0.
3. Dashboard → Expenses.

**Expected:** The expense is listed with its type and amount.

### S3 — A long day does not sign the till out
1. Leave the till signed in and idle for **more than an hour** (or check at the end of a full day).
2. Ring a sale; Sync.

**Expected:** The sale goes through and syncs (Pending 0) — no “signed out” / “Unauthorized” message.

### S4 — The web POS survives an hour too
1. Leave the web POS signed in and idle for more than an hour.
2. Ring a sale.

**Expected:** It goes through; no “business null” or sign-out loop.

### S5 — An offline sale syncs later with the right cashier
1. Network OFF; ring a sale as a cashier.
2. Network ON; wait a minute; Sync.

**Expected:** Pending 0; the dashboard shows the sale under that cashier.

## §B — Receipts and branch text (printer) — A277, A209, A139

### B1 — The till receipt shows the CTL line · **Record**
1. Print a receipt on the till (B Foods levies CTL).

**Expected:** A **CTL (2%)** line with the amount, beside VAT. (P1 on 0.6.19 printed it — confirm and keep the receipt.)

### B2 — Web and till receipts look the same · **Record**
1. Ring the same items on the till and on the web POS; print both.

**Expected:** Same layout: header, lines, SubTotal / CTL / VAT / Total, footer.

### B3 — Branch receipt text overrides the business default · **Record**
1. Dashboard → the branch’s settings → set a branch receipt header/footer (e.g. “Mama Ngina branch”).
2. On the till: Technician → Sync (or wait), then print a receipt. Same on the web POS.

**Expected:** Both receipts carry the **branch** text, not the business default. (Remove it afterwards if it was only a test.)

## §M — Manager screens and dashboard reports — A296, A258, A259, A262, A58, A257, A157, A141, A211, A256

### M1 — Item Mix follows the date range (till)
1. Manager → Sales → Item Mix → Yesterday, then 7 days.

**Expected:** The list changes with the range (it used to be stuck on today).

### M2 — Owner reports name the cashier · **Record**
1. Dashboard as the OWNER → Reports → Staff performance (today / this week).

**Expected:** Real cashier names with their sales — not “Unknown” or blank.

### M3 — Shift report under Shifts (dashboard)
1. Dashboard → Shifts → open a closed shift → its report.

**Expected:** The shift report shows (sales, by method, expected cash) and matches the till’s Z-report for that shift.

### M4 — The manager’s web menu is complete
1. Dashboard signed in as the MANAGER.

**Expected:** Orders (all orders), Inventory and Expenses are there and open (not “no permission”).

### M5 — Customers and Receiving open for a manager
1. As the manager on the dashboard: open Customers, then Inventory → Receiving.

**Expected:** Both open (no “no permission”).

### M6 — A form says which field is wrong
1. Dashboard → Menu → add a product with an EMPTY name → Save.

**Expected:** “Name is required” (not a silent nothing / “Validation failed”).

### M7 — Bulk ingredient import (skip if you don’t track ingredients)
1. Dashboard → Inventory → Ingredients → bulk import a small CSV (name, unit, opening stock).

**Expected:** The ingredients appear with their opening stock.

## §T — Technician and updates — A298, A299, A306

### T1 — The till shows which build it runs · **Record**
1. Technician mode → the status card.

**Expected:** A **Build** line: a short code + a build time (and v0.6.19).

### T2 — Errors land in the log file
1. Settings → Printing → Printers → Test print to a printer that is OFF (or a wrong address).
2. On the PC open `%APPDATA%\SwiftPOS\swiftpos.log` (Win+R → paste → Enter; open with Notepad).

**Expected:** Near the bottom: a line with the time and the print error.

### T3 — The update banner (do at the next update)
1. When 0.6.20 is approved for B Foods: watch the till.

**Expected:** A banner says an update is downloading/ready; “Restart & update now” asks for a **manager PIN**. SKIP until the next update.

## §C — Colours and themes — A331, A330, A329

### C1 — Themed tills stay readable · **Record**
1. Admin portal → B Foods → **Turn themes on**; on the till pick two or three themes in turn (Settings).
2. Look at the Charge button, category tabs, primary buttons.

**Expected:** White text readable on every coloured button in each theme. (Turn themes off again afterwards if you prefer.)

### C2 — Web POS light mode — the tip panel
1. Web POS → switch to ☀ light → take a payment → Add tip.

**Expected:** The tip panel is a light, subtle panel — not a flat grey block.

### C3 — The dashboard in SwiftPOS teal
1. Dashboard in dark, then light mode.

**Expected:** Primary buttons, links, toggles and focus rings are teal (not green), text readable on them.

## §W — The web till — A273

A till shift open on T1.

### W1 — The web knows the till by name · **Record**
1. Web POS sign-in picker (as a cashier who is NOT on the till’s shift).

**Expected:** It lists “T1 — <your setup name>” and “<Branch> Web Till” — not “SwiftPOS till”.

### W2 — Same cashier goes straight in — no float prompt
1. Sign in on the web as the SAME cashier who opened the till’s shift.

**Expected:** Straight to selling: no picker, **no opening-float prompt**.

## §N — Only with a second till (SKIP the whole section without one) — A19, A20, A24, A160–A163, A22, D9

T1 = the branch node (the till the others talk to); T2 = a peer on the same network.

### N1 — A peer’s sales reach the cloud through the node
1. Unplug T2 from the internet only (keep it on the shop network with T1). Ring a sale on T2.
2. Sync on T1.

**Expected:** The T2 sale reaches the dashboard via T1.

### N2 — A menu change reaches an offline peer
1. With T2 still off the internet, change a price on the dashboard; T1 syncs.
2. Check the price on T2.

**Expected:** T2 shows the new price (from T1).

### N3 — Staff sign in on a peer while the cloud is away
1. Internet off for both tills; sign in on T2 with a cashier PIN.

**Expected:** The cashier signs in (the staff list came from T1).

### N4 — A long offline peer session keeps working
1. Keep T2 off the internet for over an hour; ring a sale.

**Expected:** It works; after reconnecting, its sales sync.

### N5 — Held orders seen on both tills
1. Hold an order on T1; open held orders on T2.

**Expected:** T2 lists it; recalling it on one till locks it on the other.

### N6 — Promoting a till checks for a split
1. Technician → promote T2 to node while T1 is still node.

**Expected:** It warns / refuses instead of creating two nodes.
