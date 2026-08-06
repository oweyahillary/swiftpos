# Fix: numeric-string stock corruption (finding #1)

Four write paths added a number to a value that PostgREST returns as a STRING,
so the addition concatenated instead of summing. Fixed here, with a test that
reproduces the bug and proves the fix without touching the live database.

## Files in this bundle

    migrations/61_adjust_product_stock.sql     new atomic RPC for product stock
    apps/server/src/routes/stock.ts            product receive → uses the RPC
    apps/server/src/routes/orders.ts           void + refund restore → RPC;
                                               total_spent → Number() coercion
    tests/numeric-stock.test.mjs               proof, runnable standalone

Each source file is the WHOLE file, edited in place — drop it over the existing
one. Only these were touched this session; nothing else is included.

## What was wrong

| Path | Old code | Result |
|---|---|---|
| Product receive | `(current.quantity ?? 0) + item.quantity` | `"10.00"+5` → `"10.005"` → stored 10.01. Receiving stock did almost nothing. |
| Void restore | `currentQty + item.quantity` (both strings) | `"10.00"+"2.00"` → `"10.002.00"`, invalid numeric, upsert failed silently. **Stock was never returned on a void.** |
| Refund restore | `(stock.quantity ?? 0) + Number(item.quantity)` | `Number()` was on the wrong operand — `"10.00"+2` → `"10.002"`. |
| `total_spent` | `(cSpent.total_spent ?? 0) + authTotal` | `"1500.00"+890` → `"1500.00890"`. The column never grew; every CRM segment read a dead value. |

Deduction used subtraction, which coerces a string to a number, so selling
worked and restoring did not. That asymmetry is why it stayed invisible: the
shelf went down on a sale and never came back up on a void.

## How it is fixed

The product paths now call a new atomic RPC, `adjust_product_stock`, which does
the arithmetic inside Postgres under the row lock that `ON CONFLICT` takes. This
mirrors what the INGREDIENT path already did (`adjust_ingredient_stock`,
migration 23) — products simply never got the same treatment. This closes two
bugs at once: the string concatenation AND the read-modify-write race, where two
tills receiving the same product could each read 10, each write 15, and lose
five units.

`total_spent` kept its inline update (its block is deliberately RPC-free) but now
coerces both operands with `Number()`.

## Apply order

1. Run `migrations/61_adjust_product_stock.sql` against the database FIRST. The
   code calls the RPC; if the function is not there yet, receive/void/refund
   will error. There is no silent-fallback path for products, by design — a
   loud failure is safer than silent corruption.
2. Deploy the two route files.

The RPC is `CREATE OR REPLACE` and additive — it does not alter existing tables
or data, so it is safe to run on production ahead of the code deploy.

## Test — no live database needed

    node tests/numeric-stock.test.mjs

The JS half runs anywhere and reproduces the exact concatenation bug in
isolation, then proves `Number()` coercion fixes it. The SQL half needs
better-sqlite3 (already a dependency in apps/desktop) and drives
receive / sell / void / concurrent-receive through a SQLite mirror of the RPC,
proving the numbers come out right and 100 concurrent receives lose nothing.

To run the SQL half from a folder that has better-sqlite3:

    cp tests/numeric-stock.test.mjs apps/desktop/
    cd apps/desktop && node numeric-stock.test.mjs

Expected: 12 PASS, exit 0.

## Do you need to build the desktop app to test this?

No. This fix is entirely server-side (the API and the database). The desktop
app never had the bug — its stock writes already run inside a real
`db.transaction()`. So:

- To verify THIS fix: run the test above, then apply the migration and exercise
  a real receive and a real void against a staging database, checking that
  stock_levels.quantity moves by the right amount in both directions.
- You do NOT need to rebuild or reinstall the desktop app for this change.

The only work that requires building the desktop app is the PRINTING rebuild
(the separate bundle), because that adds main-process and renderer code. This
one is a server deploy plus a migration.

## After applying

A quick production sanity check, since the bug means historical data is already
wrong:

- `total_spent` on existing customers is understated (it stopped growing when
  the bug was live). If you rely on it, recompute it from `orders` once:
  sum each customer's completed, non-refunded order totals and write it back.
- Stock levels for anything received through the app are understated by roughly
  the amount received. A physical stock count and a one-time correction per
  product is the only clean way back; there is no way to reconstruct the lost
  quantities from movement history, because the movements recorded the intended
  change while the level recorded the corrupted one.
