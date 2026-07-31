# Glovo payment method + UI fixes (for `dev`)

9 files. Includes the order-type row and "9 failed" fixes from the last drop.

```bash
psql "$DATABASE_URL" -f migrations/46_payment_method_glovo.sql   # additive
cd apps/server && npm run build                                  # deploy
cd apps/desktop
npm version 0.4.4 --no-git-tag-version
npx tsc -p tsconfig.json && npx tsc -p tsconfig.main.json && npx vite build \
  && rm -rf release && npm run pack:installer && npm run pack:portable
```

**Run migration 46 BEFORE installing.** `payments_method_check` admits only cash,
mpesa, card and credit — a Glovo payment would be rejected by the database and the
order would sit unsynced with a constraint violation nobody can read from the till.

---

## 1. Glovo

Appears in the payment modal as **🛵 Glovo**, with a reference field for the Glovo
order number. Gets its own line in the Daily Sales Report collection breakup and
in the Z-report.

**The part that matters: Glovo money never touches the drawer**, and nothing
counts it as if it did.

Both cash calculations filter on `method = 'cash'` specifically —
`computeZReport` uses `m.method === 'cash'`, the server uses
`.eq('method', 'cash')`. So a new method is correctly ignored by cash
reconciliation the moment it exists.

That is worth stating because the opposite design — "everything except card and
mpesa is cash" — would have silently counted Glovo into the drawer and reported a
shortage equal to the day's Glovo takings. Verified: with 100 cash and 500 glovo,
expected cash reads 100 and total collections read 600.

It is listed explicitly in the report rather than left to the catch-all, so
aggregator income can be reconciled against what Glovo actually settles.

**Note on Glovo vs order type.** A Glovo sale is a DELIVERY settled BY GLOVO —
two separate facts. Your previous system printed "Type: Glovo" and lost the
second half, which is why its collection breakup could not separate aggregator
money from cash. Set order type to Delivery and payment to Glovo and both are
recorded.

## 2. Order-type row

`Dine in / Takeaway / Delivery` shared a flex line with Pax and the table pill —
five controls in a narrow panel — so the buttons squeezed until "Dine in" wrapped
and "Takeaway"/"Delivery" ran together. My Pax field caused it.

The toggle now has its own full-width row; Pax, table and rider name sit beneath.

## 3. "9 failed" now says why

It had been there since v0.2.3. Retry worked — it re-armed the rows, they failed
again for the same reason, the count never moved, so it read as a dead button.

- **Hover** shows the actual error and how long it has been stuck.
- **Clicking** retries and reports the outcome: `All 9 sent.` or
  `Still failing: <reason>`.

**Please hover it and send me that line.** It decides whether those nine can be
cleared or point at something real.

## Verified

9 assertions on migration 46 against real PostgreSQL, including that glovo was
rejected before and accepted after, that unknown methods are still refused, and
that glovo stays out of the cash total. All three type-checks and the build clean.
