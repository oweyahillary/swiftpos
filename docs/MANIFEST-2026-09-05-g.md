# MANIFEST 2026-09-05-g — A218 stock picker + "min stays editable" decision

**Base:** `origin/dev` @ `440b81e` (A221 + A218 already merged). **Delivery:** zip, extract over root. Standalone.

## What this does
- **A218 stock picker (owner asked):** the manager's create-transfer picker now shows live per-branch
  stock. It sources `GET /api/inventory?branch_id=<own>` (the same endpoint the Inventory tab uses),
  displays "in stock: N" per product, caps each quantity input at what's on hand (disabled at 0), and
  rejects sending more than stock before the POST. Server despatch guard unchanged (backstop).
- **Decision recorded (no code):** the reorder "min" threshold stays MANAGER-editable — the manager sets
  their own reorder alert based on expected traffic. A215's gate already permits it; not tightened.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | picker uses `/api/inventory`; shows stock; caps qty; over-stock guard | restore from `440b81e` |
| `tests/manager-initiate-transfer.test.mjs` | +3 stock-picker guards (now 11/11) | restore from `440b81e` |
| `docs/AUDIT-REGISTER.md` | A218 "STOCK PICKER ADDED" note; A215 "min stays editable" decision | restore from `440b81e` |
| `docs/MANIFEST-2026-09-05-g.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/manager-initiate-transfer.test.mjs   all green (11 passed)
  mutation (picker → /api/products)        FAIL → restored
  mutation (drop over-stock guard)         FAIL → restored
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
```
Could NOT verify here: browser pass (picker shows correct stock; can't over-send).

## Apply
1. Extract over root; run gates.
2. `git add` the 4 files; commit; push. (No migration — UI + test + docs only.)
3. Deploy dashboard.
