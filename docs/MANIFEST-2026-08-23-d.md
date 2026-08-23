# MANIFEST — 2026-08-23-d

**Batch:** A144 (partial) — wire the live inventory/stock write-actions that had no UI caller.
**Cumulative:** follows -a (register), -b (A143), -c (A140) in the same session. Apply -a → -b → -c → -d.

**Base commit:** `f80f0e9` (`dev` tip). This patch applies on top of -a + -b + -c.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/inventory/InventoryPage.tsx` | Reorder threshold is now click-to-edit (inline input; Enter/blur save, Esc cancel) → `PATCH /api/inventory/:product_id/threshold` for the active branch. Added `useRef` import + four bits of edit state. | A144(1) — threshold was displayed but not settable. |
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | Added per-row status actions ("Mark in transit" / "Mark received" / "Cancel") → `PATCH /api/stock/transfers/:id/status`, driven by the server state machine; handles both 409s (invalid transition; self-receipt separation-of-duty, with a confirm to resend `allow_same_user`). | A144(2) — transfers could be listed/created but not advanced. |
| `docs/AUDIT-REGISTER.md` | `PROGRESS 2026-08-23` note on A144. Stays **OPEN**; counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-d.md` | New (this file). | Rule 2. |

## Scope / deliberately not done (rule 17)

- The third endpoint in A144, `PUT /api/branches/:id/stock/:productId`, was investigated and **not wired**: it upserts `stock_levels.quantity` and writes a `stock_movements` row — a second writer overlapping the already-wired `POST /api/inventory/adjust` (the Adjust modal). Surfacing it would create two paths mutating the same stock. Recommendation recorded in the register: retire it or leave it unused. No UI added.
- No permission-gating added to the transfer buttons (the existing "create transfer" control isn't client-gated either; the server enforces `inventory.transfer` and returns 403, surfaced inline).
- No server change → **no prod-migrate**, no deploy-order concern.

## Evidence / verification (rule 7, 9)

- `cd apps/dashboard && npx tsc --noEmit` → exit 0.
- `cd apps/dashboard && npx vite build` → exit 0.
- `node scripts/check-register-consistency.mjs` → green (A144 still OPEN).
- Environment: Linux bench, Node, dashboard Vite build. **NOT browser-verified (rule 16):**
  - threshold: edit a value, confirm it persists and the row's low-stock status reclassifies;
  - transfers: run `pending → in_transit → received` across two users, confirm stock leaves source on despatch and lands at destination on receipt, and that a despatcher self-receiving hits the block;
  - the retire-or-keep decision on the branch-stock PUT.

## Rollback

```
git apply -R A144-inventory-stock-actions.patch
```
