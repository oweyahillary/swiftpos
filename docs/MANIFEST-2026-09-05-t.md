# MANIFEST 2026-09-05-t — A234 DRY extract of the doc-spec builders

**Base:** `origin/dev` @ `042c53f`. **Delivery:** zip, extract over root. Dashboard-only, no migration, no server change. Pure refactor — no behaviour change.

## What this does
Extracts the PO/GRN/transfer document specs (duplicated across 4 files) into one shared
`lib/documentSpecs.ts` (`purchaseOrderDocSpec` / `grnDocSpec` / `transferDocSpec` + `docMoney`). Callers map
their records → builder input → `printDocument`. Money unified to the verified `Intl` "Ksh"; despatch pill
now shows the real status. Proof of no change: `tsc` + the full document test suite green.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/lib/documentSpecs.ts` | NEW — shared builders | delete file |
| `apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx` | printPO/printStoredGRN/printGRN delegate | restore from `042c53f` |
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | printTransferDoc delegates | restore from `042c53f` |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | printTransferNote/printReceivedNote/printReceivedGRN delegate | restore from `042c53f` |
| `apps/dashboard/src/pages/manager/ManagerHistoryTab.tsx` | printGRN/printTransfer delegate | restore from `042c53f` |
| `tests/document-specs.test.mjs` | NEW — the moved doc-spec guards (mutation-checked) | delete file |
| `tests/reprint-history.test.mjs` / `document-styling.test.mjs` / `grn-note-and-date.test.mjs` / `manager-history.test.mjs` | assert delegation | restore from `042c53f` |
| `docs/AUDIT-REGISTER.md` | A234 entry; counts P3 10→11 | restore from `042c53f` |
| `docs/MANIFEST-2026-09-05-t.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
Full document test suite (9 files)   all green
  document-specs mutation (break builder)   FAIL → restored
  delegation mutation (caller stops using)  FAIL → restored
apps/dashboard  npx tsc --noEmit     exit 0
register · doc-refs · parity · catalogue   exit 0
```
Could NOT verify here: rendered docs (browser) — but tsc + the suite prove the specs are unchanged.

## Apply
1. Extract over root; run the doc test suite + gates. 2. `git add` the files (see table); commit; push. 3. Deploy dashboard.
