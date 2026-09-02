# MANIFEST — 2026-08-25 batch -k — A166 row-level selection (bulk price)

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-j.md** (cumulative, rule 3).
**Register:** A166 · P2 · OPEN. **Deploy target:** DASHBOARD (web) only. No server change, no migration.

Extends the bulk price tool so you can tick individual products and change just those — not only a
whole category.

## What changed (dashboard only)

- Products table: a checkbox per row + a select-all over the filtered view.
- A selection bar appears when ≥1 row is ticked: **"N selected → Change price"** (and Clear).
- `BulkPriceEditor` now takes an optional `productIds` scope. With a selection it targets exactly
  those items (sends `ids`); with none it stays in category mode. Same preview→apply flow.
- **No server change** — `/api/products/bulk-price` already accepted `ids` from batch -j.

## Files this batch (-k edits 2)

| File | Change |
|------|--------|
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Row/select-all checkboxes, selection bar, pass `productIds` to the editor. |
| `apps/dashboard/src/pages/products/BulkPriceEditor.tsx` | Optional `productIds` scope (selection vs category). |
| `docs/AUDIT-REGISTER.md` | A166 -k note. No count change. |

## Verified on the bench (rule 9)

```
apps/dashboard $ npx tsc --noEmit   → 0 errors (deps installed; the new UI type-checks)
apps/server    $ npx tsc --noEmit   → clean (unchanged)
$ node tests/price-ops.test.mjs     → 21 passed, 0 failed (money math unchanged)
check-register-consistency          → OK
```

No new unit test: there's no new pure logic — row selection is UI state, and the ids code path plus
its money math were already covered in batch -j/`price-ops`.

## NOT verified here — target-only (rule 16)

Selection + apply on a running dashboard against a real database.

## Rollback (this batch)

```
git checkout 189e597 -- apps/dashboard/src/pages/products/ProductsPage.tsx
# BulkPriceEditor.tsx: revert the productIds prop, or restore the -j version.
rm docs/MANIFEST-2026-08-25-k.md
```
