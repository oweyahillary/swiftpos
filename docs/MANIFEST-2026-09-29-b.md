# MANIFEST 2026-09-29-b — desktop 0.6.21: a day close is a cash-up; a later shift reopens the day (A364)

**Base:** origin/dev `02c8814`. **Delivered as a patch:** `swiftpos-2026-09-29-v0.6.21.patch`. It **includes the version bump**
(apps/desktop/package.json and package-lock.json → 0.6.21). The owner applies it on `dev`, commits and pushes. **Till only — no
cloud or dashboard deploy, no migration.**

Owner, 2026-09-29: "I closed the shift that was running in the morning and i am trying to open another the erro above shows i
cannot proceed" → "we can have upto 3 shift in a day of 8hrs … limiting to 1 a day is a wrong move … maybe day opening and closing
but that should not even limit per day" → overlapping cashiers are on **different tills**; a day close is a **cash-up only**.

## What was wrong (T1, this afternoon)
- After the morning shift closed, the trading day was closed too (Manager → Close the day).
- The till keeps one trading-day row per till per date, and so does the cloud. Opening the next shift tried to start a SECOND day
  for 29 Sep, which the till refused. Its message for that refusal is "That record already exists."
- So after a day close the till could not trade again that date.

## What changed
1. **A shift opened after today's day was closed reopens that same day.** It's the same record, so the cloud accepts it. There's no
   error and nothing extra to do.
2. **The earlier cash-up is kept.** The day's notes read "Cashed up 13:40: counted …, expected …, variance …. Reopened 14:02 by …
   for a new shift."
3. **The next close counts only the shifts since the reopen**, so the cash already counted isn't counted again. The day's record
   then holds the **whole day**: every cash-up added together.
4. The Day Close screen says: "This is a cash-up. A shift opened later today reopens the day, and the next close counts only the
   cash since."
5. **Unchanged:** one shift per till at a time (overlapping cashiers use another till). A day from an **earlier date** left open
   still needs a manager.

## Files
| Area | Files |
|---|---|
| Till (main) | `src/main/dayService.ts` (reopen, running totals, the whole day on the row), `src/main/nodeIngest.ts` (`day_reopened` event), `src/main/localDb.ts` (comment) |
| Till (screen) | `src/renderer/pages/DayCloseTab.tsx` (the cash-up line) |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.21 |
| CI | `.github/workflows/ci.yml`: step "Desktop day close is a cash-up, a later shift reopens the day" |
| Tests | NEW `apps/desktop/test/day-reopen.test.mjs` (16) |
| Docs | `docs/AUDIT-REGISTER.md` (A364; Tree v0.6.21), `docs/checklists/VERIFY-CHECKLIST-v0.6.21.html` + `docs/VERIFY-CHECKLIST-v0.6.21.md` (18 checks; carries 0.6.20's §O §S §L §X), this file |

## Verification (bench: Linux, Node 22)
```
day-reopen 16/16 — the COMPILED shiftService + dayService on SQLite: the morning shift + cash-up, then a new shift opens (same
  day row, notes, event), the second cash-up counts only the shifts since, the row holds the whole day, a third shift reopens
  again, one shift per till still enforced, an unclosed earlier day still blocks. 5 mutations bite — without the reopen it fails
  with the exact "UNIQUE constraint failed: index 'business_days_till_date'".
Every desktop test (non-Electron) · every tests/*.test.mjs · every static gate · schema audit (strict) · typecheck ratchet ·
migration tests · register consistency · server build · desktop typecheck + main + renderer builds.
Not run here: electron-builder packaging (the Release workflow packages).
```
Not verified here: T1 itself, the live cloud.

## Rollout (owner)
1. Apply, commit, push; CI green. Tag **v0.6.21**. Leave it a pre-release.
2. Admin portal → B Foods → approve 0.6.21. Restart T1, and close and reopen it when the update is ready.
3. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.21.html`, **§D first**.

**Until then:** T1 can't open a shift today. Trade on the web POS (its own shift), or wait for 0.6.21.

## Rollback
```bash
git revert <the owner's commit>   # no data change; a reopened day is an ordinary open day to 0.6.20
```
