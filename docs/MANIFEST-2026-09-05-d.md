# MANIFEST 2026-09-05-d — A215 authz + A220 products.view + A219 sidebar (+A218 filed)

**Base:** `origin/dev` @ `8f45470` (the -c batch A214/A216/A217 is already merged there).
**Delivery:** zip, extract over repo root. Standalone on origin/dev. No renames/deletes. No version bumps.

## What this does
- **A215 FIX BUILT** — gate the two ungated `inventory.ts` writes: `POST /adjust` → `inventory.adjust`
  (owner-only); `PATCH /threshold` → `inventory.adjust` OR `inventory.receive` (managers keep it).
- **A220 FIX BUILT** — `products.view` was gated by the manager Menu tab (A208) but registered nowhere
  (parity phantom; Menu tab silently invisible to managers). Migration 100 registers + grants it;
  parity green again.
- **A219 FIX BUILT** — sidebar now leads with the branch name, business/POS name as subtitle.
- **A218 OPEN (filed, not built)** — managers initiating transfers: server already permits it
  (`inventory.transfer`); gap is a create-transfer UI + a manager-scoped branches list (A214 root) +
  an owner decision on scope/approval.

## Files
| File | Change | Finding | Rollback |
|---|---|---|---|
| `apps/server/src/routes/inventory.ts` | import guards; gate `/adjust` and `/threshold` | A215 | restore from `8f45470` |
| `migrations/100_register_products_view.sql` | NEW — register + grant `products.view` | A220 | delete; run its ROLLBACK block on any DB it hit |
| `scripts/test-migration-100.mjs` | NEW — PGlite proof (10/10, mutation-checked) | A220 | delete file |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | sidebar branch-first (one 2-line swap on top of -c) | A219 | restore from `8f45470` |
| `tests/manager-batch-2026-09-05b.test.mjs` | NEW — source guards A215 + A219 | A215/A219 | delete file |
| `docs/AUDIT-REGISTER.md` | A215→FIX BUILT; A218/A219/A220 added; counts P2 20→22, P3 7→8 | — | restore from `8f45470` |
| `docs/MANIFEST-2026-09-05-d.md` | NEW — this manifest | — | delete file |

## What ran + output (rule 7)
```
scripts/test-migration-100.mjs             all green (10 passed)   [PGlite]
  mutation (neuter cashier grant)          FAIL (Cashier) → restored
tests/manager-batch-2026-09-05b.test.mjs   all green (5 passed)
  mutation A215 (drop /adjust gate)        FAIL (A215) → restored
  mutation A219 (revert sidebar swap)      FAIL (A219) → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity                    exit 0 (unregistered 0, ungated 2, phantom 0 — at baseline)
check-register-consistency                 exit 0 ("header agrees with the body")
check-doc-refs                             exit 0
run-migration-tests                        all pass (incl. 99 + 100)
```

## Could NOT verify here
- **Server full `tsc`** — sandbox lacks server node_modules + hits a pre-existing `tsconfig`
  `moduleResolution=node10` deprecation. A215 mirrors `stock.ts:336` exactly (type-correct by
  construction); run the pinned server tsc in CI.
- **Apply migration 100** on the DB + browser-confirm the Menu tab renders (A220 stays FIX BUILT).
- **API check for A215**: a manager gets 403 on `/adjust`; a cashier gets 403 on both.

## Apply steps
1. `git fetch origin && git rev-parse --short origin/dev` → expect `8f45470`.
2. Extract this zip over root; run the gates above.
3. `git add` the explicit file list; commit; push.
4. `MIGRATE_ENV=<env> DATABASE_URL=... npm run db:migrate` → applies migration 100.
5. Deploy dashboard (A219) + server (A215). Browser: Menu tab shows for a manager; `/adjust` refused for non-owner.

## Register also records (doc-only, same AUDIT-REGISTER.md)
- **A133 / A205 / A214 → CLOSED** (owner browser pass 2026-09-05). Counts P2 22→20.
- **A221 OPEN (filed)** — transfer receipt books the SENT qty, not the actual received qty (transfers-only; GRN already handles it). Needs a schema change + one shortfall decision.
