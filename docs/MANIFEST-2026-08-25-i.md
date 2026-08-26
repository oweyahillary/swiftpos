# MANIFEST — 2026-08-25 batch -i — A165 slice 2 (choices + recipe import endpoints)

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-h.md** (cumulative, rule 3).
**Register:** A165 · P2 · OPEN. **Deploy target:** CLOUD SERVER. No migration.

Slice 2 of the single-upload importer: the server can now take the **Upgrades & Spices** and
**Recipe** tabs. The Ingredients tab reuses the existing `POST /api/stock/ingredients/bulk` (A141),
so no new endpoint there.

## What changed

- **`POST /api/variants/bulk`** — imports the Upgrades & Spices tab. Name-keyed by product; each
  (product, group) upserts the variant group and REPLACES its options wholesale, sets `kind`
  (free→choice, upgrade→upgrade), and flips the product's `has_variants` so the till pulls it.
  `option = DELETE` removes the group.
- **`POST /api/recipes/bulk`** — imports the Recipe tab. A product in the file has its recipe
  replaced (product matched by name/plu, ingredient by name); one unknown ingredient fails that
  product cleanly rather than saving a half-right recipe.
- Two pure builders in `productImport.ts` carry the rules:
  - `buildChoiceImport` — a FREE choice may carry **no** price; an UPGRADE must have a **0 baseline**
    (or it charges every customer the cheapest step). Both enforced.
  - `buildRecipeImport` — grouped per product, positive quantity required, `DELETE` drops a line.

## Files this batch (-i adds 1, edits 3)

| File | Change |
|------|--------|
| `apps/server/src/lib/productImport.ts` | + `buildChoiceImport`, `buildRecipeImport` (pure). |
| `apps/server/src/routes/variants.ts` | + `POST /bulk`. |
| `apps/server/src/routes/recipes.ts` | + `POST /bulk`. |
| `tests/menu-import.test.mjs` | **NEW.** 18 asserts, mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A165 batch -i note. No count change (A165 already P2). |

Cumulative zip also carries the whole day (A24/A19/A20, A164, A159, A165 slice 1) and MANIFEST -a…-i.

## Verified on the bench (real server tsc — rule 9)

```
apps/server $ npx tsc --noEmit          → clean
$ node tests/menu-import.test.mjs        → 18 passed, 0 failed
   mutation-checks: allow price on a free choice → 1 named FAIL; drop upgrade baseline-0 → 1 named FAIL
$ node tests/product-import.test.mjs     → 24 passed, 0 failed
gates: api-routes, sql-binds, supabase-catch, table-usage, schema-drift, test-registration,
       register-consistency → OK
```

## Still to build — slice 3 (desktop)

The multi-tab Excel reader that routes each tab to its endpoint IN ORDER — Ingredients → stock bulk,
Products → products bulk, Upgrades → variants bulk, Recipe → recipes bulk (so ingredient/product
names exist before the tabs that reference them) — and ships
`swiftpos-restaurant-import-template.xlsx` behind the "Download template" button.

## NOT verified here — target-only (rule 16)

All four endpoints end-to-end against a real database; behaviour on real uploaded files; the desktop
reader on hardware.

## Rollback (this batch)

```
rm tests/menu-import.test.mjs docs/MANIFEST-2026-08-25-i.md
git checkout 189e597 -- apps/server/src/routes/variants.ts apps/server/src/routes/recipes.ts
# productImport.ts + register are shared — revert only the slice-2 additions, or roll the day back.
```
