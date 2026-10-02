# MANIFEST 2026-09-03-c — reports: A193 (standalone Refunds view) + A143 (exports hub + Inventory tab)

**Base commit:** `573df37` (`dev`) — which already carries the `-a`/`-b` work (A192/A195/A194,
merged). **This batch is NOT cumulative over `-a`/`-b`** (those are on `dev`); `-c` is A193 + A143
only, applied on top.
**Scope:** dashboard + one read-only server endpoint. No migration, no schema change. Both items
stay **OPEN pending a browser pass** (rule 16).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Files

| File | New? | Change | ID |
|---|---|---|---|
| `apps/server/src/routes/reports.ts` | edit | New `GET /api/reports/refunds` — mirrors `/voids`, filters on `refunded_at`, returns order/cashier/authorizer/reason/refunded-amount + per-cashier summary. Read-only. | A193 |
| `apps/dashboard/src/pages/ReportsPage.tsx` | edit | `RefundsTab` (sibling of Voids, amber); `InventoryTab` (renders existing `/api/reports/inventory`); `ExportsTab` download hub for all 8 export formats; 3 new `TAB_LIST` entries + switch wiring; `RefundsReport`/`InventoryReport` types. | A193, A143 |
| `tests/reports-refunds-and-exports.test.mjs` | new | 6 mutation-checked guard checks (refunds endpoint filter + audit fields; refunds/inventory/exports tabs; all 5 requested export formats). | A193, A143 |
| `docs/AUDIT-REGISTER.md` | edit | FIX-BUILT notes on A193 + A143 (rule 14). No count change — nothing closed. | — |

## Design decisions (for the owner)
- **A193 standalone**, per your call — a dedicated Refunds tab, not a section inside Voids &
  Exceptions. Refunds are dated by the **refund event** (`refunded_at`), so a refund of an old sale
  lands in the period it was refunded, not when the sale happened.
- **A143 exports as a hub.** `daily/audit/shifts/pnl/expenses` had no matching report tab to hang a
  button on, so a single **Exports** tab lists every format as a one-tap Excel download (also
  includes the already-wired sales/hourly/item-mix, so it's a complete download surface). The
  per-tab export buttons on Master/Hourly/Item-Mix are left in place.
- **Inventory tab** renders the existing endpoint (sold / restocked / written-off). No `/export/inventory`
  endpoint exists, so this tab is render-only (no download button) — flag if you want an xlsx export
  and I'll add the endpoint.

## Verification (rule 7)
Environment: Linux, Node 22 in-sandbox — on-target for the dashboard build; server type-checked.
- `apps/dashboard` `tsc --noEmit` → **exit 0, 0 errors**; `vite build` → **exit 0**.
- `apps/server` `tsc --noEmit` → **exit 0, 0 errors**.
- `tests/reports-refunds-and-exports.test.mjs` → **6/6**, mutation-checked (the `refunded_at` filter
  and a tab entry each go red when reverted; restored → green).
- Gates: `schema-audit.py` (0), `check-api-schema-drift` (OK + 11/11 self-test), `check-api-routes`
  (**289**, +2 for the new report reads), `check-doc-refs`, `check-register-consistency`,
  `check-test-registration`, `check-root-clean` → **all exit 0**.

**Could NOT verify here (rule 7/16):** live browser — the Refunds tab populating after a real
refund, each export downloading a non-empty xlsx, and the Inventory tab rendering. Owner browser pass.

## Rollback
```
git checkout 573df37 -- apps/server/src/routes/reports.ts apps/dashboard/src/pages/ReportsPage.tsx docs/AUDIT-REGISTER.md
rm tests/reports-refunds-and-exports.test.mjs docs/MANIFEST-2026-09-03-c.md
```
