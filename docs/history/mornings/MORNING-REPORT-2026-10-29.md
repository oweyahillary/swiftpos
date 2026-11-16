# Morning report: 29 Oct 2026 (built on the night of the 28th)

Nothing has been committed, pushed, deployed or run against a database. Everything is uncommitted on `dev`. Eight items were built: A600–A607.

**Local CI:**
- The final run covered all 264 ci.yml steps, across everything including A606 and A607.
- After the fixes below, the only failures left are the known Windows noise:
  - the schema audit (no python3);
  - the libuv `async.c` crash after every case has passed (each file re-run alone passes);
  - the money-reports time-zone case.
- The Postgres migration run reports "1 of 97" for the same libuv reason (41-42, 29/0). The new 179 (5/5), 180 (9/9) and 181 (8/8) pass alone.

## 1. What was built

### A600: local backup on every PC (desktop)
- **When:** every 6 hours (03:00, 09:00, 15:00, 21:00) on every PC, including a standalone POS, and straight after every day close. A standalone POS also backs up after each shift close.
  - A PC that was off catches up after 2 minutes idle, or after 30 minutes regardless.
  - The copy runs in small steps, so it never blocks a sale.
- **How many:** the 10 newest copies are kept. Only files with ZapTill's exact backup name are ever deleted, including on a USB stick.
- **Disk-space guard:** if there isn't room for twice the database size, the copy is skipped and the panel shows a red warning. It copies as soon as space frees up.
- **Backup panel:** Manager › Settings › Backup, for the owner and managers (cashiers don't see it). It shows:
  - the last backup and the space the copies use;
  - "Back up now" and "Choose folder…" (a USB stick or second disk);
  - a red warning after 12 hours without a backup (once the PC has been on 45 minutes), or after 2 days regardless.
- **Restore:** owner or technician only, with RESTORE typed to confirm.
  - The file is checked first: it must be a ZapTill database and pass the integrity checks.
  - Another business's file is always refused.
  - Another POS's file is allowed only on an empty, replacement PC.
  - A safety copy of the current data is kept before the swap, which happens at the next start.
- **Also fixed:** the Tech page's "Use the default" folder button never worked.
- **Tests:** 88/88; 9 mutations caught.

### A601: desktop-only clients cut off from the cloud (cloud + desktop + admin)
**Switch:** `DESKTOP_ONLY_CUTOFF_AT` on Render, e.g. `2026-12-01` (midnight Nairobi).
- Unset: nothing changes.
- Before the date: the notice shows.
- From the date: the cut applies.
- Remove it to undo.

**At the cut, for a desktop-only business** (no plan, no expiry, no web hosting):
- **Refused:** sales, voids and refunds, shift closes, day close and drawer pushes (503 `CLOUD_BACKUP_OFF`). Older POS versions keep their sales queued.
- **Still works:** joining a POS, sign-in, catalogue, staff and price changes, support logs, and all reading.
- **Updates held:** no desktop updates unless ZapTill releases one. The Tech page says "Updates for this business are released by ZapTill support".
- **The POS:** goes quiet, with no retry loop, no red "waiting to sync", and no drawer polling of the cloud. Its sales stay queued on the PC.
- **The manager's notice:** "From 1 December 2026, this POS no longer backs up to the ZapTill cloud…", in both phases.
- **Admin portal:**
  - a Clients filter, "Desktop only", showing each one's status;
  - on a desktop-only client's Features tab, "Keep cloud backup" (exempt) and "Release desktop updates", both super-admin only.
- **Not affected:** paying, trial and A581-locked clients.

**Tests:** 26 cloud + 30 desktop; 12 mutations caught.

### A602: going online later (cloud + desktop)
- **New sales first:** when backup turns on after a cut, or more than 500 sales are waiting, the last 48 hours go first, so the dashboard is live from day one. Each sale's drawer and day are sent before it.
- **History in bulk:** `POST /api/sync/backfill` takes up to 500 sales per call, compressed, with the same checks as a normal sale, and resending is safe. In the test, 100,000 sales took 200 calls instead of 100,000.
- **Quiet hours only:** 22:00–06:00 by default, or after 10 minutes without use, and never while a sale is in progress.
- **How far back:** the owner picks 3 months (default), 12 months or everything, under Manager › Settings › Backup or on the Tech page. Older sales stay on the PC as "local only" and never count as "waiting".
- **Fixed in review:** backfilled old sales are quiet.
  - The kitchen ticket is recorded as already collected, so it never appears on today's kitchen screen.
  - No "order completed" webhook is sent.
  - **Nothing is sent to KRA (eTIMS) as a new invoice.**
  - Stock, credit and loyalty still apply.
- **Also:** two speed fixes, for the drawer check with a large backlog and the upload no longer recounting the whole queue.
- **Tests:** 23 cloud + 46 desktop; 12 mutations caught.

### A603: "Partner" in the Role list (cloud + web)
- **Owner only:** Settings › Users and access › Staff › + Add Staff › Role shows **Partner**, for the owner only. The cloud refuses it from a manager or a partner.
- **One step:** it requires an email and gives full rights (the business's General Manager role). The person gets web dashboard access and the invite in the same step, limited to the ticked branches. The POS PIN is optional.
- **All or nothing:** if access can't be given, the person isn't left half-added.
- **Partner label:** the staff list shows "Partner" on everyone with web access.
- **Not covered:** turning an existing member into a partner is still done with "Give web access".
- **Tests:** 18/18; 5 mutations caught.

### A604: admin portal clean-up (admin only, no client change)
- The owner's POS options are shown as plain On/Off text under "POS options (set by the owner)".
- The three cashier rows are replaced by one line pointing to Roles and permissions.
- The three always-on flags (`blind_shift_close`, `confirm_shows_cashier_figures`, `kitchen_void_approval`) are gone. The cloud now refuses switching them (409).
- **Tests:** 16/16; 4 mutations caught.

### A605: professional brand colours (web + desktop)
- **An exact match:** the owner's colour is used exactly, and every shade is derived from it evenly. Navy stays blue, and dark yellow turns gold.
- **Placement:**
  - **Brand colour:** buttons, the pay button, the active menu item, links, focus and the first chart line.
  - **A faint tint:** the sidebar.
  - **Neutral:** pages, cards and tables.
  - **Secondary colour:** only the second chart line for now. With no secondary, neutral slate is used.
- **Always readable:** a pale yellow gets dark-brown text. Navy is lifted in dark mode. A green close to "paid" shifts one shade, so it's never confused with a status. The page explains this only when it happens.
- **Branding page:** tidy cards, **"Use colours from my logo"**, a **live preview** of the dashboard and the POS in light and dark, and **Save and Discard in a bar at the bottom**, shown only when something changed.
- **Tests:** 32 (476 colours checked); 4 mutations caught. The desktop part needs the next desktop release.

### A606: customer screen for two-screen POS machines (desktop + web)
- **The second window:** opens full screen on the customer's monitor. It never takes the keyboard or scanner. If the screen is unplugged it closes quietly, and it reopens when plugged back in.
- **Set-up:** Tech page or Manager › Settings, with "Show test screen" and "Identify displays".
- **What the customer sees:** idle → the sale (items, quantities, prices, discounts, running total) → payment (amount due, cash given and change) → "Thank you" → idle. It works fully offline.
- **Wording by business:** items, an order and table, litres and price per litre, or kg.
- **Premium:**
  - logo and brand colours, under themes;
  - the offers slideshow (up to 10 images under Settings › Branding › Customer screen, downloaded once and played offline);
  - the M-Pesa till or paybill number, shown large.

  The slideshow and M-Pesa number need the online licence. There's no invented QR code.
- **Privacy:** nothing private reaches the customer screen: no cost prices, staff details, PINs or other customers.
- **Web POS:** "🖥 Customer screen" opens a window to drag to the second monitor.
- **Tests:** 66 desktop and 17 cloud/web; 9 mutations caught. No migration.
- **Not done:** uploading the official Lipa na M-Pesa QR image; cash given and change on the web customer screen.

### A607: customer details at the counter, on both screens (desktop + cloud + web, migration 181, local schema 78)
- **Main screen:** "+ Customer" opens a quick panel for name and phone, plus KRA PIN when eTIMS is on.
  - **"Customer types it"** turns the main screen into a large form with nothing else showing, for a POS without a second screen.
  - **"Ask the customer"** sends the form to the customer screen.
  - Nothing attaches to the sale until the cashier presses "Use for this sale".
- **Second screen (premium):** the customer types their own details, with an on-screen keyboard. It needs the online licence and "The customer screen is a touch screen" ticked for that PC.
- **M-Pesa STK push**, when the business's own Daraja integration is set up:
  - The number is typed on either screen, the prompt goes to the customer's phone, and both screens show "Waiting… / Paid ✓".
  - **This now works on the desktop POS too.** It uses a new cloud route, `POST /api/mpesa/stk-push-pos`, plus a new table, `mpesa_stk_requests`, because a desktop sale has no cloud order at payment time.
  - The web's existing flow is unchanged.
- **KRA PIN** (A/P + 9 digits + a letter):
  - stored on the sale (`orders.buyer_kra_pin`), so a walk-in can give one for a single invoice;
  - printed on the receipt as "Buyer PIN: …";
  - **sent to KRA on the eTIMS invoice:** `custTin` is the sale's PIN, otherwise the customer's, where before it was always empty.
  - Backfilled history is still never fiscalised.
- **Consent:** every customer-facing form has a consent line and "Save my details for next time". Without it, no customer record is created.
- **Tests:** 84 desktop, 29 cloud/web and migration 181's 8; 9 mutations caught.
- **Not done:**
  - the buyer PIN shows unmasked on the order detail and reprint, as it's printed on the receipt;
  - switching eTIMS reaches a POS only at its next catalogue change;
  - the web customer-screen form isn't offered on phones.

## 2. Fixed during tonight's CI
- **The A600 test** pinned the Backup tab before A602 added its panel next to it. The pin is updated.
- **Six pins tonight's changes outgrew:** catalogue-refresh (a stub without the eTIMS flag), A541 (the M-Pesa routes not classified), stock-zero and prospect-features (`pos/init` now also reads the eTIMS flag), and format.test (the shared customer-screen copies carry their own formatter because the desktop has no lib/format; allow-listed with that reason).
- **The light-mode colour block was regenerated.** A607's customer panel used raw sky blue; it now uses the POS's action colour, so the back-office colour count stays under its baseline.
- **Line endings:** A606 had saved 21 files with Windows line endings. They're converted back to LF (git would have done it on commit).
- **The POS's first download grew 445 → 448.9 kB.** A605's palette has to colour the first screen, and A601's notice is on the POS page. The budget in `petrol-pos-a588.test.mjs` is now 452 kB, with the reason written there. The new Manager and Tech panels are in pages that load separately.

**First download, final:** A607 moved its new screens and the kitchen-void window into separately loaded parts, so it's now **446.3 kB**, against 450 kB in lazy-load-a517 and 452 kB in petrol-pos-a588.

## 3. Decisions to confirm
1. **Backup warning:** red after 12 hours, but only once the PC has been on 45 minutes, so it doesn't flash red every morning.
2. **Restore:** a backup from another POS of the same business is allowed only on a PC with no sales of its own.
3. **Cut-off:** 503 rather than 402, so older POS versions keep their sales queued. Exempting a client's backup does not release its updates; that's a separate switch.
4. **Going online later:** the default window is 3 months. Backfilled sales still apply loyalty points and credit charges.
5. **Partner:** reuses the General Manager role rather than a new "Partner" role. There's no migration, and nothing can drift out of step with General Manager.
6. **Customer screen:** standard is the sale and total; premium is the logo, brand colours, slideshow and M-Pesa number. Customers typing on the second screen is premium too.
7. **Buyer PIN:** shown unmasked on reprints, because it's on the receipt anyway.
8. **eTIMS (KRA) switch:** it is still in admin, now with a proper name, because it's live and the client can also set it. Should admin keep it?

## 4. Known gaps
- **Restore and bill numbers:** after a restore, sales made after that backup that already reached the branch server or cloud are gone from that PC, so bill numbers could repeat. There's a warning only. This is worst on a branch server.
- **Multi-PC desktop-only branches:** after the cut, a manager viewing another POS's shifts (A433, which reads them from the cloud) stops seeing new ones. There's no shop-network route for that screen yet.
- **Not looked at in the real app:** none of tonight's screens have been seen in a real browser or Electron app, only tested.
- **Going online later:** stock on the POS doesn't subtract "local only" sales; a stock count after going online fixes the level. History setting is on the desktop only, not the web.

## 4b. Deploy order (important)
- **Migration 181 must run before the cloud deploy** that carries A607. Until it does, the buyer-PIN and desktop STK writes fail and are logged.
- **The desktop schema moves 77 → 78.** Once the cloud is deployed, every POS still on 1.0.22 is reported as "behind": a warning on the POS and watchdog alerts. It keeps trading and syncing, because `HARD_MIN` is unchanged at 41. So deploy this cloud together with the next desktop release, not long before it.
- **The cut-off date (`DESKTOP_ONLY_CUTOFF_AT`) stays unset** until that desktop release is on clients' POSs.

## 5. Commit (one commit: the pieces share ci.yml, the register, syncEngine and the admin portal)

```
cd /c/swiftpos/pos && git status --short | wc -l
```
This lists every uncommitted file. Check that it's only tonight's work.

```
git add -A .github/workflows/ci.yml apps docs render.yaml scripts shared tests migrations/181_customer_details.sql && git status --short
```

```
git commit -m "Local backup on every PC every 6 hours and after day close, 10 kept, free-space guard, owner/manager Backup panel and safe restore (A600); desktop-only clients cut off from cloud backup and updates behind DESKTOP_ONLY_CUTOFF_AT with a month's notice, admin exemptions (A601); going online later: new sales first, bulk history backfill in quiet hours, owner picks how far back, old sales kept quiet (no kitchen ticket, webhook or eTIMS) (A602); Partner in the Role list, owner only, web access in one step (A603); admin portal POS options read-only, dead flags removed (A604); professional brand colours: exact palette, readable on any colour, logo colours, live preview, Save at the bottom (A605); customer screen for two-screen POS machines, premium logo, slideshow and M-Pesa number (A606); customer details on both screens, M-Pesa STK on the desktop, buyer KRA PIN on the sale, receipt and eTIMS invoice, consent (A607, migration 181, local schema 78)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

```
git push origin dev
```

## 6. After CI on dev passes
1. Run migrations **179, 180 and 181 on dev**: 179 and 180 are from yesterday, 181 is from A607.
2. **Test on dev:**
   - **Brand colours:** turn on themes for a test business. On Settings › Branding try #FACC15, #0B1F3A, #E11D48 and #16A34A. Check the menu, buttons, the Analytics chart and the web POS.
   - **Partner:** + Add Staff › Partner with an email and one branch. Check the invite and that they see only that branch.
   - **Admin:** the Features tab of a client reads as described in A604.
3. **The cut-off:** don't set `DESKTOP_ONLY_CUTOFF_AT` until the desktop release with A600/A601/A602 is out on clients' POSs. Then set it at least a month ahead.
4. **The next desktop release** (attendance, backup, cut-off, going online later, brand colours, the Electron bump): when you say the batch is ready.

## 7. Still on your list
- `BRANCH_DRAWERS_MEMO_S=300` on prod Render: send me Render's message if it's still refused.
- Approve 1.0.22 in admin and roll it out. Cashiers lose cash in/out by default.
- Mary's cash-in fix.
- **Rotate the prod DB password.**
- Magas duplicate owners.
- 32-bit POS rollout.
- Close port 4370 forwarding on the routers we tested.
- The two K40 writes, which need your yes: "Set device time", and the test user.
