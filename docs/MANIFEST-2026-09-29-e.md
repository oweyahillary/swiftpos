# MANIFEST 2026-09-29-e — Shift Reports print a report, not the page (A365, dashboard only)

**Base:** origin/dev `12a7998` (desktop 0.6.23, deployed and on T1). **Delivered as a patch:**
`swiftpos-2026-09-29-shift-report-print.patch`. **Dashboard only:** no till version, no migration, no cloud change.

Owner, 2026-09-29, with the PDF the browser printed from Shift Reports: "on the dashboard please change this it should not be
the page screenshot but a report".

## What changed
- **View → Print report** builds an A4 **SHIFT REPORT** from the data, using the same printer as purchase orders and
  goods-received notes. It contains:
  - the business header;
  - cashier, till, opened / closed, opening float, and the status with the confirmation time;
  - the table: Method · Cashier said · Manager counted · Till recorded · Variance, with * where the manager's count
    differs from the cashier's;
  - totals: counted, recorded, and "Total SHORT" or the total variance;
  - the notes, which explain the variance and the self-confirmation flag, plus the shift's own notes;
  - Cashier and Manager signature lines.
- **The accent colour** is red when the shift is short, teal when confirmed, and amber while it awaits a manager.
- **List → Print report** builds a **SHIFT REPORTS** document for the dates and filter on screen. It has a row per shift
  (status and difference), totals (shifts, awaiting a manager, need a look), and Prepared by / Reviewed by lines.
- **Notes keep their line breaks** on every printed document (`printDocument`: `white-space: pre-line`).

## Files
| Area | Files |
|---|---|
| Dashboard | `src/pages/ShiftReportsPage.tsx` (Print report ×2, no page print), `src/lib/documentSpecs.ts` (`shiftDocSpec`, `shiftListDocSpec`), `src/lib/printDocument.ts` (note line breaks) |
| Tests | `tests/shift-confirm.test.mjs` (22 → 23: the report, never the page) |
| Docs | `docs/AUDIT-REGISTER.md`, `docs/checklists/VERIFY-CHECKLIST-v0.6.23.html` + `.md` (F8), this file |

## Verification (bench)
The real `shiftDocSpec` + `printDocument`, bundled and rendered in Chromium to an A4 PDF and screenshot (a confirmed shift
short 100; a three-shift list). Every tests/*.test.mjs and the print/document tests (print-documents 8, document-specs 5,
document-styling 5) · every static gate · dashboard typecheck and build. Not verified here: a real printer.

## Rollout (owner)
Apply, commit, push; CI green; deploy the **dashboard**. Checklist v0.6.23 F8.
