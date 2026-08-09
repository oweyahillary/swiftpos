# SwiftPOS — QA report triage: root causes + fixes

From the Chrome-agent QA pass. Deliberate test fixtures (#11 negative price, #12
XSS/SQLi payloads, #13-data/#14 duplicates) are excluded. Each item below is a real
bug with a code-level root cause and a concrete fix. Line numbers are `apps/server`.

Legend: **CONFIRMED** = root cause pinned in code · **NEEDS LOG** = one server-log
line will confirm · **DECISION** = needs a product call, not just a code fix.

---

## A. Backend 500 / 404 cluster

### #2 Reports → Item Mix 500 — **CONFIRMED** (quick)
`routes/reports.ts` `GET /products-v2` (~line 991). The query was refactored to use
the `chunkIn` helper, which **returns an array and throws its own errors**. A leftover
line remained:
```ts
const items = await chunkIn<any>('order_items', 'order_id', orderIds, q => q.select(...));
if (error) { res.status(500).json({ error: error.message }); return; }   // ← `error` is undefined here
```
`error` no longer exists in this scope → ReferenceError → 500, every time there are
completed orders in range. (The "fires twice" the agent saw is a separate frontend
double-fetch.)
**Fix:** delete the `if (error) { … }` line. `chunkIn` already throws on failure and
it's caught by the async handler.

### #3 Combo Meals 500 (masked as "No combos yet") — **CONFIRMED**
`routes/combos.ts` `GET /`. `combo_items` has **two** foreign keys to `products`
(`combo_id → products.id` and `product_id → products.id`, per the consolidated
migration). So the embed `combo_items ( … )` is ambiguous — PostgREST can't choose a
relationship and errors.
**Fix:** disambiguate the parent→child join by naming the FK:
```ts
combo_items!combo_id ( id, quantity, sort_order, product:product_id ( id, name, price, image_url ) )
```
**Frontend (silent-failure):** the page turns the 500 into a normal "No combos yet"
empty state. It should distinguish "empty" from "request failed" and show an error/retry.

### #4 Table Turnover "Live tables" 404 — **CONFIRMED**
`routes/orders.ts`. `GET /:id` (line 876) is declared **before** `GET /turnover`
(line 1422), so a request to `/turnover` matches `/:id` with `id="turnover"`, finds no
such order, and returns 404. (`/turnover/report` escapes this only because it's two
segments.)
**Fix:** move the `/turnover` and `/turnover/report` route registrations **above**
`GET /:id`. General rule: literal routes before parameterised ones.

### #1 Expenses "Save Expense" 500 — **NEEDS LOG** (+ real frontend bug)
`routes/expenses.ts` `POST /` looks structurally fine. The `expenses` table's full
definition (incl. `paid_by`) is **not present in this repo's migrations**, so I can't
prove the exact cause from source. `sendError` **logs the real Postgres error** as
`[error <ref>] 500 — …` and, since the agent ran a dev server, also returned it in the
response `detail` field. Grab that line — it will say one of:
- `Could not find a relationship between 'expenses' and 'users'` / ambiguous embed →
  **Fix:** disambiguate the embed, e.g. `users!paid_by ( name )` (and matching for the
  GET list). Most likely if `expenses` has both `paid_by` and `created_by` → `users`.
- `null value in column "…" violates not-null` → **Fix:** provide that column in the
  insert (e.g. `created_by: req.userId`).
- `column "paid_by" does not exist` → schema drift; **Fix:** align insert to the real columns.

**Frontend (real, independent):** the red "Internal server error" banner renders
**below the modal fold with no scroll**, so a failed save looks like a dead button. Fix
the expense modal so errors are visible in the viewport (this is the exact silent-failure
pattern to hunt down app-wide).

---

## B. Reporting correctness

### #5 Turnover report empty despite completed dine-in sales — **CONFIRMED**
`routes/orders.ts` `GET /turnover/report` filters `.not('seated_at','is',null)`, but
`seated_at` is set in **only one place** — the `/open` (order-first) handler (line 1172).
The pay-first flow the POS actually uses creates orders via `POST /`, which never sets
`seated_at` (defaults null). So every real dine-in order is excluded → empty report.
**Fix:** set `seated_at` on `POST /` creation when `order_type === 'dine_in'`
(mirror line 1172), and/or fall back to `created_at` in the report when `seated_at` is null.

### #7 Z-Report: two Cash totals, off by exactly KES 500 — **CONFIRMED**
Both figures come from the `payments` table but on **different bases**:
- *Payment Breakdown → Cash* = all completed cash payments in the period.
- *Cash Reconciliation → Cash Sales* (`reports.ts` ~line 416) = cash payments filtered
  by `orders.shift_id IN (shifts opened within the window)`.
`POST /orders` defaults `shift_id` to null (line 430), and a shift can open just before
the window. So a cash order with `shift_id = null` (or on an out-of-window shift) is
counted in the breakdown but **not** in reconciliation → the exact-500 gap, which then
skews "Expected in Drawer".
**Fix:** compute both from the same basis. Simplest: base reconciliation "cash sales" on
the same period cash payments used by the breakdown (or guarantee every order gets a
`shift_id`). Also decide the window on the *order/payment* date, not the shift's `opened_at`.

### #8 Payment Methods don't sum to Gross Sales (750 unaccounted) — **CONFIRMED**
Gross is summed from `orders.total`; the payment-method split is summed from the
`payments` table (`reports.ts` ~lines 96 / 335 / 657). Completed orders that have **no
completed `payments` row** (or where `sum(payments) ≠ order.total`) count toward gross
but toward no method → a silent shortfall that grows with such orders.
**Fix (reporting):** for completed orders with no/insufficient completed payments, fall
back to the order's own `payment_method` + `total`, or add an explicit "Unaccounted" row
so the gap is visible instead of dropped. **Fix (data):** ensure every completed order
writes a `payments` row (find the pay path that skips it — likely credit/on-account or
legacy orders).

---

## C. Stock / data integrity

### #9 Track-stock + recipe: finished-good counter never moves — **DECISION**
`routes/orders.ts` 6a unit deduction (~line 568): `newQty = Math.max(0, currentQty − qty)`
**clamps at 0**, and nothing blocks selling a 0-stock tracked product. A recipe-backed
product deducts its ingredients (6b, correct) but its own counter is stuck at 0, so the
Inventory page shows "0 / Out of Stock" while POS sells it freely — the two stock systems
disagree.
**Options (pick one):**
1. A product with a recipe shouldn't track finished-good stock — hide/ignore the counter
   and show availability from ingredients (cleanest for made-to-order).
2. Allow negative stock (drop the `Math.max` clamp) so oversell is visible.
3. Add a POS stock guard that warns/blocks when a *non-recipe* tracked product hits 0.

### #10 Cancelled PO shows KES 46 total with 0 line items — **CONFIRMED**
`routes/stock.ts`. `total_amount` is written once at creation (line 320) and never
recomputed when items change or the PO is cancelled (`/purchase-orders/:id/cancel`,
line 349, only flips status + note).
**Fix:** derive the displayed total from the line items in the response, or recompute
`total_amount` whenever items change / on cancel (set to 0 or the received value).

### #13 Expired promo still shows "Active" — **CONFIRMED**
`routes/promotions.ts`. The POS `/active` endpoint correctly checks `start_date`/`end_date`
(lines 31-32), but the dashboard **list** returns the stored `status` column, which is a
manual flag that never flips when `end_date` passes.
**Fix:** derive an effective status in the list response — if `status==='active'` and
`end_date < now` → return `expired` (and `scheduled` if `start_date > now`). Frontend then
shows the computed status. (Optional: a nightly job to flip the stored column.)

---

## D. Known / already logged
- **#6 KDS 401** — no auth token; ROADMAP §6.1. Route `/api/kitchen/tickets` through the
  authenticated api client.
- **POS Apply-Discounts / Hold / Customers / Payments placeholders** — unbuilt; ROADMAP §6.3.
  This is why POS discount arithmetic couldn't be verified end-to-end.

## E. Needs reproduction
- **Double-click bug** (some buttons need a second click; first only focuses). Intermittent;
  needs a reliable repro to pin — likely a focus-then-act handler or a state guard on first render.

---

## Suggested order to fix
1. **Quick, certain, high-impact:** #2 (delete dead line), #3 (`!combo_id`), #4 (route order),
   #5 (`seated_at`). Small, low-risk backend edits.
2. **Get the log line for #1**, then apply the matching one-line fix; fix the off-screen
   error banner (frontend).
3. **#7 / #8** — align the reconciliation/payment bases (a decision on which basis is truth).
4. **#9** — product decision, then implement.
5. **#10, #13** — small correctness fixes.
6. Add a Playwright/API test per fix where practical so they don't regress.

Frontend theme across #1/#3/#4: **the dashboard hides API failures** (off-screen banner,
"empty state" masking a 500, 404 shown as "none"). Worth one consistent "surface API errors"
pass in addition to the individual endpoints.
