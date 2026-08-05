# SwiftPOS — Schema vs Code Audit

Source: `backup_20260717_230849.sql` (SwiftPOS, schema-only, 82 tables, no data).

**Read §1 before deleting a single migration.**

---

## 1. ⛔ Do not delete the migrations yet — and I have not written a baseline

The plan was: dump → baseline → retire migrations. I've stopped at step 1 on
purpose, because the dump raises a question I can't answer from the repo:

> **Is this dump production, or a dev database that has drifted?**

It matters enormously:

- **If it's authoritative** → a baseline is safe, but several code paths are
  querying columns that don't exist and must be fixed (§3).
- **If it's a drifted dev DB** → generating a baseline from it would **enshrine
  the drift as the official schema**, and deleting the migrations would destroy
  the only record of what production actually needs. That's unrecoverable.

Evidence it may not be authoritative: **migrations 19 and 20 were never applied**
here, while 21–24 were.

| migration | artifact | state |
|---|---|---|
| `19_branch_reveal_code` | `branches.reveal_code` | ❌ **not applied** |
| `20_branch_prices` | table `branch_prices` | ❌ **not applied** |
| `21_mpesa_payment_tracking` | `payments.mpesa_checkout_id` | ✅ applied |
| `22_shift_close_and_float` | table `float_transactions` | ✅ applied |
| `23_per_branch_ingredient_stock` | table `ingredient_stock_levels` | ✅ applied |
| 01–18 | (spot-checked) | ✅ applied |

There's **no `_migrations` / `schema_migrations` table**, so the database cannot
be asked what's applied — this had to be inferred from artifacts.

### The 10-second check

Run against **production**:

```sql
-- 1. Does the column 5 report queries depend on actually exist?
select column_name from information_schema.columns
where table_schema='public' and table_name='orders' and column_name='payment_method';

-- 2. Were migrations 19/20 applied to prod?
select to_regclass('public.branch_prices') as branch_prices_table;
select column_name from information_schema.columns
where table_schema='public' and table_name='branches' and column_name='reveal_code';

-- 3. Does the fuel/stock movement insert have a business_id to write to?
select column_name from information_schema.columns
where table_schema='public' and table_name='stock_movements' and column_name='business_id';
```

- **All empty/null** → the dump matches prod. It's authoritative, §3 are live
  bugs, and I'll generate the baseline.
- **Any returns a row** → the dump is a drifted dev DB. Send a prod dump instead;
  do not baseline from this one.

---

## 2. ✅ What the dump confirmed

**25 of 26 columns I'd inferred from read paths during the code review were
correct.** Every "the runtime is right, the type is lying" call held up:

| verified | |
|---|---|
| `order_item_variants.variant_group_name` / `variant_option_name` exist; `group_name` does **not** | the declaration was wrong, the code right |
| `payments.amount_tendered`, `change_given`, `mpesa_checkout_id` exist; `tendered` does **not** | the phantom field was indeed phantom — no data was ever lost |
| `products.track_stock`, `sold_by` exist; `track_inventory` does **not** | the stale cast really was fiction |
| `fuel_tanks.capacity_litres`, `current_level`, `reorder_level` exist; `capacity` does **not** | |
| **`orders.pump_id` exists** | confirms the fuel-report zeros were a missing `select`, not a missing column |
| `order_items.notes`, `product_name`, `category_name` exist | |

### The one I got wrong — and it was a real bug

I claimed `kitchen_tickets.source` existed ("Supabase would reject an unknown
column, so it must"). **It doesn't.** The real table has 10 columns:

```
id, order_id, branch_id, station, status,
printed_at, preparing_at, ready_at, collected_at, created_at
```

`qr.ts` was inserting **nine** fields — `business_id`, `order_number`,
`order_type`, `table_id`, `source`, `items` are all phantom — plus
`status: 'pending'`, which violates `kitchen_tickets_status_check`
(`'new' | 'preparing' | 'ready' | 'collected'`). It could never have succeeded.

**This also means my previous fix made it worse.** Removing the `.catch()`
TypeError turned a loud 500 into a *silent* success: the customer now gets a
`201`, the order is committed, and the kitchen still never sees it. Worse,
because nobody notices.

**Fixed properly** — mirrors the working insert in `orders.ts`
(`kitchen.ts` joins through `orders → order_items` for ticket contents, so the
table is deliberately minimal):

```ts
const { error: ticketErr } = await supabase.from('kitchen_tickets').insert({
  order_id: order.id, branch_id, status: 'new',
});
```

No migration creates `kitchen_tickets` at all — it's one of the phantom base
tables, which is exactly why this drifted unnoticed.

---

## 3. 🔴 Phantom columns — code querying things that don't exist

Found by `scripts/schema-audit.py` (§4). **Every one of these fails at runtime
with PostgREST `42703`** if the dump is authoritative.

### The serious one: `orders.payment_method` does not exist

It's on `invoices` (billing), not `orders`. **No migration has ever created it.**
It appears in **5 SELECTs**:

| file | line | report |
|---|---|---|
| `reports.ts` | 97 | **Master / DSR** |
| `reports.ts` | 345 | daily report |
| `reports.ts` | 573 | shift/labour |
| `reports.ts` | 650 | Aggregators |
| `shifts.ts` | 297 | **Z-report / shift close** |

A `select` naming a non-existent column errors → `if (error) res.status(500)` →
**those reports return 500**.

The timeline fits uncomfortably well. `handoffs/BUGFIXES.md` **#8 "Payment
Methods don't sum to Gross Sales — CONFIRMED"** prescribed: *"fall back to the
order's own `payment_method` + `total`"*. `handoff-11-07-2026.md` §147 shows it
applied on 11 July. **The fix for #8 may have broken the very report it fixed.**
If your DSR has been 500ing since ~11 July, this is why.

### The rest

| table.column | file | real column |
|---|---|---|
| `stock_movements.business_id` | `fueltanks.ts`, `orders.ts` | *(none — table has no business_id)* |
| `stock_movements.cashier_id` | `orders.ts` | `created_by` |
| `products.price` | `combos.ts`, `qr.ts` | `base_price` |
| `products.vat_rate` | `qr.ts` | *(none)* |
| `orders.table_id` | `qr.ts` (insert) | `table_number` |
| `orders.created_by` | `dailySummary.ts` | `cashier_id` |
| `expenses.category` | `reports-export.ts` | `expense_category_id` |
| `users.role` | `staff.ts` | `role_id` |
| table `staff` | `dailySummary.ts` | *(doesn't exist — `users`?)* |
| table `branch_prices` | `branch-prices.ts`, `pos.ts`, `orders.ts` | migration 20 unapplied |

Notes:

- **`stock_movements.business_id`** is in code I edited last round. The fuel
  delivery movement log has *never* worked — the existing comment
  (`// was incorrectly 'quantity' — silent DB fail`) shows someone fixed
  `quantity`→`quantity_change` and missed that `business_id` isn't a column
  either. My `.catch()` fix stopped the TypeError but the insert still fails;
  it now just logs.
- **`branch_prices`** degrades gracefully in `orders.ts:139` (the `error` is
  ignored, so it falls back to `products.base_price`) — per-branch pricing
  silently doesn't apply. But `routes/branch-prices.ts` will 500 outright.
- **`stock_movements.quantity_change` / `quantity_after` are `integer`**, yet
  fuel sells in fractional litres (`fuel_tanks.current_level` is
  `numeric(10,2)`, `order_items.quantity` is `numeric(12,2)`). Even once
  `business_id` is removed, 20.5 L will not round-trip. Schema change, not a
  code fix.

**I have deliberately not "fixed" any of these except `qr.ts`.** If the dump is a
drifted dev DB, changing `products.price` → `base_price` could break production.
They wait on §1.

---

## 4. New tool: `scripts/schema-audit.py`

Parses a `pg_dump --schema-only` into `scripts/schema-index.json`, then
cross-checks every `.from().select()` / `.insert()` in the server against it —
recursively, resolving PostgREST embeds to their own tables.

```bash
python3 scripts/schema-audit.py
```

This is the automated version of the bug class that produced the fuel-report
zeros and the QR ticket failure. Worth wiring into CI once the schema is settled
— it catches what `tsc` structurally cannot, because supabase-js types
`.from('x')` as `any`.

> **A note on this tool's own history:** v1 reported **75** problems. Most were
> false — it flattened nested embeds and blamed the parent table for the child's
> columns (claiming `kitchen_tickets` lacked `order_type`, when the select was
> `kitchen_tickets → orders ( order_type )`). v2 parses the select tree properly:
> **18** hits, and I hand-verified each against the schema. An audit that cries
> wolf is worse than no audit.

---

## 5. Once §1 is answered

If the dump is authoritative:

1. Generate `migrations/00_baseline.sql` — full idempotent schema, so the DB is
   rebuildable from source for the first time.
2. Fix the §3 phantom columns.
3. Add a `_migrations` tracking table + a runner, so "what's applied?" stops
   being archaeology. **This is what let 19 and 20 go missing silently.**
4. *Then* retire the superseded migrations — baseline first, deletions last.
5. Wire `schema-audit.py` into CI.
