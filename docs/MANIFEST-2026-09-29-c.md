# MANIFEST 2026-09-29-c — desktop 0.6.22 + cloud + migration 110: a manager confirms every shift (A365)

**Base:** origin/dev `ca58468`. **Delivered as a patch:** `swiftpos-2026-09-29-v0.6.22.patch`. It **includes the version bump**
(apps/desktop/package.json and package-lock.json → 0.6.22). The owner applies it on `dev`, commits and pushes.
**Migration 110 must run BEFORE the cloud deploy** (the cloud's close writes the new column).

Owner, 2026-09-29: "a manager should be able to confirm end shift count when a cashier closes their shift and also close day,
as is at the moment its only close day no way to confirm shift" → "the managers should confirm shift before closing the day,
but he can confirm a shift in the moment its closed by the cashier … They can confirm anytime but recommended the moment the
cashier closes … it should block they have to confirm shifts. They should recount incase the cashier submitted less than the
amount. Yes applies to both. The shift confirmation should be on all payment method not just mpesa" · Close Day still counts
the cash again · the cashier declares every method · a manager's own shift: allowed, flagged.

## What it does
1. **End Shift: the cashier declares every payment method.** Cash is counted as before. The M-Pesa, card and Glovo totals come
   from the statement or slips, and so does every custom tender and anything else the shift took. Enter 0 if none.
2. **A manager confirms the shift with a blind recount of every method,** entering their PIN.
   - "Manager: confirm now" appears on the closed shift, which is the recommended time. It can also be done later: from
     Manager → Close on the till, or from Open Shifts → Shift confirmations on the dashboard.
   - The manager sees neither the cashier's figures nor the expected ones until they save.
   - Afterwards, a line per method shows cashier / counted / expected. The manager's figures are the confirmed ones, a
     shortage or overage is shown, and any method where the recount differs from the cashier is highlighted.
3. **Close Day refuses while any shift of the day is unconfirmed**, and names the shifts: "A shift must be confirmed by a
   manager before the day can close: Test Cashier 13:41–17:02." The manager still counts the cash at Close Day as before.
4. **A manager confirming a shift they worked** is allowed, and marked "(self-confirmed)".
5. **Web POS:** Close Shift declares every method, then "Manager: confirm now" takes a manager's PIN and the recount.
   **Dashboard:** the awaiting list, a blind Confirm with no PIN (the manager is signed in), and recent confirmations with any
   differences.
6. **Offline:** the till checks the manager's PIN with the branch node, then the cloud. Only when neither can be reached does
   it use its own saved sign-ins. The confirmation syncs after the shift's close.
7. **Shifts closed before this release never wait.** They have no declaration, so today's morning shift doesn't block tonight.
8. **The Z-report shows it, on screen and on paper:** "CONFIRMED BY MARY 17:05", a line per method, and "cashier said …" where
   the figures differ.

## Files
| Area | Files |
|---|---|
| Database | NEW `migrations/110_shift_confirmation.sql`; `scripts/schema-index.json` (+ 6 shifts columns) |
| Cloud | NEW `apps/server/src/lib/shiftConfirm.ts`; `routes/shifts.ts` (close stores the declaration; `POST /:id/confirm`, `POST /confirmer`; list adds confirmer/awaiting); `lib/approver.ts` (`may` option); `lib/schemas.ts` (`declared_methods`); `middleware/auth.ts` (till write allowlist + confirm, confirmer); `lib/desktopSchema.ts` (REQUIRED 57) |
| Till (main) | `localDb.ts` (schema 57 columns), `shiftService.ts` (declaration, `confirmShift`, `awaitingConfirmation`, Z-report block), `dayService.ts` (Close Day refuses), `syncEngine.ts` (close carries the declaration; `confirm` stage), `ipcHandlers.ts` / `ipcSchemas.ts` / `preload.ts` (`shift:awaiting`, `shift:confirm`, PIN authority chain) |
| Till (screens) | NEW `components/ConfirmShiftModal.tsx`; `pages/ShiftPanel.tsx`, `pages/DayCloseTab.tsx`, `components/ZReportView.tsx`, `lib/printShiftReport.ts`, `lib/posApi.ts` |
| Shared | NEW `shared/shiftConfirm.ts` + copies `apps/desktop/src/shared/`, `apps/dashboard/src/lib/` (check-shared-sync); `shared/printing/src/shiftReport.ts` (`confirmLines`); web bundle `escposRenderer.js` rebuilt |
| Web / dashboard | `pages/pos/ShiftModal.tsx`; NEW `components/ShiftConfirmations.tsx`; `pages/OpenShiftsPage.tsx` |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.22 |
| CI | `.github/workflows/ci.yml`: step "Desktop shift confirmation by a manager" |
| Tests | NEW `apps/desktop/test/shift-confirm.test.mjs` (34), NEW `tests/shift-confirm.test.mjs` (19), NEW `scripts/test-migration-110.mjs` (6); `apps/desktop/test/stock-web-pos.test.mjs` (schema 56 → "56 or later") |
| Docs | `docs/AUDIT-REGISTER.md` (A365; Tree v0.6.22), `docs/checklists/VERIFY-CHECKLIST-v0.6.22.html` + `docs/VERIFY-CHECKLIST-v0.6.22.md` (24 checks), this file |

## Verification (bench: Linux, Node 22)
```
shift-confirm (till) 34/34 — the COMPILED services on SQLite + a stand-in cloud: declaration stored; Close Day refuses and
  names the shift; blind recount lines (short 100, card the cashier missed); self flag; a second confirmation refused; a close
  from an older build never waits; the close carries the declaration; a cloud without /confirm (404) → waits; then the
  confirmation reaches the cloud once; the shared helper; screen pins.
shift-confirm (cloud) 19/19 — the COMPILED routes over HTTP: rules; close stores the declaration; open shift / cashier / a
  cashier's PIN refused; a manager's PIN; a signed-in manager; a self-confirm; the till's replay; another till refused; the
  write allowlist; web and dashboard pins.
migration 110 6/6 (PGlite). 15 mutations bite.
Every desktop test (non-Electron) · every tests/*.test.mjs · every static gate · schema audit (strict) · typecheck ratchet ·
migration tests · shared/printing npm test (golden receipts unchanged) · web bundle reproducible · server, desktop (typecheck +
main + renderer) and dashboard builds.
Not run here: electron-builder packaging (the Release workflow packages).
```
Not verified here: T1, the live cloud, the screens on a real till or browser, the printed report.

## Rollout (owner)
1. **Finish tonight's §D on 0.6.21 first.**
2. Supabase → SQL editor → run `migrations/110_shift_confirmation.sql` (checklist R1 has the check query).
3. Deploy the **cloud**, then the **dashboard**, from `dev`.
4. Tag **v0.6.22**; leave it a pre-release. Admin portal → B Foods → approve 0.6.22.
5. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.22.html` — §M.

## Rollback
```bash
git revert <the owner's commit>   # the columns stay (additive); a till on 0.6.22 keeps its local confirmations
```
Migration 110 is additive; leaving it applied after a revert is harmless.
