# MANIFEST — 2026-08-25 batch -h — A165 slice 1 (sparse product upsert)

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-g.md** (cumulative, rule 3).
**Register:** A165 · P2 · OPEN. **Deploy target:** the CLOUD SERVER. No migration.

First slice of the single-upload menu importer: the server now updates **only the columns you
uploaded**, matched by name (or a stable code), instead of rebuilding the whole product row.

## What changed

`POST /api/products/bulk` was a full-row overwrite — it required `price` on every upload and wiped
any column the file left out. It's now **sparse**: a missing column leaves that field alone, a blank
cell leaves it alone, the literal `DELETE` clears it, and `price` is required only when creating a
new item. It matches an existing product by **barcode → plu_code → name** (so an item with a code
can be renamed without creating a duplicate), and it auto-creates any category the file names.

## Files this batch (-h adds 2, edits 1)

| File | Change |
|------|--------|
| `apps/server/src/lib/productImport.ts` | **NEW pure.** `buildProductPatch` (sparse patch + validation + DELETE) and `rowMatchKeys` (barcode→plu→name). |
| `apps/server/src/routes/products.ts` | `/bulk` rewired to the sparse builder + multi-key match + category auto-create. |
| `tests/product-import.test.mjs` | **NEW.** 24 asserts, mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A165 entry; header Open A-P2 16→17; A165 in Counts. |

Cumulative zip also carries the rest of the day (A24/A19/A20 desktop, A164 device-grant, A159 audit)
and MANIFEST -a…-h.

## Backward compatibility

The existing single-tab CSV import still works identically — it sends every column, so every field
is patched exactly as before. The only behaviour changes: a missing column no longer wipes; plu_code
matching and category auto-create are new; and `is_fuel` is no longer set from the import (restaurant
scope — new products default non-fuel, existing ones are untouched).

## Verified on the bench (real server tsc — rule 9)

```
apps/server $ npx tsc --noEmit                → clean
$ node tests/product-import.test.mjs          → 24 passed, 0 failed
   mutation-checks: break sparse-omit → 2 named FAILs; drop price-required-on-create → 1 named FAIL
gates: api-routes, sql-binds, supabase-catch, table-usage, schema-drift, test-registration,
       register-consistency → OK
```

## Still to build (next slices)

- **Slice 2 (server):** import endpoints for the **Upgrades & Spices** (variant + modifier
  groups/options), **Recipe** (recipes rows) and **Ingredients** tabs — name-keyed + sparse,
  each mutation-checked. Choice group upload replaces its own options; recipe/ingredient lines
  matched by name; `DELETE` removes a line.
- **Slice 3 (desktop):** a multi-tab Excel reader that routes each tab to its endpoint, and ships
  `swiftpos-restaurant-import-template.xlsx` behind the "Download template" button.

## NOT verified here — target-only (rule 16)

The endpoint end-to-end against a real database; behaviour on real uploaded files; the desktop reader.

## Rollback (this batch)

```
rm apps/server/src/lib/productImport.ts tests/product-import.test.mjs docs/MANIFEST-2026-08-25-h.md
git checkout 189e597 -- apps/server/src/routes/products.ts
# register is shared — revert only the A165 lines, or roll the whole day back.
```
