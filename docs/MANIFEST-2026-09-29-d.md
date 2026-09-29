# MANIFEST 2026-09-29-d — desktop 0.6.23: the owner's follow-ups to shift confirmation + Shift Reports (A365)

**Base:** origin/dev `1634044`. **Delivered as a patch:** `swiftpos-2026-09-29-v0.6.23.patch`. It **includes the version bump**
(apps/desktop/package.json and package-lock.json → 0.6.23). The owner applies it on `dev`, commits and pushes. **No migration.
The cloud is unchanged;** deploy the dashboard, because the web POS changed.

On T1 (0.6.22) M1 and M2 passed. The owner then asked for four changes: "if the method of payment is 0 let it not appear,
remove the feature were scroll up or down reduces or increases the value it can mess the cashier, Counted cash in drawer (KES)
add something like include opening float … since its the manager who is logged in do they need to key in their password?"

## What changed
1. **A method with nothing recorded is not asked.**
   - End Shift asks only for the methods this shift took money on. With no M-Pesa sales, there's no M-Pesa box, and the
     method counts as 0.
   - The manager's recount asks for cash, every method the cashier declared money on, and every method the till recorded.
   - So a method the cashier put at 0 but the till recorded still shows. That gap is exactly what a recount exists to find.
2. **The mouse wheel never changes a number,** and there are no up/down arrows. A number box with the cursor in it loses
   focus when the wheel turns, so the value can't move, and the page still scrolls. This covers the till and the web POS.
3. **The cash label now says "— include the opening float"**, on the till and the web POS.
4. **A manager who is already signed in confirms without a PIN,** as themselves.
   - A cashier who is signed in still needs a manager's PIN.
   - On the till, this is decided in the main process from the signed-in staff, so it can't be bypassed from the screen.
   - On the web POS it uses the signed-in person's permissions. The cloud already accepted a signed-in manager.

5. **New on the dashboard: Finance → Shift Reports.** Owner: "a table like cashier name, shift date, confirmed (if its still
   running or not), view — when they click view now they get such a table … you can improve on my suggestion".
   - **The list:** Cashier · Till · Shift (opened–closed) · Status · Difference · View.
   - **Status** is one of: Running, Awaiting manager check, Confirmed by …, Self-confirmed, Force-closed, or closed before
     confirmation existed.
   - **Difference** shows what is over or short, so a problem stands out without opening the shift.
   - **Filters:** dates, and All / Running / Awaiting check / Confirmed / **Problems**. Problems means something is over or
     short, the counts differ, the shift still awaits a check, or it was never counted. There's also a **CSV export**.
   - **View** shows, per method: Cashier said · Manager counted · Till recorded · Variance. Differences are highlighted, and
     it shows the opening float, the times, who confirmed and when, and the notes. It can be printed.
   - It uses only existing cloud routes, so there's no cloud deploy for this, just the dashboard.

## Files
| Area | Files |
|---|---|
| Shared | `shared/shiftConfirm.ts` (+ copies): `methodsToDeclare(taken)`, `methodsToCount`, `maySignedInConfirm`, `shiftReportStatus`, `shiftReportLines`, `shiftDifference`; NEW `shared/numberInputs.ts` (+ copies `apps/desktop/src/shared/`, `apps/dashboard/src/lib/`); `scripts/check-shared-sync.mjs` |
| Till (main) | `shiftService.ts` (`methodsToCount`; the awaiting list and the Z-report carry it; `confirmShift` requires only those), `ipcHandlers.ts` / `ipcSchemas.ts` / `preload.ts` (`shift:canConfirm`; PIN optional for a signed-in manager) |
| Till (screens) | `pages/ShiftPanel.tsx`, `components/ConfirmShiftModal.tsx`, `lib/posApi.ts`, `main.tsx`, `index.css` |
| Web / dashboard | NEW `pages/ShiftReportsPage.tsx`, `App.tsx` (route), `components/DashboardLayout.tsx` (Finance → Shift Reports); `pages/pos/ShiftModal.tsx` (the shift's `by_method`; no PIN for a signed-in manager; the float label), `components/ShiftConfirmations.tsx`, `main.tsx`, `index.css` |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.23 |
| Tests | `apps/desktop/test/shift-confirm.test.mjs` (34 → 48), `tests/shift-confirm.test.mjs` (19 → 22) |
| Docs | `docs/AUDIT-REGISTER.md` (A365: on target — migration 110, M1, M2 PASS; 0.6.23; Tree v0.6.23), `docs/checklists/VERIFY-CHECKLIST-v0.6.23.html` + `docs/VERIFY-CHECKLIST-v0.6.23.md` (30 checks), this file |

## Verification (bench: Linux, Node 22)
```
shift-confirm (till) 48/48 · shift-confirm (cloud + web pins) 22/22 · 10 more mutations bite (zero filter, the wheel blocker,
the till-recorded methods in the recount, the signed-in rule, the PIN-required guard; the report's official figure, self
status, mismatch, the cash line, unknown expected cash).
Every desktop test (non-Electron) · every tests/*.test.mjs · every static gate · the whole CI "Schema drift" job (incl.
schema-parity) · schema audit · typecheck ratchet · migration tests · shared/printing npm test · web bundle reproducible ·
server, desktop (typecheck + main + renderer) and dashboard builds.
```
Not verified here: T1, a real mouse wheel, the web POS in a browser.

## Rollout (owner)
1. Apply, commit, push; CI green. Deploy the **dashboard** from `dev`.
2. Tag **v0.6.23** (pre-release) → admin portal → B Foods → approve 0.6.23.
3. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.23.html` — §F first.

## Rollback
```bash
git revert <the owner's commit>   # no data change
```
