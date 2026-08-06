# Fix: refunds inflate reports, and the levy is derived not read (findings #8, #9)

Two reporting bugs of the same species — a report should state what HAPPENED,
read from the columns the sale wrote, not recompute from a formula that drifts
from the till.

## Files in this bundle

    apps/server/src/lib/orderTax.ts        new shared helper (the one correct place)
    apps/server/src/routes/reports.ts      /sales, /master, /tax wired to it
    tests/ordertax.test.mjs                proof, runnable standalone

Both source files are complete — drop them over the existing ones. `orderTax.ts`
is new. Only these were touched this session.

## Bug 1 — refunds counted at full value

A refund deliberately leaves `status = 'completed'` and records
`refunded_amount`. The baseline schema comment says so outright: *"The order
stays completed — the sale happened."* Every reducer in reports.ts filters on
`status = 'completed'` and reads `total`, and none of them read the refund
columns — so a fully refunded 1,000 order still counted as 1,000 of sales and
its VAT still counted as output tax. Only reports-daily.ts ever looked at
refunds.

The fix keeps the gross sale (it really happened) but subtracts what was
returned: `net = total - refunded_amount`, with VAT and CTL reduced by the same
fraction, because a partial refund returns a slice of the whole tax-inclusive
price.

## Bug 2 — the catering levy derived instead of read

The tax and master reports computed `ctl = (total - vat_amount) * ctlRate`. But
at sale time (payment.ts) VAT and CTL are BOTH charged on the same net:

    net = total / (1 + (vat + ctl)/100)
    vat = net * vatRate
    ctl = net * ctlRate

so `total - vat = net * (1 + ctlRate)`, and multiplying THAT by ctlRate
overstates the levy by `net * ctlRate²`. At 2% the error is small (~0.04% of
net) but it is wrong and it is on a filed tax document. `orders.ctl_amount`
already stores exactly what the sale charged and eTIMS transmitted — the report
now reads it.

## What changed, per report

- `/tax`   — reads stored vat_amount and ctl_amount, nets out refunds, and the
  category and branch breakdowns use the same basis so they still sum to the
  summary. Summary now also returns `refundedOrders` and `refundedAmount`.
- `/master`— sale summary reads stored values and nets out refunds.
- `/sales` — revenue and VAT are refund-adjusted. The DAILY SERIES and the
  PAYMENT-METHOD breakdown are deliberately left at full `total`: they answer a
  cash-flow question (what the drawer took, by method, each day), not a
  recognised-revenue one. A refund is a separate cash event on its own day.

All of it flows through `lib/orderTax.ts`, so there is one definition of
"refund-adjusted, stored-value figures" rather than the same arithmetic copied
into every reducer.

## Not yet done in this pass

`/hourly`, `/staff` and `/splh` in reports.ts also count refunded orders at full
value. They are staffing and productivity views, not tax documents, so the
overstatement is less serious — but they should get the same `orderTax()`
treatment in a follow-up. I stopped at the three financial reports because those
are the ones that feed a return.

## Test — no server, no database

    node tests/ordertax.test.mjs

20 checks. It rebuilds the sale-time tax math from payment.ts to generate orders
exactly as the till stores them (as strings, the way PostgREST returns numeric),
then proves: the levy is read not derived, the old derived levy was overstated
by exactly net*ctlRate², a full refund removes the order from sales and tax, a
partial refund reduces both proportionally, and everything reconciles
(net + vat + ctl = gross). Expected: 20 PASS, exit 0.

## Do you need to build the desktop app?

No. Server-only, no migration, no schema change — the columns it reads
(ctl_amount, refunded_amount, refunded_at) already exist. Deploy the two files,
then pull a tax report over a period that contains a refund and confirm the VAT
line dropped and a `refundedOrders` count appears.

## After applying

Historical tax reports you have already filed were overstated on output VAT by
the VAT embedded in every refund in the period, and the levy was slightly high.
If any of those returns were submitted from these numbers, it is worth
re-pulling the affected periods and comparing — the correction is in your favour
(you over-declared), but it is better to find that yourself than to have it
found.
