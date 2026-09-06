# MANIFEST 2026-09-05-r — A231 printable Z report

**Base:** `origin/dev` @ `7d28c2b`. **Delivery:** zip, extract over root. Dashboard-only, no migration, no server change.

## What this does
The manager Reports → Shifts tab gets a **Print Z** button per shift. It builds a **Z REPORT** via the
shared print engine: cashier/branch/times, orders + sales + opening float + paid in/out, and an
Expected / Counted / Variance totals block with signatures. Reads the real server fields
(`order_revenue`, `cash_variance`). Also fixes the Shifts tab, which was rendering the mis-typed
`variance` / `total_revenue` (blank) — now shows real revenue/variance.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerReportsPage.tsx` | Z report (`printZReport` + Print Z button); ShiftRow real fields; display fix | restore from `7d28c2b` |
| `tests/z-report.test.mjs` | NEW — source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A231 entry; counts P2 18→19 | restore from `7d28c2b` |
| `docs/MANIFEST-2026-09-05-r.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/z-report.test.mjs   5/5  (mutations: change docType → red · revert to mis-typed revenue → red)
apps/dashboard  npx tsc --noEmit  exit 0
register · doc-refs · parity · catalogue   exit 0
```
Could NOT verify here: the rendered Z report (browser). Follow-up: tender-by-method split needs a payments query.

## Apply
1. Extract over root; run gates. 2. `git add` the 4 files; commit; push. 3. Deploy dashboard.
