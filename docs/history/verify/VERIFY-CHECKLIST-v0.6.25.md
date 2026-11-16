# SwiftPOS v0.6.25 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.25.html`. 0.6.25: the client logo — bigger, in the sidebar, on the receipt, and it stays (A368). It contains 0.6.24 — run v0.6.24's §C and §N too if they
were not run on 0.6.24. **Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout
Cloud + dashboard first (write guard, web receipt logo), then 0.6.25 on the till.

### R0 — Cloud and dashboard deployed from dev
1. Deploy the cloud, then the dashboard; hard-refresh.

**Expected:** The web POS signs in.


### R1 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.25 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.25 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R2 — Approve B Foods for 0.6.25
1. Admin portal → B Foods → 0.6.25 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.25.

## §G — A bigger logo

### G1 — The PIN screen · **Record**
1. Lock till / sign out to reach the PIN screen.

**Expected:** The B FOODS logo fills most of its white card — clearly larger than on 0.6.24, with a thin white border.

### G2 — The lock screen
1. Let the till lock (idle) while signed in.

**Expected:** The same logo, the same size as on the PIN screen, above "Till locked".

### G3 — The manager sidebar
1. Sign in as a manager → the manager screen; collapse and expand the sidebar (☰).

**Expected:** The logo on a small white tile beside "B Foods"; still visible (smaller) when collapsed. Without a logo, the icon.

## §B — The logo stays — A368

### B1 — Upload on the till; it survives syncs · **Record**
1. Tech screen → Branding → pick a logo → Save.
2. Press Sync on the till (or wait 10 minutes), then look at the PIN screen and the web dashboard's Branding page.

**Expected:** "Saved on this till and to the cloud". After the sync the till still shows the new logo, and the web Branding page
shows the same logo.

### B2 — Offline upload
1. Unplug the network → upload a different logo → Save. Reconnect → Sync.

**Expected:** "Saved on this till. Offline — it will be saved to the cloud at the next sync." The logo stays on the till through
the reconnect sync, and then shows on the web Branding page.

## §P — The printed logo

### P1 — A bigger logo on the receipt · **Record**
1. Re-save the logo once (web Settings → Branding, or the till's tech screen) with the receipt logo ON. Ring a sale and print.

**Expected:** The logo prints clearly bigger than before — a square logo about 36 mm tall, centred; a wide logo the full paper
width.

## §D — Documents carry the logo, and look corporate

### D1 — An A4 document · **Record**
1. Dashboard → Stock → Purchase Orders → print a PO (or a GRN / transfer note / Shift Reports → Print).

**Expected:** The B FOODS logo top-left beside the business name and contacts; the title in colour top-right; details in a
shaded panel; a shaded table header; a boxed total; signature lines; a footer with the business, document and printed time.

### D2 — The Z-reports
1. On T1 print a shift's Z-report (receipt logo ON). On the web POS, Z-Report → Print.

**Expected:** The logo at the top of both.
