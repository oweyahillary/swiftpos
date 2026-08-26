# MANIFEST — 2026-08-25 batch -j — A166 (day-to-day bulk price tool)

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-i.md** (cumulative, rule 3).
**Register:** A166 · P2 · OPEN. **Deploy target:** CLOUD SERVER + DASHBOARD (web). No migration.

The weekly job — "all sodas +20", "drinks +10%", "round to nearest 10" — without a spreadsheet.
Complements the A165 importer (which stays for setup and big/structural changes).

## What's new

- **`POST /api/products/bulk-price`** — one endpoint, two modes. `dry_run:true` returns the exact
  old→new PREVIEW without writing; otherwise it applies. Both use the same `applyPriceOp`, so the
  preview you confirm is exactly what's written. Scoped by ids or a single category — never the whole
  catalogue by accident.
- **`priceOps.ts`** (pure) — set / add±/ percent± (discount capped at 100%) / round-to-nearest, money
  to 2dp, with a negative-result guard so a bulk op can never silently zero a price.
- **Dashboard "Bulk price"** (`BulkPriceEditor.tsx` + button on Products) — pick a category, pick the
  op, preview the table (errors in red), Apply. Single-price tweaks stay as inline product edits.

## Files this batch (-j adds 3, edits 2)

| File | Change |
|------|--------|
| `apps/server/src/lib/priceOps.ts` | **NEW pure.** `applyPriceOp` + `parsePriceOp`. |
| `apps/server/src/routes/products.ts` | **NEW** `POST /api/products/bulk-price` (preview + apply). |
| `tests/price-ops.test.mjs` | **NEW.** 21 asserts, mutation-checked. |
| `apps/dashboard/src/pages/products/BulkPriceEditor.tsx` | **NEW** modal: scope → op → preview → apply. |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Import, state, "Bulk price" button, modal render. |
| `docs/AUDIT-REGISTER.md` | A166 entry; header Open A-P2 17→18; A166 in Counts. |

Cumulative zip also carries the whole day (A24/A19/A20, A164, A159, A165 importer) + MANIFEST -a…-j.

## Verified on the bench (rule 9)

```
apps/server $ npx tsc --noEmit                → clean
$ node tests/price-ops.test.mjs               → 21 passed, 0 failed
   mutation-checks: percent /100→/10 → 4 named FAILs; drop negative guard → 2 named FAILs
apps/dashboard $ npx tsc --noEmit             → 0 errors (deps installed; the new UI type-checks)
gates: api-routes, sql-binds, supabase-catch, table-usage, schema-drift, test-registration,
       register-consistency → OK
```

## NOT verified here — target-only (rule 16)

The endpoint end-to-end against a real database; the editor on a running dashboard.

## Still open / next (owner's call)

- Row-level multi-select scope (today it's per-category).
- Tier-1 inline price edit + a fast availability/86 toggle. Note: 86-on-the-floor was flagged as a
  till action, not back-office — decide separately.

## Rollback (this batch)

```
rm apps/server/src/lib/priceOps.ts tests/price-ops.test.mjs \
   apps/dashboard/src/pages/products/BulkPriceEditor.tsx docs/MANIFEST-2026-08-25-j.md
git checkout 189e597 -- apps/server/src/routes/products.ts apps/dashboard/src/pages/products/ProductsPage.tsx
# register is shared — revert only the A166 lines, or roll the day back.
```
Note: `products.ts` also carries A165; a full `git checkout 189e597 -- products.ts` reverts both —
revert by hand if you want to keep A165.
