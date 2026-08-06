# Sweep: refund-adjust the remaining revenue reports

Follows the /sales, /master, /tax fix. Same helper (`lib/orderTax.ts`), same
principle — attribute what was earned, not what was rung and later handed back —
applied to the reports that survived the first pass.

## Files in this bundle

    apps/server/src/lib/orderTax.ts        the helper (unchanged from the prior fix)
    apps/server/src/routes/reports.ts      /staff, /splh, /aggregator refund-adjusted
    tests/ordertax.test.mjs                extended, 26 checks

Both source files are complete — drop them over the existing ones. This bundle
SUPERSEDES the previous refund-levy bundle: reports.ts here contains those
changes too, plus this sweep. If you have not yet applied the previous one, this
one covers both.

## What changed

- `/staff`   — a cashier's attributed revenue nets out refunds. The money handed
  back was not their sale. Order COUNT is unchanged — the sale did happen.
- `/splh`    — sales-per-labour-hour uses net-of-refund revenue. Counting
  refunded money as sales flatters labour efficiency.
- `/aggregator` — a platform's gross nets out refunds, and commission is charged
  on the retained gross, not on money that was returned.

## What deliberately did NOT change

- `/hourly` (and its day-of-week and daily series) stays at gross `total`. It is
  a DEMAND-TIMING report — when custom lands, to shape a rota — not a
  recognised-revenue one. An order at the 1pm peak was real custom at 1pm even
  if refunded the next day. A comment in the code says so, to stop a future
  reader "fixing" it.
- The /sales daily series and payment-method breakdown, for the same cash-flow
  reason noted in the previous bundle.

That distinction — earned-revenue reports net out refunds, timing and cash-flow
reports do not — is the whole judgment here. It is applied consistently and
documented at each site.

## Test

    node tests/ordertax.test.mjs

26 checks (20 from the previous bundle, 6 new for the sweep). The new ones prove
staff/splh attribute net revenue, order count is unaffected, aggregator gross
and commission net out refunds, and the old attribution overstated by exactly
the refunded amount. Expected: all PASS.

## Do you need to build the desktop app?

No. Server-only, no migration. Deploy the two files. To verify, pull a staff or
SPLH report over a period containing a refund and confirm the refunding
cashier's revenue dropped while their order count held.

## Still outstanding in reports.ts

None of the revenue-attribution reports now count refunds at full value. If you
later add a new report, route its order totals through `orderTax()` /
`sumOrderTax()` rather than summing `total` directly, and it inherits the
correct behaviour.
