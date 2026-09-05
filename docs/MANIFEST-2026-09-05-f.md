# MANIFEST 2026-09-05-f — A218 manager-initiated transfers

**Base:** `origin/dev` @ `242bc0f`. **This zip is CUMULATIVE** — it also carries the `-e` batch (A221),
because `-e` was not yet pushed when this was built. Applying this one zip delivers **A221 + A218**
together. If you have since pushed `-e`, say so and I'll rebase A218 alone.

## What A218 does (owner decision: from their OWN branch only; manager edits quantities)
A branch manager can now start a transfer from their own branch to another branch, instead of asking the
owner. Server enforces source = a branch they control; destination = any other branch in the business.
The manager creates it (pending), then despatches it (stock leaves); the destination manager receives it
via the A221 flow.

## Files (A218 delta on top of -e)
| File | Change | Rollback |
|---|---|---|
| `apps/server/src/routes/stock.ts` | `POST /transfers` guard: source-access + destination-in-business (was both-access) | restore from `242bc0f` |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | "Send stock" section: create form (locked source, dest picker, product qty) + outgoing list + Despatch | restore from `242bc0f` |
| `tests/manager-initiate-transfer.test.mjs` | NEW — server + UI source guards (8/8, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A218 → FIX BUILT (+ note) | restore from `242bc0f` |
| `docs/MANIFEST-2026-09-05-f.md` | NEW — this manifest | delete file |

## Also in this cumulative zip (the -e batch, A221)
`migrations/101_transfer_received_quantity.sql`, `scripts/test-migration-101.mjs`,
`docs/MANIFEST-2026-09-05-e.md`, `tests/transfer-received-qty.test.mjs`, and the A221 parts of
`stock.ts` / `ManagerReceivingTab.tsx` / `AUDIT-REGISTER.md`. See MANIFEST-2026-09-05-e.md.

## What ran + output (rule 7)
```
tests/manager-initiate-transfer.test.mjs   all green (8 passed)
  mutation server (re-add to-access guard) FAIL → restored
  mutation UI (swap source/dest)           FAIL → restored
tests/transfer-received-qty.test.mjs       all green (8 passed)   [A221]
scripts/test-migration-101.mjs             all green (8 passed)   [A221, PGlite]
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
run-migration-tests                        exit 0 (99 + 100 + 101)
```

## Could NOT verify here
- Server full `tsc` (no server node_modules) — guard mirrors existing `assertBranchAccess` usage; run CI tsc.
- Apply migration 101 (for A221); browser pass: manager creates a transfer → despatches → other branch receives.

## Apply
1. Extract over root; run the gates above.
2. `git add` the A221 files + the A218 files (full list below); commit; push.
3. `MIGRATE_ENV=<env> DATABASE_URL=... npm run db:migrate` → applies 101.
4. Deploy server + dashboard.

## Open follow-ups (not in this batch)
- A218 enhancement: show live per-branch stock in the transfer picker; optional owner-approval step.
- Optional: lock the reorder "min" field to owner-only (from the A205 note).
