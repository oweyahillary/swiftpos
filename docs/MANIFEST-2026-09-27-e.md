# MANIFEST 2026-09-27-e — A337: previous shift reports, expenses in the shift report, a colour-coded Daily Sales Report

**Base commit:** `ecec08a` (origin/dev = desktop v0.6.10; CI #411 green; Release desktop #26 green). One commit on
`claude/modest-cray-f21ll5`; the owner fast-forwards `dev`. **Deploy: desktop v0.6.11.** The cloud is unchanged. The dashboard's
web receipt bundle is rebuilt from `shared/printing`, but the web POS sends no expenses, so it prints exactly as before. Deploying
the dashboard is harmless but not needed. Local schema is unchanged (55).

Owner (2026-09-27): "1. I should be able to print previous shift reports 2. I should be able to see expenses, and it should also be
part of the shift report 3. formatting of the daily sales report can we color code maybe headers, total, important figures etc".

## What changed
1. **Previous shift reports.** Manager → Shift → **Shift report** has a picker: *Current shift (live)* or any previous shift on this
   till (date/time → close time · cashier · "force-closed" where so). A previous shift opens as its Z-report and **Print report**
   prints it through the same thermal path.
2. **Expenses in the shift report.** Expected cash has always had expenses taken off, but the report never printed them, so its
   lines did not add up whenever an expense was paid. Now the screen and the paper show **"− Expenses"** between Float out and
   Expected cash, plus an **EXPENSES (n)** section (description, who paid, amount). A long description wraps whole on 58 mm.
3. **Expenses screen.** NEW Manager tab **Expenses**: this till's expenses by date range (Today … Custom), who paid, the total, and
   "not synced" where so. Expenses are still recorded from the POS (Shift → Expenses).
4. **Daily Sales Report colours.** The figures and their order are unchanged.
   - Business name: white on teal.
   - Section names: white on dark teal.
   - Column headings: pale teal.
   - Section totals: gray.
   - **Total Gross** and the collections **Total**: pale amber.
   - Discrepancy, stale-terminal and unreconciled-difference lines: pale red.
   - Generated-on and provenance lines: gray.

   Every style reads at 4.5:1 or better, so the sheet still works in black and white.

## Files (15)
| File | Change |
|---|---|
| `apps/desktop/src/main/shiftService.ts` | `totals.expenses`, `expenseLines`; NEW `listShifts`, `listExpenses`. |
| `apps/desktop/src/main/ipcHandlers.ts`, `ipcSchemas.ts`, `preload.ts` | NEW `shift:history`, `expense:range`. |
| `apps/desktop/src/renderer/lib/posApi.ts` | Types. |
| `apps/desktop/src/renderer/pages/ManagerPage.tsx` | Shift report picker; NEW Expenses tab. |
| `apps/desktop/src/renderer/components/ZReportView.tsx` | "− Expenses" line; EXPENSES section. |
| `apps/desktop/src/renderer/lib/printShiftReport.ts` | Sends expenses to the printer. |
| `shared/printing/src/shiftReport.ts` | Prints them (optional fields; wraps long descriptions). |
| `apps/dashboard/src/lib/escposRenderer.js` | Rebuilt bundle (`--check` OK). |
| `apps/desktop/src/main/dailySalesReport.ts` | `buildDailySalesWorkbook` split out; row styles. |
| `apps/desktop/test/shift-reports.test.mjs` | NEW — 25 checks. |
| `.github/workflows/ci.yml` | Step "Desktop shift reports, expenses and the daily report". |
| `docs/AUDIT-REGISTER.md` | A337; header; Tree row v0.6.11; changelog. |
| `docs/MANIFEST-2026-09-27-e.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
apps/desktop test/shift-reports.test.mjs → 25 passed
  (real compiled shiftService + dailySalesReport on SQLite; real shared/printing renderer; workbook read back with ExcelJS)
  6 mutations: totals.expenses dropped · listShifts device filter · listExpenses device filter · printed "- Expenses" line ·
  key-row fill · long description cut → each reddens its check
shared/printing npm test → PASS (SAMPLE-OUTPUT unchanged) · web receipt bundle --check OK
tests/*.test.mjs → all pass · desktop tests (26 files) → all pass · scripts/test-* → all pass
desktop main + renderer tsc, desktop renderer and dashboard builds OK · dashboard ratchet OK
own-rows · sql-binds · row-attribution · ipc-parity · ipc-validation · header-keys · schema-parity · reference-names · web-pos-green ·
  back-office-colour · till-green · doc-refs · root-clean · api-routes · permission-parity · notnull-writes · light-colours →
  all OK · register-consistency OK with the 0.6.11 bump
```
Not verified here (rule 16): the screens and a real print on the till.

## Owed on target (till on 0.6.11)
- **G1.** Pay an expense from the POS (Shift → Expenses), e.g. 150 "Gas". Manager → Shift → Shift report: the report shows
  "− Expenses 150" and an EXPENSES section, and Opening float + Cash sales + Float in − Float out − Expenses = Expected cash.
- **G2.** Print it. The paper shows the same lines. Try a long description too.
- **G3.** Close the shift. Shift report → the picker lists it → choose it → its Z-report (closed, counted, variance) → Print.
- **G4.** Manager → **Expenses**: today's expense(s) with who paid and the total. Switch to Last 7 days.
- **G5.** Orders → Daily Sales Report (.xlsx). Open it in Excel. Check the teal title and section bands, pale-teal headings, gray
  section totals, amber Total Gross and collections Total, and that the numbers match 0.6.10's report for the same day.

## Rollback
```bash
git revert <this commit>   # desktop only; no schema or cloud change
```
