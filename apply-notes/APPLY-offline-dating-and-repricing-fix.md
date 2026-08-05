# Fix: offline order dating (#7) and re-pricing divergence (#19)

## Files in this bundle

    migrations/64_order_atomic_created_at.sql     RPC honours a client created_at
    apps/server/src/routes/orders.ts              passes created_at; detects divergence
    apps/desktop/src/main/syncEngine.ts           sends the sale's original timestamp
    tests/offline-dating-and-repricing.test.mjs   proof, standalone

orders.ts is the WHOLE file and CUMULATIVE (carries all earlier server fixes) —
the newest copy, supersedes previous bundles' orders.ts.

## #7 — offline sales were dated at sync time

A desktop till records a sale's real timestamp locally, but when it pushed the
order to POST /orders → create_order_atomic, the RPC did not accept a created_at,
so Postgres stamped DEFAULT now() at SYNC time. A till offline overnight booked
yesterday's takings as today's — every daily report, Z-report and tax period off
by a day for those sales.

Fix, three small parts:
  * the desktop now includes the sale's original timestamp (created_at) in the
    pushed payload;
  * the handler passes it into the RPC payload;
  * migration 64 (CREATE OR REPLACE of the function from 62) uses
    COALESCE(client created_at, now()) — offline orders keep their real date, a
    live online sale still gets now().

## #19 — offline orders silently re-priced

The server re-prices every order against the current catalogue for anti-tampering
— correct for a live web sale, where the client cannot be trusted on price. But
an offline desktop order was already priced at sale time, PRINTED, and PAID. If a
catalogue price changed between that sale and the sync, the re-priced total
silently diverged from the receipt the customer holds.

Neither extreme is right: blindly trusting the client defeats anti-tampering,
blindly overwriting contradicts the receipt. So the fix DETECTS the divergence:
the re-priced figure is still what gets stored (anti-tampering preserved), but a
mismatch between the client's total and the re-priced total is now logged
([reprice-divergence], flagged OFFLINE when the order carried a sale timestamp),
so it can be reviewed instead of vanishing silently. A sub-cent rounding gap is
tolerated.

This is intentionally a DETECT-and-log fix, not an automatic reconciliation.
Deciding what to DO about a genuine offline price change (honour the receipt vs
honour the new price) is a business-policy call. The log surfaces it; the policy
is yours.

## Apply order

1. Run migrations/64_order_atomic_created_at.sql (safe after 62; self-contained
   if you never ran 62).
2. Deploy orders.ts.
3. Deploy the desktop build for the timestamp to be sent. NOTE: until the desktop
   update ships, offline orders from old tills send no created_at and fall back
   to now() — i.e. the current behaviour, no regression. The server change is
   backward compatible.

## Test

    node tests/offline-dating-and-repricing.test.mjs

10 checks: an offline order books on the day it was sold not synced, a live sale
still uses now(), a divergence between receipt and re-price is detected and
flagged offline while the re-priced figure is stored, and sub-cent rounding is
not flagged. Expected: 10 PASS.

## Do you need to build the desktop app?

For #7's full effect, YES — the desktop must send the timestamp. Build apps/desktop
and roll it out. The server side is backward compatible, so you can deploy the
server first and the desktop when convenient; offline dating corrects itself as
tills update.
