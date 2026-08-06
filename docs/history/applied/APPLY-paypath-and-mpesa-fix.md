# Fix: /pay payment reconciliation (#14) and M-Pesa STK (#5)

## Files in this bundle

    migrations/65_order_atomic_leg_status.sql     leg carries its own status
    apps/server/src/routes/orders.ts              /pay rejects mismatches; mpesa leg pending
    tests/paypath-and-mpesa.test.mjs              proof, standalone

orders.ts is the WHOLE file and CUMULATIVE — it is the newest copy and carries
every earlier server fix (numeric-stock, atomic-order, shift-drawer-sessions,
device-branch, order-number, offline-dating, and now these two). It supersedes
all earlier bundles' orders.ts.

Migration 65 is a CREATE OR REPLACE of create_order_atomic and supersedes 62 and
64 — it includes their changes (payment reconciliation, created_at) plus this
one. Running 65 alone is sufficient; running 62/64 first is harmless.

## #14 — the two order paths disagreed on payment reconciliation

POST /orders enforces "legs must sum to the total" inside create_order_atomic and
REJECTS a mismatch. /pay (the dine-in, order-first path) only LOGGED it via
checkPaymentIntegrity and completed the order anyway. So the same wrong-amount
order was refused on one path and accepted on the other.

Reading the current code, the OTHER divergences from my original review — credit
handling, tax recompute, discount capping — had already been remediated on /pay
under prior audit work (H2, C5, L5). The reconciliation gap was the one left.
/pay now applies the same rule: legs that do not sum to the recomputed total
(±1c) return 400 PAYMENT_MISMATCH and nothing is written; the order stays open to
be paid correctly.

>> SAME DEPLOY CAUTION AS THE ATOMIC-ORDER FIX: if any client sends legs whose
   amounts include a tip, those orders will now be rejected on /pay too. Confirm
   your clients send legs summing to `total` (tip is a separate field) before
   deploying.

FULL CONVERGENCE NOT DONE: making /pay and POST /orders share one code path is a
larger refactor (two multi-hundred-line handlers, different write shapes — /pay
updates an existing open order, POST inserts). The money-correctness rules now
match; the structural merge is a clean follow-up and is deliberately out of scope
here to avoid risking the dine-in path.

## #5 — M-Pesa STK was dead on arrival

create_order_atomic hardcoded EVERY payment leg as status 'completed'. So an
M-Pesa leg was marked completed at order creation — before the customer paid. The
STK-push handler then looked up that leg, saw status 'completed', and returned
409 "already completed". The entire STK flow (push → callback → complete) could
never run.

Fix: a leg now carries its own status. The handler writes an M-Pesa leg as
'pending'; the RPC defaults everything else to 'completed'. The STK callback
(already built and correct in mpesa.ts) flips the pending leg to 'completed' when
the customer pays. The pending leg's AMOUNT still counts toward the
reconciliation total — the money is promised — so the payment guard is satisfied.

SCOPE NOTE — order status: a pure-M-Pesa order is still CREATED with status
'completed' (unchanged behaviour; the STK panel already treats an unconfirmed
order as voidable from Order History). Whether such an order should instead sit
'open' until the callback confirms is a real design decision that ripples into
stock deduction, reporting and the callback's own order-completion logic. That is
deliberately NOT changed here — this fix un-breaks the STK push (the leg is no
longer prematurely completed) without rearchitecting order lifecycle. Flagged for
a considered follow-up.

## Apply order

1. Run migrations/65_order_atomic_leg_status.sql (supersedes 62/64; safe to run
   after them).
2. Deploy orders.ts.

## Test

    node tests/paypath-and-mpesa.test.mjs

12 checks: /pay accepts reconciling legs and splits, rejects under/overpayment,
tolerates one-cent rounding; an M-Pesa leg is written pending while cash/card are
completed; the old hardcoded-completed behaviour is shown to have 409'd the STK
push; and a pending mpesa leg still reconciles to the total. Expected: 12 PASS.

## Do you need to build the desktop app?

No. Server + migration only. After deploying, run a live M-Pesa sale end to end
(create order → STK prompt on the phone → callback) and confirm the leg moves
pending → completed and the order completes.
