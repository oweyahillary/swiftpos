# SwiftPOS manager verify — A133 + A205 + A206 (paste into a Claude browsing agent)

All of these need a **manager (PIN)** session, not the owner dashboard. Sign in at the POS login
(`/pos`) with a **manager** PIN for **B Fastfoods** (a role that resolves to /manager). Confirm the
dev deploy is current before starting. Report the table at the end.

## Setup notes
- The manager lands on `/manager` after PIN login. If it lands on the cashier screen instead, the
  account isn't a manager — get a manager PIN.
- Some checks need data: an **in-transit transfer TO the manager's branch** (create one from the owner
  dashboard: Stock Transfers → New → to the manager's branch → Mark in transit), and an **open
  purchase order** for that branch (owner dashboard: Purchase Orders → create → mark Ordered).

## Report
| ID | Result | Evidence |
|----|--------|----------|
| A133 grouped sidebar | PASS/FAIL | section headers seen |
| A205 receive transfer | PASS/FAIL | stock moved? |
| A205 receive delivery (GRN) | PASS/FAIL | stock up + PO status |
| A205 no-edit | PASS/FAIL | any adjust control? |
| A206 Open POS | PASS/FAIL | did the cashier screen open |

---

## A133 — manager sidebar is grouped
- **PASS if:** the manager sidebar shows labelled sections with uppercase headers, roughly:
  **Overview** (top), **INVENTORY** (Inventory · Receiving), **FINANCE** (Orders · Reports · Turnover ·
  Expenses), **CUSTOMERS** (Customers · Credit), **SETTINGS** (Staff · Printers). Each item still
  opens its tab. A group with no permitted items shows no header.
- **FAIL if:** flat list with no headers, or an item doesn't switch.

## A205 — Receiving: incoming transfers
1. Manager sidebar → **Receiving** → **Incoming transfers**.
2. An in-transit transfer to this branch should be listed. Note the item + branch stock before.
3. Click **Mark received**.
- **PASS if:** the transfer disappears from the list and the item's stock at this branch rises by the
  transferred quantity (check Inventory). **FAIL if** it errors or stock doesn't move.

## A205 — Receiving: supplier deliveries (GRN)
1. **Receiving** → **Supplier deliveries** — an open PO for this branch should be listed.
2. Click **Receive delivery** → a modal lists items with a quantity field (defaulted to remaining).
3. Enter/confirm quantities → **Confirm received**.
- **PASS if:** the ingredient stock rises by the received quantity, and the PO becomes *partial* (if
  partly received) or drops off the open list (if fully received). **FAIL if** it errors or stock
  doesn't move.

## A205 — no edit
- Across the manager's Inventory and Receiving areas, confirm there is **no** control to *adjust /
  set / correct* stock levels or edit the ingredient catalogue (managers receive, not edit).
- **PASS if:** no such control exists. **FAIL if** a manager can adjust/set a stock quantity.

## A206 — "Open POS" opens the cashier screen
1. In the manager sidebar (bottom), click **Open POS**.
- **PASS if:** the POS cashier screen opens (a shift/open-register prompt or the terminal itself) and
  **stays** — it does not bounce back to /manager.
- **FAIL if:** nothing happens / it flashes and returns to the manager dashboard.
- Then confirm you can get back: **Lock** or **End shift** should return toward /manager or the POS
  login.

---
For any FAIL: page URL, the failing request name + status, and what you saw vs expected.
