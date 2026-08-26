# MANIFEST — 2026-08-25 batch -m — A165 slice 3 (unified "Menu upload" on the dashboard)

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-l.md** (cumulative, rule 3).
**Register:** A165 · P2 · OPEN. **Deploy target:** DASHBOARD (web). Adds a dependency (SheetJS). No migration.

One upload for the whole menu — on the dashboard, where products/ingredients/recipes already live
(the till stays sales-only). Completes the A165 importer: slices 1–2 were the sparse server endpoints;
this is the single multi-tab UI over them.

## What's new

- **`MenuUpload.tsx`** — one `.xlsx` in: reads the four tabs (Products · Upgrades & Spices · Recipe ·
  Ingredients) with SheetJS, shows a per-tab preview (row counts + missing-required-field errors),
  then applies in dependency order **Ingredients → Products → Upgrades → Recipe** so a recipe row can
  resolve the ingredient/product names the earlier tabs just created. Per-tab results after apply.
- **"↓ Template"** generates `swiftpos-restaurant-import-template.xlsx` client-side (no static asset,
  always in sync with the columns).
- Ingredients carry per-branch opening stock, so a specific branch must be selected — blocked with a
  message otherwise (mirrors the existing ingredient-import gate).
- The Products page's old "Import CSV" button is **replaced** by "Menu upload" (the one-place decision).

## Files this batch (-m adds 1, edits 2)

| File | Change |
|------|--------|
| `apps/dashboard/src/pages/products/MenuUpload.tsx` | **NEW.** Template gen, parse, preview, ordered apply. |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Swap "Import CSV" → "Menu upload"; render the new modal. |
| `apps/dashboard/package.json` | Add `xlsx` (SheetJS) dependency. |
| `docs/AUDIT-REGISTER.md` | A165 slice-3 note. No count change. |

Reuses the slice-1/2 endpoints unchanged (`/api/stock/ingredients/bulk`, `/api/products/bulk`,
`/api/variants/bulk`, `/api/recipes/bulk`) — **no server change this batch.**

## Verified on the bench (rule 9)

```
apps/dashboard $ npm install   (adds xlsx@0.18.5)
apps/dashboard $ npx tsc --noEmit   → 0 errors (new component + SheetJS type-check)
apps/server    $ npx tsc --noEmit   → clean (unchanged)
gates: package, client-parity, api-routes, register-consistency, doc-refs → OK
```

**Note:** run `npm install` in `apps/dashboard` after applying — `package.json` gained `xlsx`, and the
lockfile is not shipped (rule 22).

## Preview scope (honest)

The preview is **client-side and structural** — it shows what's in the file and missing-required-field
errors, not a server diff of create-vs-update counts. A true diff preview needs dry-run modes on the
import endpoints (a later enhancement). The server still validates every row and returns per-row
errors on apply.

## NOT verified here — target-only (rule 16)

The whole round trip on a running dashboard against a real database — parse → preview → apply →
per-row results — with a real multi-tab file.

## Rollback (this batch)

```
git checkout 189e597 -- apps/dashboard/src/pages/products/ProductsPage.tsx apps/dashboard/package.json
rm apps/dashboard/src/pages/products/MenuUpload.tsx docs/MANIFEST-2026-08-25-m.md
npm install   # in apps/dashboard, to drop xlsx from the lockfile
```
Note: ProductsPage also carries A166 (-j/-k/-l); a full checkout reverts those too — revert by hand to keep them.
