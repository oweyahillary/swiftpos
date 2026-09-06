# MANIFEST 2026-09-05-i — A223 printable documents (PO / GRN / transfer)

**Base:** `origin/dev` @ `5f4ab57`. **Delivery:** zip, extract over root. Standalone. No migration.

## What this does
Adds printable A4 documents. New engine `lib/printDocument.ts` (business header, doc title/number/date,
meta grid, line table, totals, note, signature lines; print window; user text HTML-escaped). Wired to:
- **PO** — "Print PO" on the owner Purchase Orders detail.
- **GRN** — "Confirm & Print GRN" in the receive modal (prints the created GRN).
- **Transfer** — "Print note" (despatch note) on outgoing transfers in the manager tab.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/lib/printDocument.ts` | NEW — generic A4 print engine | delete file |
| `apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx` | Print PO; Confirm & Print GRN | restore from `5f4ab57` |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | Print note on outgoing transfers | restore from `5f4ab57` |
| `tests/print-documents.test.mjs` | NEW — source guards (7/7, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A223 entry; counts P3 9→10 | restore from `5f4ab57` |
| `docs/MANIFEST-2026-09-05-i.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/print-documents.test.mjs             all green (7 passed)
  mutation (drop HTML escaping)            FAIL → restored
  mutation (break GRN print wiring)        FAIL → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
```
Could NOT verify here: the actual print output in a browser (popup opens, layout, print dialog).

## Apply
1. Extract over root; run gates. 2. `git add` the 6 files; commit; push. 3. Deploy dashboard (no migration).

## Follow-ups (not built)
- GRN history / reprint list; transfer "received note" variant (sent vs received); logo in the header.
