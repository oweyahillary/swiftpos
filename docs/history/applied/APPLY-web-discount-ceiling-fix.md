# Fix: web POS ignores the discount ceiling (finding #6)

The web POS was the only client that did not clamp discounts to the server's
ceiling. A cashier applying 25% charged the customer 25% off and printed a
receipt saying so, while the server capped the discount at 10% and stored the
higher total. The customer paid one number; the books recorded another.

## Files in this bundle

    apps/dashboard/src/pages/pos/cashier/types.ts        ceiling type + shared clamp
    apps/dashboard/src/pages/pos/cashier/usePOSData.ts   captures the advertised ceiling
    apps/dashboard/src/pages/pos/CashierScreen.tsx       threads it to PaymentModal
    apps/dashboard/src/pages/pos/PaymentModal.tsx        clamps + recomputes the charge
    tests/discount-clamp.test.mjs                        proof, standalone

All four source files are complete — drop them over the existing ones.

## What was wrong

`pos/init` already advertises `maxDiscountPct` (default 10). The DESKTOP till
reads it and clamps, and shows the cashier a "capped" state. The WEB POS read it
nowhere: `PaymentModal` sent `loyaltyDiscount + promoDiscount` and a `total`
computed from the uncapped discount. The server's `recomputeOrderTotals` capped
the discount and stored the capped total, so:

    subtotal 1000, cashier applies 25%
      web POS  → discount 250, total 750, customer pays 750, receipt says 750
      server   → discount capped to 100, total 900 stored
      payment legs sum to 750, stored total is 900  → mismatch

This is the same class as the desktop bug that was already fixed (finding H1);
the web client just never got the same treatment.

## Why it is urgent now

The atomic-order fix (findings #10/#15) added a guard that REJECTS an order whose
payment legs do not reconcile to the total. The mismatch above previously logged
`[payment-mismatch]` and let the sale through; with that guard live, the same
over-ceiling discount would FAIL THE SALE at the till.

>> DEPLOY ORDER: ship this WITH or BEFORE the atomic-order guard, never after.
   If the guard goes live first, any web sale with an over-ceiling discount is
   rejected at checkout until this lands.

## The fix

- `types.ts` adds `maxDiscountPct` to the init response, a shared
  `DEFAULT_MAX_DISCOUNT_PCT = 10` fallback, and `capDiscountPct()`, which mirrors
  the server's `capDiscount` exactly.
- `usePOSData` captures the advertised ceiling and exposes it.
- `CashierScreen` passes it to `PaymentModal`.
- `PaymentModal` clamps the combined loyalty+promo discount, recomputes the
  charged total from the clamped figure, and sends the clamped discount and total
  in the payload. Every charged-facing amount — the big total, cash placeholder,
  M-Pesa, card, credit check, split panel — now uses the corrected total. The
  cashier sees an orange "Discount capped at N%" notice when it fires, so an
  over-ceiling entry is visible, not silent.

The single source of truth stays the server's `MAX_DISCOUNT_PCT`, advertised via
`pos/init`. Raising it there flows to both clients (the till learns the new value
on its next catalogue pull).

## Test

    node tests/discount-clamp.test.mjs

18 checks. Proves an over-ceiling discount is capped, the charged total equals
what the server stores (so legs reconcile and the sale is not rejected), a
discount under the ceiling is untouched, combined loyalty+promo is capped with
the split preserved, tip rides on top correctly, and a higher configured ceiling
flows through. Expected: all PASS.

## Do you need to build the desktop app?

No — this is the WEB dashboard, not the desktop. But you DO need to build the
dashboard:

>> IMPORTANT — VERIFY THE BUILD. These four files include React/JSX that could
   NOT be typechecked where this fix was prepared (node_modules was not
   installed there, so react did not resolve). The clamp ARITHMETIC is verified
   by the standalone test above, and the type file was syntax-checked, but the
   JSX edits in PaymentModal and CashierScreen are verified by reading, not by a
   compile. Run `npm run build` (or `tsc --noEmit`) in apps/dashboard on your
   machine before deploying, and fix any type error there — the changes are
   small and localised (search for `maxDiscountPct`, `cappedDiscount`,
   `chargedTotal`, `grandTotal`).

After building, apply a discount above the ceiling on the web POS and confirm:
the charged total reflects the capped discount, the cap notice appears, and the
sale completes (the stored total now matches what was charged).
