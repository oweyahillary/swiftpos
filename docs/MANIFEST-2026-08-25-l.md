# MANIFEST — 2026-08-25 batch -l — A166 inline price edit

**Base commit:** `189e597`. **Supersedes MANIFEST-2026-08-25-k.md** (cumulative, rule 3).
**Register:** A166 · P2 · OPEN. **Deploy target:** DASHBOARD (web) only. No server change, no migration.

The one-off: click a price in the Products table and edit it in place — no modal, no file.

## What changed (dashboard only)

- Price cell → click-to-edit: click shows a number input, Enter or blur saves, Esc cancels.
- Optimistic — the row updates instantly and reverts if the save fails, with a small toast.
- Uses the existing partial `PATCH /api/products/:id` with `base_price` only; all other fields untouched.
- The bulk price tool (category / selected rows) stays for many-at-once; inline is for one.

## Files this batch (-l edits 1)

| File | Change |
|------|--------|
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | Inline-edit state + toast, `savePrice` (optimistic + revert), editable price cell. |
| `docs/AUDIT-REGISTER.md` | A166 -l note. No count change. |

## Verified on the bench (rule 9)

```
apps/dashboard $ npx tsc --noEmit   → 0 errors (deps installed; the edit path type-checks)
apps/server    $ npx tsc --noEmit   → clean (unchanged)
check-register-consistency          → OK
```

No new unit test: it's UI plus an endpoint that was already a partial patch — no new pure logic.

## NOT verified here — target-only (rule 16)

Click-edit-save against a running dashboard + real database (incl. the revert-on-error path).

## Rollback (this batch)

```
git checkout 189e597 -- apps/dashboard/src/pages/products/ProductsPage.tsx
rm docs/MANIFEST-2026-08-25-l.md
```
Note: ProductsPage also carries A166 -j/-k; a full checkout reverts those too — revert by hand to keep them.
