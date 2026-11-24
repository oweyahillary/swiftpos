# A625 — Per-branch menu: an item can be on one branch's menu and not another's

Owner, 2026-11-23: "some items are sold in branch A but not in branch B … each branch can have its own menu item."
This is a SPEC for review (owner asleep when written) — not built yet. Pairs with the per-branch direction (A612/A624).
Target: **dev only** until the owner says prod-ready.

---

## 1. What exists today (and why it isn't enough)

Products are **one business-wide catalogue** (`products` belong to the business, not a branch). The only per-branch
controls today are:

- **Stock** is per branch (`stock_levels` by `branch_id`). With the A563 "Hide when out of stock" mode, an item at
  zero stock is hidden at that branch. So you *can* approximate "A sells it, B doesn't" by stocking it only at A —
  **but only for stock-tracked items**. A made-to-order dish (not stock-tracked) always shows, everywhere.
- **Menu hours** (A578, `menus.availability`) — items on/off by time of day, per branch.

**Missing:** a simple **"on this branch's menu / not"** switch per product, independent of stock and time. That is
what the owner is asking for.

## 2. Target: per-branch availability

Each product can be **available at all branches (default)** or **limited to some**. A branch's POS shows only the
products available there; everything else (ordering, the kitchen, reports) is unchanged.

### Data model (surgical, additive)
A small **exclusion** table — store only the exceptions, so the common "everywhere" case costs nothing:

```sql
CREATE TABLE public.product_branches_hidden (
  product_id  uuid NOT NULL REFERENCES public.products(id)  ON DELETE CASCADE,
  branch_id   uuid NOT NULL REFERENCES public.branches(id)  ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, branch_id)
);
```
No row ⇒ the product is on every branch's menu (today's behaviour — so existing data is unchanged, nothing to
backfill). A row ⇒ hidden at that branch. A product limited to one branch of four = three rows. RLS: the business's
members read its own; writes through the server. A change **bumps the catalogue sync version** (migration 150's
trigger, same as stock/premium) so every POS pulls it on the next check.

*(Alternative considered — a per-(product,branch) `available boolean` override, or an opt-in "available at" list.
Exclusion is the least data and keeps "everywhere" as the zero-cost default; the UI still reads as "available at…".)*

### Who it applies to (every business type)
Wording via `shared/businessTerms.ts`: "on the menu" for restaurants/cafés/bars, "in the catalogue / stocked" for
shops. Same mechanism.

## 3. Where it plugs in (minimal touch-points)
1. **The POS pull** (`/pos/init` + the sync pull / `register_products_view`): for branch X, drop the products hidden
   at X. This sits **next to** the existing stock-gate (A563) — an item is off X's menu if hidden *or* (hide-mode and
   out of stock). One extra filter, no change to the sale/kitchen path.
2. **The Menu editor** (dashboard): on each product, an **"Available at"** control — *All branches* (default) or
   *Selected branches* (checkboxes). Saves the exclusion rows. Also a per-branch bulk view ("what's on this branch's
   menu") is a nice-to-have, not required for v1.
3. **The cloud `POST /orders` guard:** refuse a line for a product hidden at the ordering branch (same shape as the
   A563 `409 SOLD_OUT`), so a stale POS can't sell an item that was pulled from the branch.
4. **Reports/analytics:** unchanged — a product with no sales at a branch simply has none; nothing to gate.

## 4. Phases
1. Migration (the table + RLS + the sync-version trigger). Additive, reversible (`DROP TABLE`). No backfill.
2. Server: the POS-pull filter + the `/orders` guard + a small `product_branches` read/write on the Menu endpoints.
3. Dashboard: the "Available at" control in the Menu editor.
4. Desktop POS: honour the pulled set (it already renders what the pull gives it — likely no POS-side change beyond
   receiving fewer products for the branch).
5. Tests: PGlite migration test; server tests for the pull filter + the order guard; a pure rule for the filter.

## 5. Surgical guarantees / risks
- **Nothing changes for existing data** (no rows ⇒ everything everywhere, exactly as now).
- It's **one filter** at the pull, beside the existing stock-gate — the ordering, kitchen, payment and reporting
  paths are untouched.
- The sale guard mirrors the proven A563 `SOLD_OUT` pattern, so offline/stale tills behave predictably.
- Dev first; prod only on the owner's go.

## 6. Open question for the owner
- **Default when a NEW branch is opened:** does a new branch get the **whole** menu (simplest — no rows) or should
  some categories default off? Recommend: whole menu (no rows), owner trims per branch. (Confirm.)
- v1 scope: product-level only, or also **category-level** "available at" (hide a whole category at a branch in one
  move)? Recommend: product-level first; category-level as a fast-follow if wanted.
