# MANIFEST 2026-09-07-v — Staff "Unknown" via shift attribution + Avg fix (A259b) + report selector (A263)

**Base:** origin/dev @ 6e38865 (fresh pull; all prior work confirmed green). Web + server. No migration.

## Fixes
- **A259b** — Staff report still showed "Unknown" because those orders' `cashier_id` doesn't
  resolve to a `users` row. Now attributes through the order's SHIFT:
  `cashierOf = order.cashier_id ?? shift.cashier_id` (shifts.cashier_id is NOT NULL), so a
  shift's sales land on whoever opened it (Eugene's active shift → Eugene). Also fixed
  **Avg Order 0.00** — response now returns `avg_order_value = revenue / orders`.
  Caveat: an order with neither a cashier nor a shift still shows Unknown.
- **A263** — report period selector: removed the redundant **Apply** button (it already
  auto-applies, debounced; a subtle "Updating…" shows while it runs), fixed the preset
  double-highlight via an explicit `active` state (exactly one highlights; cleared when the
  dates are hand-edited), and made **Today** the default range on every tab.

## Files
| File | Change | ID |
|---|---|---|
| `apps/server/src/routes/reports.ts` | shift-based cashier attribution + `avg_order_value` | A259b |
| `apps/dashboard/src/pages/manager/ManagerReportsPage.tsx` | active-preset state, no Apply, Today default | A263 |
| `tests/ui-reports-fixes.test.mjs` | +2 guards (7) | A259b/A263 |
| `docs/AUDIT-REGISTER.md` | A259b note + A263 entry | — |
| `docs/MANIFEST-2026-09-07-v.md` | this manifest | — |

## What ran + output (rule 7)
```
tests/ui-reports-fixes.test.mjs -> 7/7 green
esbuild transpile (reports.ts, ManagerReportsPage) -> clean
register/doc/root gates -> green
```
NOT verified here (rule 16): the live Staff report attribution + the rendered selector.

## Apply
1. Extract over repo root.
2. `node --test tests/ui-reports-fixes.test.mjs` -> 7 green; gates.
3. Deploy server + dashboard. Check: Reports → Staff shows Eugene (not Unknown) with a real
   Avg Order; the period toggle shows one active preset, defaults to Today, and applies with no
   Apply button.
