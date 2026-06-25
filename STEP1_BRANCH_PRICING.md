# SwiftPOS — Step 1: Per-Branch Pricing (apply & test)

Implements step 1 of `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md`: prices become
per-branch, resolved as **effective price = `branch_prices.price` ?? `products.base_price`**.
Backwards-compatible — until a branch price is set, every product keeps its
`base_price`, so nothing changes for current data.

---

## 1. What changed

| File | Change |
|------|--------|
| `migrations/20_branch_prices.sql` | **New.** `branch_prices` table keyed `(branch_id, product_id)`, with `price`, `updated_at`, `updated_by` (`cloud`/`pc`), `version`. No rows created → no behaviour change until prices are set. |
| `apps/server/src/routes/pos.ts` | `/api/pos/init` now accepts `?branch_id=`, resolves that branch (tenant-checked, falls back to main branch), and returns `branch_price` (nullable) per product. |
| `apps/server/src/routes/orders.ts` | `recomputeOrderTotals` is now **branch-aware**: the authoritative anti-tampering recompute resolves the SAME branch price the till charged instead of always `base_price`. Both call sites (checkout + open-tab) pass `branch_id`. |
| `apps/desktop/src/main/localDb.ts` | Local `products` gains a nullable `branch_price` column (additive migration). |
| `apps/desktop/src/main/syncEngine.ts` | Pull sends the bound `branch_id` to `/api/pos/init`; stores `branch_price` on upsert. |
| `apps/desktop/src/main/ipcHandlers.ts`, `managerReports.ts` | Fuel price-per-litre reads resolve `COALESCE(branch_price, base_price)` for consistency. |
| `apps/desktop/src/renderer/lib/cart.ts` | New `effectivePrice(product)` helper (`branch_price ?? base_price`); `computeUnitPrice` uses it. |
| `apps/desktop/src/renderer/pages/POSPage.tsx` | Cart add + grid price display use `effectivePrice`. |

**Design intent preserved:** the server still never trusts client prices — it
recomputes authoritatively. Per-branch pricing only changes *which* price is
authoritative (the branch's), not the trust model.

---

## 2. Apply

### 2a. Migration (Supabase SQL editor)
Run `migrations/20_branch_prices.sql`. Additive and idempotent (`IF NOT EXISTS`).

### 2b. Code
Extract at the repo root (overlays the correct paths), then commit & push:
```bash
cd /c/swiftpos/pos
unzip -o /path/to/step1-branch-pricing.zip -d .
git add -A && git commit -m "Step 1: per-branch pricing (branch_prices + effective-price resolution)" && git push origin main
```
Render (server) redeploys on push. Rebuild the desktop app on the Windows
machine (`npm run build` in `apps/desktop`) so the new local column + pull land.

> No management UI yet (that's step 2). For now, set a branch price directly:
> ```sql
> INSERT INTO branch_prices (business_id, branch_id, product_id, price, updated_by)
> VALUES ('<biz>', '<branch>', '<product>', 80.00, 'cloud');
> ```

---

## 3. Test

### 3a. Default still applies (no regression)
- A product with **no** `branch_prices` row sells at its `base_price` on the
  till, and the cloud order total matches. (Confirms backward compatibility.)

### 3b. Branch price overrides
1. Insert a `branch_prices` row for an item on the till's bound branch (SQL above).
2. On the till, trigger a sync (tech screen → Force sync, or wait a cycle).
3. The product grid shows the **branch price**; ring it up — cart uses it.
4. Pay, let it sync. In the cloud, the order line total reflects the **branch
   price**, not `base_price` (proves the server recompute is branch-aware).

### 3c. Two branches, two prices
- Set a different `branch_prices.price` for the same product on branch A vs
  branch B. A till bound to A shows A's price; a till bound to B shows B's.
  (Each till sends its bound `branch_id` to `/api/pos/init`.)

### 3d. Tamper check still holds
- Have a client send an order with a doctored price — server still overrides it
  with the authoritative branch/base price. (Per-branch pricing didn't weaken
  anti-tampering.)

---

## 4. Notes / boundaries

- **Fuel:** per-litre pricing now also resolves `branch_price` if a row exists
  for the fuel product; otherwise unchanged (`base_price`/pump price).
- **Variants/modifiers** are unchanged — their adjustments add on top of the
  resolved effective base price, exactly as before.
- **Device storage:** a till is bound to one branch, so it stores that branch's
  `branch_price` only. The default `base_price` is retained for reference and
  for the management UI (step 2).
- **Next (step 2):** the manager-PC UI to *edit* branch prices locally; then the
  two-way sync + newest-wins + collision notification (step 6 of this spec).
