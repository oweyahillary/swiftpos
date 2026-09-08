# MANIFEST 2026-09-07-x — A259c: attribute "Unknown" orders via the shift's time window

**Base:** origin/dev @ 4104fb7. **Server-only.** No migration.

## Why
Staff report still showed "Unknown" (the avg fix from A259b IS live — Avg Order now KES 4,533.33).
Those orders have **neither a cashier_id nor a shift_id** (rung offline/desktop; both resolved null
at create) and there is no cashier_name snapshot, so id- and shift_id-based lookups both miss.

## Fix
`/api/reports/staff` now resolves an unattributed order to the SHIFT whose **time window covers**
it: same branch, `opened_at <= order.created_at <= (closed_at || open)`. So orders rung during an
open shift attribute to that shift's cashier even when the row never recorded who. Precedence:
`order.cashier_id` → order's own `shift_id` → time-window shift → Unknown.

## Files
| File | Change |
|---|---|
| `apps/server/src/routes/reports.ts` | time-window shift attribution + `created_at` selected |
| `tests/ui-reports-fixes.test.mjs` | guard → `coveringCashier` |
| `docs/AUDIT-REGISTER.md` | A259c note |
| `docs/MANIFEST-2026-09-07-x.md` | this manifest |

## What ran (rule 7)
```
tests/ui-reports-fixes.test.mjs -> 7/7 ; esbuild transpile reports.ts -> clean ; gates -> green
```
NOT verified here (rule 16): the live Staff report.

## If it STILL shows Unknown after deploy — run this in the Supabase SQL editor and send me the output:
```sql
select o.order_number, o.created_at, o.cashier_id, o.shift_id, o.branch_id,
       u.name as cashier_user,
       s.id as shift, s.cashier_id as shift_cashier, s.opened_at, s.closed_at, s.status
from orders o
left join users  u on u.id = o.cashier_id
left join shifts s on s.id = o.shift_id
where o.created_at::date = current_date and o.status = 'completed'
order by o.created_at desc limit 10;
```
That shows whether cashier_id/shift_id are null and whether any shift's window actually covers the
order time — which tells us the exact remaining gap (no more guessing).

## Apply
Extract over repo root; `node --test tests/ui-reports-fixes.test.mjs` -> 7 green; gates; deploy server.
