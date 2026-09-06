# MANIFEST 2026-09-05-k — A224 surface transfer received qty + note; close A215/218/219/220/221

**Base:** `origin/dev` @ `6722d62`. **Delivery:** zip, extract over root. Standalone. No migration.

## What this does
- **A224 (built):** the received quantity and receipt note (stored by A221) are now visible. `GET
  /transfers` returns `quantity_received`; the owner Transfers page shows **Sent vs Received** per line
  (short receipts in amber) and the **Receipt note** (distinct from the despatch note).
- **Register closes (browser pass 2026-09-05):** A215, A218, A219, A220, A221 → CLOSED with evidence.
  Counts: P1 17→16, P2 20→18 (−A218/A220/A221 +A224), P3 10→9 (−A219).

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/server/src/routes/stock.ts` | `GET /transfers` select adds `quantity_received` | restore from `6722d62` |
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | Sent vs Received column; receipt note shown | restore from `6722d62` |
| `tests/transfer-received-visibility.test.mjs` | NEW — source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A224 entry; A215/218/219/220/221 → CLOSED (+evidence); counts | restore from `6722d62` |
| `docs/MANIFEST-2026-09-05-k.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/transfer-received-visibility.test.mjs   all green (5 passed)
  mutation (drop quantity_received select)     FAIL → restored
  mutation (drop Received column)              FAIL → restored
apps/dashboard  npx tsc --noEmit              exit 0
check-permission-parity · register · doc-refs   exit 0
```
Server full tsc not runnable in sandbox (no server node_modules) — one-word select change, low risk.
Could NOT verify here: the rendered Sent/Received + note on the owner page (browser).

## Still needing a browser check (not in the closed set)
- **A222** (POS "← Manager portal" button) — wasn't in the results table; quick check: Open POS → button returns to /manager.
- **A223** (printable PO/GRN/transfer docs + received note) — verify the documents render/print.

## Apply
1. Extract over root; run gates. 2. `git add` the 5 files; commit; push. 3. Deploy server + dashboard (no migration).
