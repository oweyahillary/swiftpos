# Fix: three daily reports hang (finding #4)

`GET /api/reports/export/daily`, `/hourly` and `/audit` never respond. The file
that holds them calls itself "the three reports a restaurant actually reads."

## Files in this bundle

    apps/server/src/routes/reports-daily.ts        the three handlers, fixed
    tests/branchscope-middleware.test.mjs          proof, runnable standalone

The `.ts` is the WHOLE file — drop it over the existing one. Only this file was
edited this session. No migration, no other files.

## What was wrong

Two bugs, one line each, in all three handlers.

1. HANG. The route was declared:

       router.get('/daily', branchScope, async (req, res) => { ... })

   `branchScope` is a HELPER with the signature `(req) => string | null`, not
   middleware. Express calls a middleware argument as `(req, res, next)` and
   waits for it to call `next()` or send a response. `branchScope` did neither —
   it returned a string, which Express discards — so the request hung until the
   client timed out. `reports-export.ts`, two files over, uses the SAME helper
   correctly: `const scopedBranch = branchScope(req)` inside the handler.

2. WRONG BRANCH. Even the body was scoping wrong:

       const orders = await fetchOrders(req.businessId, req.branchId ?? null, ...)

   For an OWNER, `req.branchId` is undefined, so this is always `null` — every
   owner got "all branches" and their selected branch was silently ignored.
   `branchScope(req)` is exactly the function that resolves this: owner's
   `X-Branch-Id` header, or their `branch_id` query param, or null for "all";
   staff always locked to their JWT branch.

## The fix

Each handler drops `branchScope` from the `router.get(...)` argument list and
calls it inside instead:

    router.get('/daily', async (req, res) => {
      ...
      const scopedBranch = branchScope(req);
      const orders = await fetchOrders(req.businessId, scopedBranch, start, end);

`fetchOrders` already accepted a branch argument and filtered on it correctly —
it was simply being handed the wrong value. So both bugs close with the same
three-line change in each of the three handlers.

I checked every other route that imports `branchScope`
(tables, expenses, inventory, parking, orders, reports, reports-export, shifts):
all of them already call it as a function. reports-daily was the only file that
mounted it as middleware.

## Test — no server, no database

    node tests/branchscope-middleware.test.mjs

It reproduces the Express middleware contract with a fake req/res/next, shows the
OLD wiring never calls next() (the hang), shows the NEW wiring responds, and
shows branch scope resolving correctly for an owner-with-branch, an owner-all,
and a staff member — including the specific regression where the old
`req.branchId ?? null` dropped the owner's choice.

Expected: 9 PASS, exit 0.

## Do you need to build the desktop app?

No. Server-only, like the stock fix. This is a deploy of one route file — no
migration, no schema change, no desktop rebuild. After deploying, hit each of
the three endpoints once (they return xlsx or csv) and confirm they respond
rather than time out, and that as an owner with a branch selected you get that
branch's numbers rather than every branch's.
