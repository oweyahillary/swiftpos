# MANIFEST 2026-09-05-q — A229 GRN receive note + A230 date fix; close A223/225/226/227/228

**Base:** `origin/dev` @ `0f38c00`. **Delivery:** zip, extract over root. Dashboard-only, no migration.

## What this does
- **A229 (built):** the manager GRN receive now has a **note field** (sent to `POST /grn`) and a
  **Confirm & print** button (green GRN via the shared engine) — parity with the owner GRN flow and the
  transfer receive. A short delivery can now record why.
- **A230 (built):** `fmtDate` handles full ISO timestamps and returns `—` for unparseable input — fixes
  the "Invalid Date" on the GRN reprint line (and the printed GRN date).
- **Closes (browser pass 2026-09-05):** A223, A225, A226, A227, A228 → CLOSED with evidence.
  Counts: P2 unchanged at 19 (−A228 +A229), P3 11→8 (−A223/225/226/227 +A230).

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | GRN receive: note field, notes→server, Confirm & print (A229) | restore from `0f38c00` |
| `apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx` | `fmtDate` robust to timestamps + invalid (A230) | restore from `0f38c00` |
| `tests/grn-note-and-date.test.mjs` | NEW — A229 + A230 source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A229/A230 entries; A223/225/226/227/228 → CLOSED; counts | restore from `0f38c00` |
| `docs/MANIFEST-2026-09-05-q.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/grn-note-and-date.test.mjs   5/5  (mutations: drop notes send → red · drop invalid-date guard → red)
apps/dashboard  npx tsc --noEmit   exit 0
register · doc-refs · parity · catalogue   exit 0
```
Could NOT verify here: browser (receive short with a note → GRN prints the note; reprint list shows a real date).

## Apply
1. Extract over root; run gates. 2. `git add` the 5 files; commit; push. 3. Deploy dashboard.
