# SwiftPOS v0.6.31 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.31.html`. 0.6.31 (A375): a product shown on the POS grid and the
QR menu only on chosen days — still found by search and sold at its normal price any day. **Record** = send a screenshot. A **Fail** needs a note.

## §R — Rollout
Migration 113 first (merge to main, approve DB migrate), then the cloud and websites, then the till.

### R0 — Migration 113 and deploy · **Record**
1. Merge dev → main; approve DB migrate (production) — green.
2. Deploy the cloud, the dashboard and the admin portal; hard-refresh.

**Expected:** Migrate run green (113 applied, schema check passes). Sidebar: “SwiftPOS v0.6.31 · <commit>” and “cloud v0.6.31”.

### R1 — Tag v0.6.31, approve the client
1. Tag v0.6.31 → Release desktop green.
2. Admin portal → approve 0.6.31; T1 updates.

**Expected:** T1 reads 0.6.31.

## §D — Shown on chosen days — A375
Use a test product (or the pizza offer). Today's weekday matters — pick days that do NOT include today for D2.

### D1 — Set the days on the web · **Record**
1. Dashboard → Products → edit a product → “Show on the POS on”: tick two days that are not today (e.g. Tue, Thu).
2. Save; reopen it.

**Expected:** The two days stay ticked; the line under them reads e.g. “Tue, Thu. On other days it is off the product grid…”.

### D2 — Not on the grid today — but found by search and sold · **Record**
1. Web POS and T1 (after a sync): look in its category / All.
2. Type part of its name in search; add it; pay.

**Expected:** Not on the grid without a search. With a search it appears, rings at its normal price and the sale completes.

### D3 — On its day it is on the grid
1. Edit the product: tick TODAY as well. Save; sync T1.
2. Look in its category / All (no search).

**Expected:** It is on the grid on the web POS and T1.

### D4 — Every day again
1. Untick every day (or tick all seven). Save.

**Expected:** Line reads “Every day”; the product is on the grid as before.

### D5 — QR menu
1. Days set to exclude today; open the table QR menu.
2. Then include today; reload.

**Expected:** Not on the customer menu without today; on it with today.

### D6 — Menu upload
1. Upload the pizza workbook with a show_days column “Tue, Thu” on the two offer rows.
2. Open one offer product.

**Expected:** Tue and Thu ticked; uploading again with a blank show_days leaves them as they are.
