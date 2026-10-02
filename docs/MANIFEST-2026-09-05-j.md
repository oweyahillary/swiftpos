# MANIFEST 2026-09-05-j — A223 transfer received-note (sent vs received)

**Base:** `origin/dev` @ `6722d62`. **Delivery:** zip, extract over root. Standalone. No migration, no server change.

## What this does
Completes the transfer document story. The manager's transfer receive form now has **"Confirm & print"**
beside "Confirm received". On receipt it prints a **TRANSFER RECEIVED NOTE**: from/to, each line's
**Sent vs Received** with the **Variance**, the receipt note, and received-by/checked-by signatures —
A221's audit trail as a signed document. All data is client-side at receive time, so no server change.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | `printReceivedNote`; `submitTransfer(alsoPrint)`; "Confirm & print" button | restore from `6722d62` |
| `tests/print-documents.test.mjs` | +received-note guard (now 8/8) | restore from `6722d62` |
| `docs/AUDIT-REGISTER.md` | A223 "RECEIVED NOTE ADDED" note | restore from `6722d62` |
| `docs/MANIFEST-2026-09-05-j.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/print-documents.test.mjs             all green (8 passed)
  mutation (break received-note print)     FAIL → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
```
Could NOT verify here: the rendered note + print dialog (browser; allow pop-ups).

## Apply
1. Extract over root; run gates. 2. `git add` the 4 files; commit; push. 3. Deploy dashboard.
