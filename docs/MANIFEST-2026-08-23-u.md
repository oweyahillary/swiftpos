# MANIFEST — 2026-08-23-u

**Batch:** A141 — bulk ingredient CSV import with opening stock. **Touches the stock path; build-green, LIVE STOCK CHECK required.**
**Cumulative:** follows -a…-t. Apply after -t.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-t.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/server/src/routes/stock.ts` | New `POST /api/stock/ingredients/bulk` (gated `ingredients.manage`, ≤500 rows). Widened `applyIngredientStockIn`'s `createdBy` to `string \| null` (owners have no `users` row). | A141 — the bulk endpoint (ingredient master + opening stock). |
| `apps/dashboard/src/pages/stock/BulkIngredientImport.tsx` | New. CSV parse/validate/preview/POST, mirrors `BulkProductImport`; template `name,category,unit,unit_cost,reorder_level,opening_stock,notes,is_packaging`. | The importer UI. |
| `apps/dashboard/src/pages/stock/IngredientsPage.tsx` | "Import CSV" button + modal hosting `BulkIngredientImport`; gated on a specific branch being selected (opening stock is per-branch). | Surface the importer. |
| `docs/AUDIT-REGISTER.md` | A141 `SHIPPED` note. Stays **OPEN P2** pending browser + a live stock check; counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-u.md` | New (this file). | Rule 2. |

## Design / safety notes

- **Mirrors `/api/products/bulk`:** re-import UPDATES by lower-cased name (first wins), never duplicates.
- **Opening stock** is seeded through the existing `applyIngredientStockIn` helper — same `adjust_ingredient_stock` RPC + `ingredient_stock_movements` with `movement_type='opening'` a manual adjustment uses — so bulk-seeded and hand-entered stock are attributed identically (created_by null for owners, matching the inventory-movement pattern).
- **Opening stock is applied ONLY to ingredients the import CREATES** — a re-import to fix a name/cost can't double-add stock. `reorder_level` is an idempotent per-branch upsert (safe on create or update).
- **`branch_id` required + scope-checked** (`assertBranchAccess`) because opening stock and reorder levels are per-branch; the UI gates the button on a specific branch being selected, matching the adjust flow.

## Verification (rule 7, 8, 9)

- `apps/server` `tsc --noEmit` → 0; `npm run build` → 0.
- `apps/dashboard` `tsc --noEmit` → 0; `vite build` → 0.
- `check-permission-parity` → green; `check-table-usage` → green; `check-register-consistency` → green.
- Environment: Linux bench. **NOT run against a live DB** — the `adjust_ingredient_stock` RPC + stock write are exercised only at runtime (rule 16).

## REQUIRED live check before close

Import a small CSV (2–3 ingredients with opening_stock) against a selected branch → confirm the ingredients appear, `current_stock` reflects the opening quantity **in that branch**, and each shows an `'opening'` movement. Re-import the same file with a changed cost → confirm stock is **not** double-added.

## Rollback

```
git apply -R A141-bulk-ingredient-import.patch
```
