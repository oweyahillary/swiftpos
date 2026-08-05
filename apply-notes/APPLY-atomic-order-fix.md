# Fix: no transaction around order writes (findings #10 and #15)

`POST /api/orders` wrote an order in ~15 sequential PostgREST calls with no
transaction. A failure — or a dropped connection — after the order row but
before the payments left a COMPLETED order with no tender, or items belonging to
no order. This closes that, and folds in the payment-reconciliation guard
(#15) so a mismatched order is rejected rather than logged.

## Files in this bundle

    migrations/62_create_order_atomic.sql      new atomic order-write RPC
    apps/server/src/routes/orders.ts           handler wired to the RPC
    tests/atomic-order.test.mjs                proof, standalone

orders.ts is the WHOLE file. It also contains the earlier numeric-stock fix
(the void/refund restore RPC calls), so if you have not applied that bundle,
this orders.ts covers both. It does NOT include the report changes — those are
in reports.ts, a different file.

## What the RPC does

`create_order_atomic(p_order, p_items, p_payments)` writes, in ONE transaction:

    order → order_items → order_item_variants → order_item_modifiers → payments

These are the invariant unit — an order is not valid without its lines and its
tender. If any insert fails, the whole thing rolls back and no partial order
exists. Before writing anything, it checks the payment legs sum to the order
total (±1 cent) and aborts if not.

## What deliberately stays OUTSIDE the transaction

Stock deduction, loyalty, discount-usage counters and the KDS ticket remain in
the handler as post-commit steps. They are consequences of a sale, not part of
its identity. The important change: they now run only AFTER a durable, complete
order exists, so a failure in stock deduction can no longer orphan the order. At
worst it leaves stock to reconcile — a smaller, detectable problem than a
phantom paid order.

This is the same boundary the desktop already draws in createLocalOrder: the
order/items/payments are one db.transaction(); stock is handled around it.

## Behavioural changes to know about

1. A payment mismatch now returns HTTP 400 and writes NOTHING. Previously the
   order was written and `checkPaymentIntegrity` merely logged `[payment-mismatch]`.
   If any client is currently sending legs that do not sum to the total —
   TIPS are the known case: the web client was sending legs summing to
   total+tip — those orders will now be REJECTED.

   >> CHECK THIS BEFORE DEPLOYING. Pull your logs for `[payment-mismatch]`. If
      tipped orders appear there, fix the client to send legs summing to `total`
      (tip is a separate field) FIRST, or those sales will fail at the till.
      The RPC is correct; the mismatch was a real bug — but it must not first
      surface as a checkout failure during service.

2. A duplicate idempotency key (concurrent retry) now surfaces as a Postgres
   unique-violation (23505), which the handler maps to the existing
   "duplicate" 200 response. Same outcome as before, reached differently.

## Apply order

1. Run `migrations/62_create_order_atomic.sql` FIRST. The handler calls the RPC;
   without it, order creation errors. It is CREATE OR REPLACE and additive.
2. Deploy orders.ts.

## Test

    node tests/atomic-order.test.mjs        (needs better-sqlite3; apps/desktop has it)

14 checks against a real transaction: a clean order writes everything together,
a failure partway leaves NOTHING (specifically never a completed order with no
payment), under- and over-payment are rejected before any write, a correct split
is accepted, and a one-cent rounding difference is tolerated.

## Do you need to build the desktop app?

No. Server + migration only. The desktop's own order write was already atomic
and is untouched. After deploying, ring a normal sale and a split-payment sale
and confirm both succeed; then, if you can, simulate a bad payload in staging
and confirm no partial order appears.

## Why not put stock in the transaction too

It could be done, but it would pull product and ingredient stock, recipe
explosion, fuel tanks and the KDS insert into one large plpgsql function — a
much bigger rewrite of the hottest path, harder to review, and with its own
failure modes (a stock RPC deadlock would now fail the whole sale). The
order/items/payments boundary is where the actual corruption was, and drawing
the transaction there fixes the reported bug with a change that can be read in
one sitting. Widening it later is a clean follow-up if you want it.
