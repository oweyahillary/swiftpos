# MANIFEST 2026-09-05-e — A221 transfer received-quantity

**Base:** `origin/dev` @ `242bc0f`. **Delivery:** zip, extract over repo root. Standalone. No renames/deletes.

## What this does (A221 — owner decisions applied)
A transfer receipt now books what ACTUALLY arrived, not the sent quantity. The recipient keys a received
quantity per line (default = sent, capped at sent); the sent figure stays untouched as the despatch
record so sent-vs-received is the audit trail; a receipt note explains any discrepancy. Shortfall =
variance recorded (not a separate write-off). GRN/supplier deliveries already did this — unchanged.

## Files
| File | Change | Rollback |
|---|---|---|
| `migrations/101_transfer_received_quantity.sql` | NEW — `quantity_received` + `receipt_note` cols | delete; run its ROLLBACK block on any DB it hit |
| `scripts/test-migration-101.mjs` | NEW — PGlite proof (8/8, mutation-checked) | delete file |
| `apps/server/src/routes/stock.ts` | transfer `/status → received` books received, validates 0..sent, persists received + note | restore from `242bc0f` |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | transfer receive = per-line qty form + note; removed dead `busyId` | restore from `242bc0f` |
| `tests/transfer-received-qty.test.mjs` | NEW — server + UI source guards (8/8, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A221 → FIX BUILT (+ note) | restore from `242bc0f` |
| `docs/MANIFEST-2026-09-05-e.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
scripts/test-migration-101.mjs             all green (8 passed)   [PGlite]
  mutation (drop quantity_received add)    exit 1 (SQL invalid) → restored
tests/transfer-received-qty.test.mjs       all green (8 passed)
  mutation server (book sent lines)        FAIL → restored
  mutation server (drop 0..sent guard)     FAIL → restored
  mutation UI (drop received_items)        FAIL → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity                    exit 0   check-register-consistency 0   check-doc-refs 0
run-migration-tests                        exit 0 (incl. 99 + 100 + 101)
```

## Could NOT verify here
- Server full `tsc` (no server node_modules in sandbox) — change mirrors the existing handler style; run pinned CI tsc.
- Apply migration 101; browser-confirm a short receipt books the entered amount + shows the note.

## Apply
1. Extract over root; run the gates above.
2. `git add` the 7 files; commit; push.
3. `MIGRATE_ENV=<env> DATABASE_URL=... npm run db:migrate` → applies 101.
4. Deploy server + dashboard.

## Still open / next
- **A218** — manager-initiated transfers (from their own branch only). Decisions locked (source = own
  branch; edit quantities). Confirmed buildable: `GET /api/branches` returns all business branches for
  the destination picker; relax `POST /transfers` to source-access + destination-in-business; add a
  create-transfer form. Next batch.
