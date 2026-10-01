# SwiftPOS v0.6.28 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.28.html`. 0.6.28: a sent order is paid or a recorded kitchen void — reason,
made or not, a manager with the client's switch, a VOID ticket, the Z-report; End Shift refused while one is unpaid; “Pay before
kitchen” (A372); the kitchen no longer cooks a sent dish twice (A373). It contains 0.6.27 — run v0.6.27's checklist too if not yet
run. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout
One patch holds 0.6.26, 0.6.27 and 0.6.28 (one release). Migrations 111 and 112 BEFORE the cloud. Run the v0.6.26 and v0.6.27 checklists on this install too (skip their tag/approve steps).

### R0 — Migrations 111 and 112, then cloud, dashboard, admin portal
1. Run migration 111 (if not yet), then 112, on the database.
2. Deploy the cloud, the dashboard and the admin portal; hard-refresh.

**Expected:** The web POS signs in; the dashboard and admin portal load.

### R1 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.28 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.28 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R2 — Approve B Foods for 0.6.28
1. Admin portal → B Foods → 0.6.28 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.28.

## §S — The two new switches — A372
Admin portal → B Foods → Features.

### S1 — Kitchen voids need a manager · Pay before kitchen · **Record**
1. Open Features.

**Expected:** Two new POS switches with a line each saying what they do, both OFF (the five from 0.6.27 are unchanged).

## §K — Send to kitchen (every client) — A373
Restaurant mode, kitchen printing on. Switches still OFF.

### K1 — Only the extra goes to the kitchen · **Record**
1. Takeaway: Chicken ×2 → Send to kitchen.
2. Tap Chicken once more (3) → Send to kitchen.

**Expected:** The second ticket says 1 × Chicken (not 3). The line shows 🍳 while all are sent, “🍳 2 sent” while one is not.

### K2 — A line added after Send reaches the kitchen at payment
1. Send an order, then add a Soda, then Pay (cash).

**Expected:** The kitchen/dispatch print the Soda at payment; the receipt prints once.

### K3 — No note on a sent line
1. Look at a sent line.

**Expected:** No “+ Note” button on it (a new line can carry the instruction).

## §V — Kitchen voids on the till (every client) — A372
Switches still OFF.

### V1 — Removing a sent item is a kitchen void · **Record**
1. Send Chicken ×2.
2. Press − on it.

**Expected:** “Take back 1 × Chicken”: reasons, “Had the kitchen already made it?”, a note; Void → the kitchen prints a VOID ticket with 1 × CHICKEN; the line is 1.

### V2 — Clear with sent items
1. Send an order, press Clear.

**Expected:** “Clear the order” asks for a kitchen void of every sent item (Cancel keeps the order; Hold keeps it as a tab).

### V3 — Unsent items go freely
1. Add an item, do NOT send, press ✕.

**Expected:** Removed with no question (as before).

### V4 — A held tab with sent items cannot be deleted
1. Send an order, Hold it, then delete the tab from the tabs list.

**Expected:** “This tab has items already sent to the kitchen. Recall it, then remove the items (a kitchen void).”

### V5 — A sent order survives a restart · **Record**
1. Send an order (do not hold it), close SwiftPOS, reopen.

**Expected:** With an empty cart: “Sent to the kitchen, not paid — #… · Open”. Open brings it back; it can be charged.

## §M — With “Kitchen voids need a manager” ON — A372
Turn it on for B Foods; Sync T1; refresh the web POS.

### M1 — A cashier needs a manager's PIN · **Record**
1. As a cashier: send an order, press ✕ on a sent line.
2. Try a cashier's PIN, then a manager's.

**Expected:** Manager PIN asked; a cashier's PIN is refused; the manager's voids it. The VOID ticket prints.

### M2 — A manager signed in voids as themselves
1. Sign in as a manager, void a sent item.

**Expected:** No PIN asked; recorded as approved by them.

### M3 — End Shift with an unpaid sent order · **Record**
1. Leave a sent order unpaid (on hold or on screen); Shift → Close.

**Expected:** The panel lists “Sent to the kitchen, not paid”; closing is refused, naming the order. After charging (or voiding) it, the shift closes.

### M4 — Offline
1. Disconnect T1; void a sent item with a manager's PIN (one who has signed in on T1 before).

**Expected:** Accepted offline; the void reaches the cloud when T1 reconnects (dashboard Z-report shows it).

## §P — With “Pay before kitchen” ON — A372
Turn it on; Sync T1; refresh the web POS.

### P1 — Takeaway: no Send; the ticket prints at payment · **Record**
1. Takeaway order → look for Send to kitchen → Pay.

**Expected:** No Send to kitchen button (Hold still there); the kitchen ticket prints when paid.

### P2 — Dine-in still sends first
1. A table → add items.

**Expected:** Send to kitchen is there for the table.

## §W — The web POS — A372
Restaurant, order-first.

### W1 — A sent web line is voided, not deleted · **Record**
1. Web POS → a table → items → Send to Kitchen.
2. Press − or ✕ on a sent line (with M on: a manager's PIN).

**Expected:** The kitchen-void dialog; after Void the line drops, the total drops by its value, the kitchen prints a VOID ticket; Charge still matches.

### W2 — A sent tab cannot be dropped
1. Clear the table of a sent order.

**Expected:** The kitchen-void dialog for every sent item (or charge it).

### W3 — Web End Shift with an unpaid sent order (M on)
1. Leave a sent web order unpaid → close the shift.

**Expected:** Refused: “… sent to the kitchen and not paid (#ORD-…)”.

## §Z — The reports — A372

### Z1 — Till Z-report lists the kitchen voids · **Record**
1. Shift → print / view the Z-report after V1/M1.

**Expected:** KITCHEN VOIDS (n): each line “1x Chicken - Customer changed their mind; made; approved Mary, cashier Amy”, Total voided, Of which already made.

### Z2 — Web Z-Report · **Record**
1. Web POS → Z-Report for today.

**Expected:** A “Kitchen voids” section with the same lines (till and web voids).
