# MANIFEST 2026-09-05-m — A225 reprint history (PO / GRN / transfer)

**Base:** `origin/dev` @ `7a6defc`. **Delivery:** zip, extract over root. Dashboard-only, no migration, no server change.

## What this does
Documents are re-printable after creation, from where they live:
- **Transfers** — a Print button on every row in the owner Transfers page (despatch note, or a received
  note with Sent/Received/variance once received).
- **GRNs** — selecting a PO fetches its goods received notes and lists them with a Reprint button.
- **PO** — already reprintable via Print PO (A223).

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | `printTransferDoc` + Print button per row | restore from `7a6defc` |
| `apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx` | fetch selected PO's GRNs; `printStoredGRN`; GRN reprint list | restore from `7a6defc` |
| `tests/reprint-history.test.mjs` | NEW — source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A225 entry; counts P3 8→9 | restore from `7a6defc` |
| `docs/MANIFEST-2026-09-05-m.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/reprint-history.test.mjs             all green (5 passed)
  mutation (break GRN fetch)               FAIL → restored
  mutation (drop stopPropagation on Print) FAIL → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
```
Could NOT verify here: the rendered reprints (browser).

## Apply
1. Extract over root; run gates. 2. `git add` the 5 files; commit; push. 3. Deploy dashboard.

## Still open (design pending)
- Document status colour/accent styling — owner deciding (top-bar vs corner strip; palette).
- Company logo in the header; stock-take count sheet.
