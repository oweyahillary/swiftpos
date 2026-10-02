# MANIFEST 2026-09-07-y — A259d: THE Staff "Unknown" fix (field-name mismatch)

**Base:** origin/dev @ 4104fb7. **Server-only.** No migration. Supersedes the guesswork in A259/b/c.

## Root cause (from the owner's SQL — the data was fine)
Those orders carry a valid `cashier_id` (Eugene) that resolves in `users`; the `/staff` server
response even built the name correctly — but into fields called **`name` / `cashier_id`**, while
the dashboard's `StaffRow` reads **`staff_name` / `staff_id`**. That field-name contract mismatch
was the entire "Unknown" (and `avg_order_value` already matched, which is why the avg fix showed
while the name didn't). The A259/b/c attribution work was defensive robustness, not the bug.

## Fix
`/api/reports/staff` now returns `{ staff_id, staff_name, orders, revenue, avg_order_value, voids }`
— the exact fields the frontend reads.

## Files
| File | Change |
|---|---|
| `apps/server/src/routes/reports.ts` | emit staff_id/staff_name (+ voids) to match StaffRow |
| `tests/ui-reports-fixes.test.mjs` | guard asserts staff_id/staff_name |
| `docs/AUDIT-REGISTER.md` | A259d note |
| `docs/MANIFEST-2026-09-07-y.md` | this manifest |

## What ran + output (rule 7)
```
trace with the owner's real data -> staff_name="Eugene", orders=3, revenue=13,600, avg=4,533.33
tests/ui-reports-fixes.test.mjs -> 7/7 ; esbuild transpile reports.ts -> clean ; gates -> green
```

## Apply
Extract over repo root; `node --test tests/ui-reports-fixes.test.mjs` -> 7 green; gates; deploy server.
After deploy the Staff report shows **Eugene** (not Unknown).
