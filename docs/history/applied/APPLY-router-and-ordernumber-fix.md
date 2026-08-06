# Fix: error-handler arity (#18) and order-number collisions (#20)

Two small correctness fixes.

## Files in this bundle

    apps/server/src/middleware/asyncHandler.ts    preserves 4-arg error handlers
    apps/server/src/routes/orders.ts              distinguishes order-number vs idempotency collision
    apps/dashboard/src/lib/cart.ts                collision-resistant order number
    tests/router-and-ordernumber.test.mjs         proof, standalone

All three source files are complete. orders.ts is CUMULATIVE — it carries the
numeric-stock, atomic-order, shift-drawer-session and device-branch fixes too,
and is the newest copy (supersedes earlier bundles' orders.ts).

## #18 — safeRouter broke Express error handlers

safeRouter wraps every handler in asyncHandler, which returns a 3-argument
function. Express identifies an ERROR handler purely by arity — fn.length === 4
(err, req, res, next). Wrapping one dropped it to arity 3, so Express treated it
as ordinary middleware and never routed errors to it. Any 4-arg error handler
registered on a safeRouter was silently dead.

Fix: pass any 4-arg function through untouched; only wrap 0–3 arg handlers (the
async route handlers this wrapper exists for). An error handler must not be
wrapped anyway — asyncHandler's .catch(next) would re-enter the error pipeline.

## #20 — order numbers could collide

generateOrderNumber() was a 6-digit time slice + 3 random digits. Two sales in
the same 100ms with the same random draw produced the same number, and the
unique index (business_id, branch_id, order_number) then REJECTED the second
sale. Three defences now:

  1. a per-process monotonic counter — two calls on the same client in the same
     millisecond cannot collide, by construction;
  2. a random suffix — two DIFFERENT clients are very unlikely to collide even
     within one millisecond;
  3. the server unique index as the backstop. The atomic-order handler now tells
     an order-number collision apart from an idempotency replay: a replay of the
     same order returns 200 duplicate (as before); a genuinely different order
     that drew the same number returns a clean 409 (ORDER_NUMBER_CONFLICT) the
     client retries, instead of the old 500.

## Test

    node tests/router-and-ordernumber.test.mjs

9 checks: async/middleware handlers are wrapped, a 4-arg error handler is passed
through and keeps arity 4, the old wrapper is shown to have broken it, and 20,000
order numbers from one client produce ZERO collisions (vs ~10k for the old
generator). Expected: 9 PASS.

## Do you need to build the desktop app?

No. The generator change is in the web dashboard (build it: `npm run build` in
apps/dashboard). The server changes need no migration and no desktop build.
