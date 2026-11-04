# Morning report — 1 November 2026

## 1. Attendance: work days, shifts and late arrivals (A616), on `dev`, ready to commit

**What changed:**
- **The pairing is fixed.** Punches are grouped into work days first, then paired within each day. A punch before 06:00
  counts for the night before. One missed punch no longer moves the days after it.
- **Tested on your real device file:** the team comes out at 1,890 h, against 1,907 h in the summary you shared.
  Kowsar is now 83.1 h; the old rule gave 96.9 h.
- **Shifts section**, for whoever can correct attendance:
  - shifts per branch, with **Copy the shifts of another branch**;
  - a **Shift** column in People: "Nearest each day", or a pinned shift.
- **Late arrivals:**
  - a card for the team and one per person;
  - an amber bar under a late day in the grid;
  - the shift and "25 min late" on each of a person's days;
  - Late columns in the Excel download.
  - None of this shows until a branch has shifts.
- **Night staff need a Night shift** (18:00 – 06:00) on their branch. Without any shifts, a night guard's punch-in and
  punch-out can't be told apart.
- **Fixed with it:**
  - **All branches** now shows all branches; before, it showed only the sidebar's branch, which is why you saw 0 h.
  - **This month** no longer stretches the page.

**Migration 184** adds the shifts table and the pinned shift. If the code is deployed before the migration is run, the
report works exactly as it does now.

**Design note:** [docs/A616-attendance-shifts.md](A616-attendance-shifts.md).

**Local CI:**
- 268 steps and 318 test files, run one by one.
- **Every failure is known Windows noise:**
  - no `python3` for the schema audit;
  - the migrations npm install;
  - the libuv crash on exit after all checks pass (exit 127);
  - the desktop money-reports time-zone case.
- **One migration test,** `test-migrations-41-42`, passes all 31 checks and then hits the same Windows exit crash. The
  runner excuses that crash only after an "N passed, 0 failed" line, and this older test prints "all green". It has
  nothing to do with A616.
- **New tests:** attendance 52 of 52, migration 184 8 of 8, the demo seed 4 of 4.

**Commit (Git Bash):**
```bash
cd /c/swiftpos/pos
git add .github/workflows/ci.yml apps/dashboard/src/lib/attendanceView.ts apps/dashboard/src/pages/attendance/AttendancePage.tsx apps/server/src/lib/attendanceRules.ts apps/server/src/routes/attendance.ts scripts/dev-seed/attendance-demo-cleanup.sql scripts/dev-seed/attendance-demo.sql scripts/schema-index.json scripts/test-attendance-demo-seed.mjs tests/attendance-a599.test.mjs docs/A616-attendance-shifts.md migrations/184_attendance_shifts.sql scripts/test-migration-184.mjs docs/MORNING-REPORT-2026-11-01.md
git commit -m "Attendance work days and shifts (A616, migration 184): punches grouped into work days before pairing (before 06:00 is the night before; a night guard's day from noon once the branch has a Night shift), so one missed punch never shifts the following days (real ZKTeco export: 83.1 h, not 96.9 h); shifts per branch (copy from another branch, end, pin a person, else the nearest shift each day); late arrivals on cards, the grid, a person's days and the Excel; the report as before until migration 184 runs; All branches now reads every branch, not the sidebar's; This month no longer widens the page; demo shifts in the dev seed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```

**Then on dev:**
1. Run `migrations/184_attendance_shifts.sql`.
2. Re-run the demo seed for B Foods. It adds only what's missing: three "(demo)" shifts, with the delivery person pinned.
3. Open Attendance and check:
   - the **Shifts** section;
   - the **Late arrivals** card;
   - one person's days;
   - **This month**.

## 2. Shared components (branch `shared-components`, worktree `C:\swiftpos\pos-shared`)

Nothing is committed. The full write-up is in sections **8e** and **8f** of the shared-components plan document, which
is on that branch only (in `C:\swiftpos\pos-shared`).

### 2a. The next phase: step 3, batch F (POS screen pieces into `@zaptill/ui`)

| Piece | Result |
|---|---|
| **MethodDot** (payment-method dot) | **Moved.** The two copies were identical. One file now serves both POS. |
| **Pager** (lists in pages) | **Moved.** One pager for both apps; each app keeps its own look in a small wrapper, so neither app's styling changed. |
| WeightModal (weighed item) | **Left.** The weight is shown differently on each POS (the PC's number format vs Kenyan), and the markup differs. |
| NoteModal (order note) | **Left.** The example text differs ("Customer will collect at 1pm" vs "Collect at 1pm") and so does the markup. **Your call:** pick one wording, and it can be shared. |
| KitchenVoidModal | **Left.** It behaves differently on each POS: who confirms, how it closes, the spinner. |

**Checks:**
- **Rendering:** both POS draw exactly what they drew before (762 renders compared, 0 differences).
- **Stylesheets:** byte-identical.
- **POS main chunk:** unchanged at 446.4 kB.

### 2b. Clean-code pass (`packages/core` and `packages/ui`)

**Code reorganised in 7 modules.** Long functions are split into small named steps, and rules written two or three times
now live in one helper:
- **labels:** the label layout, and the barcode check-digit rule for the three printer languages;
- **offers:** the discount engine is now four clear steps (meals, buy-X-get-Y, per item, spend), with nothing hidden
  between them;
- **barcode:** EAN-13 and EAN-8 share their helpers;
- **menuHours:** one cut-off clamp, used in three places;
- **customerScreen, themes and permissions:** smaller tidy-ups.

**The rest:**
- **36 more files:** only their header comments changed. They described the old copies; they now name the package and
  who uses it. Every owner decision and date in the comments is kept.
- **Already clean, left alone:** posFeatures, customerDetails, businessTerms, scaleBarcode and the rest.
- **No tangles:** core modules depend on each other in only 3 places, with no loops and no hidden shared state.

**Proof that nothing behaves differently:**
- **Old against new:** every function of the 7 changed modules was called with the old and the new code. **385,742
  cases, 0 differences,** including every label printer's bytes. I re-ran labels and offers myself: the same.
- **Tests:** 745 root and 716 desktop checks pass.
- **POS main chunk:** 27 bytes smaller.

**Possible bugs found and *not* changed** (your call):
1. **Offers with a branch limit:** an offer limited to some branches is accepted when the cloud re-checks a sale without
   its branch. I need to confirm the cloud always sends the branch.
2. **Weekend order:** offers show "Sun, Sat", menu hours show "Sat, Sun". Cosmetic.
3. **A stored customer-screen choice** of `true` or blank becomes screen 1 or 0. Harmless today.
4. **Two copies of the scale's barcode check-digit rule:** the scale's copy doesn't refuse letters. They were left
   separate, because merging them would change the scale's result for bad input.

### 2c. Full CI on the branch

- **265 steps:** 7 failures, all the known Windows noise:
  - no `python3`;
  - the migrations npm install;
  - the offline step, re-run file by file;
  - money-reports (time zone);
  - three desktop exit-127 crashes after passing.
- **File by file:** 316 clean; 2 more passed, then hit the Windows exit crash.
- **Migration tests:** 96 of 97 pass; the other is the same "all green" 41–42 case as on dev.

**Commit (Git Bash):**
```bash
cd /c/swiftpos/pos-shared
git add -A apps packages scripts tests docs
git status --short
git commit -m "Shared components batch F and a clean-code pass: MethodDot and Pager moved to @zaptill/ui (each app keeps its pager look in a thin wrapper; WeightModal, NoteModal and KitchenVoidModal left: they differ in wording, markup or behaviour), check-shared-sync covers the POS folders and the look wrappers; packages/core tidied without behaviour change (labels, offers, barcode, menuHours, customerScreen, themes, permissions split into small named helpers, repeated rules in one place; 385,742 old-vs-new cases identical), module headers name the packages; renders, stylesheets and the POS main chunk unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin shared-components
```

**Before you commit:**
- **Pager file:** check that `git status` shows `packages/ui/src/Pager.tsx` as added; it is a new file.
- **dev → branch merge:** this is due, to bring in A611–A616. I didn't merge, because a merge makes a commit.
- **Stray file:** delete `C:\Program Files\Git\tmp_labels_bak` by hand. It's a backup copy the clean-up's tests left
  outside the repository, and a safety check stopped me deleting it.

## 3. Your items (unchanged)

- **KRUNCH & CO:** cancel the two 24 Oct day closes before restoring the licence.
- **Supabase:** move prod by 15 Nov, and rotate the prod DB password.
- **1.0.22:** approve the rollout.
- **Billing:** enter the real billing details and prices in the admin portal.
- **Migrations:** 182 waits for the A612 deploy; 183 and 184 can run on dev.
