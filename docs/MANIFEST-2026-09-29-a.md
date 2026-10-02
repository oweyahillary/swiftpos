# MANIFEST 2026-09-29-a — desktop 0.6.20: an offline close-and-reopen never strands a drawer; sync status for managers only

**Base:** origin/dev `7d3c076`. **Delivered as a patch:** `swiftpos-2026-09-29-v0.6.20.patch`. It **includes the version bump**
(apps/desktop/package.json and package-lock.json → 0.6.20), so there's no separate bump step. The owner applies it on `dev`,
commits and pushes. **No migration.**
**Deploy:** cloud → dashboard → tag v0.6.20 (stays a pre-release) → approve B Foods in the admin portal. **Don't close today's
shift on T1 until checklist §U has passed.**

Owner, 2026-09-29: "there is an issue if i am joining a till already running why do i need to key in a float?" → the till log →
"build 1-6" · sync status: "lock it under the manager … a small notification at the bottom with a resync option" · "sites have
internet, you can add the not[e] on the zreport".

## What was wrong (T1, this morning)
- T1 started **offline**. You closed yesterday's shift and opened today's, and rang two sales.
- When the internet came back, both trading days went up **in one upload**. The cloud saved them in no set order, and it allows
  only one open day per till. So today's new day was refused, and its shift was refused with it.
- The till set both aside and **never sent them again**. The log didn't mention the refusal.
- The result: the cloud thought T1 was closed, so the web asked for a float, and the two sales have been waiting ever since.
  They're safe on T1.

## What changed
1. **The cloud saves a till's closing day before its new one**, so an offline close-and-reopen is never refused.
2. **The till re-sends a day or shift set aside for this reason, once.** On 0.6.20, T1 sends today's shift up by itself, then the
   two sales, and the web then shows "T1 · open — Eugene". This works even if the till updates before the cloud.
3. **Every cloud refusal is written in swiftpos.log** (it used to appear only on the Sync card).
4. **The web-sales download renews its sign-in** instead of failing every 20 seconds for hours (the 401 lines in your log).
5. **No more false "recovered" lines** after every failure, and a dropped update download no longer throws an unhandled error.
6. **Sync status is for managers only.**
   - Cashiers see nothing. Selling, cash and M-Pesa work the same offline, and M-Pesa at the till is a typed code.
   - Managers and the owner get a small notice at the bottom only when something waits: "4 records waiting to sync · last
     synced today 10:15 · **Sync now**". It turns **red with the cloud's reason** when something was refused, or shows **Retry**
     when sales failed.
   - The manager screen shows a neutral "Last synced: today 10:15".
   - The **Z-report**, on screen and on paper, says "NOT BACKED UP YET: 2 sales … only on this till" when that's true.
   - There's no "offline for hours" nag.

**Not done:** showing "(via T1)" for a second till that syncs through the branch node. There's no second till to verify it with.

## Files
| Area | Files |
|---|---|
| Cloud | NEW `apps/server/src/lib/dayOrder.ts`; `apps/server/src/routes/sync.ts` (days written closes-first) |
| Till (main) | `src/main/syncEngine.ts` (requeueAfterDayClash, refusals logged, web-sales token renewal, clean-pass recovery, parked + last-synced status), `src/main/autoUpdate.ts`, `src/main/shiftService.ts` (Z-report `notBackedUp`) |
| Till (screens) | NEW `src/renderer/lib/syncNotice.ts`; `pages/POSPage.tsx` (managers-only status, bottom notice), `App.tsx`, `pages/ManagerPage.tsx` (Last synced), `components/ZReportView.tsx`, `lib/printShiftReport.ts`, `lib/posApi.ts` |
| Printing | `shared/printing/src/shiftReport.ts` (`backupNote`); web bundle `apps/dashboard/src/lib/escposRenderer.js` rebuilt |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.20 |
| CI | `.github/workflows/ci.yml`: steps "Desktop trading-day clash never strands a drawer", "Desktop sync notice for managers" |
| Tests | NEW `apps/desktop/test/day-clash-sync.test.mjs` (22), NEW `tests/day-order.test.mjs` (4), NEW `apps/desktop/test/sync-notice.test.mjs` (9), NEW `shared/printing/test/shift-report-backup.test.ts` (3, in `npm test`); `apps/desktop/test/update-approval.test.mjs` (+1) |
| Docs | `docs/AUDIT-REGISTER.md` (A363; Tree v0.6.20), `docs/checklists/VERIFY-CHECKLIST-v0.6.20.html` + `docs/VERIFY-CHECKLIST-v0.6.20.md` (17 checks, incl. the unchecked A360–A362), this file |

## Verification (bench: Linux, Node 22)
```
day-clash-sync 22/22 — the COMPILED engine on SQLite vs a stand-in cloud enforcing one open day per till: this morning
  reproduced (parked, the log line, parked in the status, no "last synced", the Z-report note), then recovered by the one-time
  re-send, then a fixed cloud never refusing; once-only; web-sales 401 renewal; no false "recovered".
day-order 4/4 — the COMPILED /api/sync/push, today's day sent FIRST still lands; a real clash still refused.
sync-notice 9/9 · shift-report-backup 3/3 (golden receipts unchanged) · update-approval 17/17 — 14 mutations bite.
Every tests/*.test.mjs · every desktop test (non-Electron) · shared/printing npm test · every static gate · typecheck ratchet ·
server, desktop (typecheck + main + renderer) and dashboard builds · web bundle reproducible (--check) · register consistency.
Not run here: electron-builder packaging (its header download is blocked by this bench's proxy; the Release workflow packages).
```
Not verified here (rule 16): T1 itself, the live cloud, the screens on a real till, the printed report.

## Rollout (owner)
1. Deploy the **cloud**, then the **dashboard**, from `dev`.
2. Tag **v0.6.20**. Leave it a pre-release.
3. Admin portal → B Foods → approve 0.6.20. Restart T1, and close and reopen it when the update is ready.
4. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.20.html` — **§U first** (T1's shift and sales reach the cloud), then the rest.

## Rollback
```bash
git revert <the owner's commit>   # no data change; a till on 0.6.20 keeps working against the reverted cloud
```
