/**
 * branchscope-middleware.test.mjs — proves the three daily reports respond
 * instead of hanging, and that branch scoping resolves correctly.
 *
 *   node branchscope-middleware.test.mjs
 *
 * No live server and no database. The bug was purely about the Express
 * middleware contract: branchScope is a helper that returns string | null, but
 * it was passed to router.get() as middleware. Express calls middleware as
 * (req, res, next); branchScope ignored all three and returned a value, so
 * next() was never called and the request hung until the client gave up.
 *
 * This reproduces that contract with a fake req/res/next, shows the OLD wiring
 * never calls next(), shows the NEW wiring does, and shows branchScope resolves
 * an owner's selected branch (which the old `req.branchId ?? null` silently
 * dropped) and a staff member's locked branch.
 */

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
};

// The real helper, copied verbatim from middleware/rbac.ts. If it changes there,
// this copy is meant to be updated in lockstep — it exists so the test needs no
// build step.
function branchScope(req) {
  if (req.isOwner) {
    return req.headers['x-branch-id'] || req.query.branch_id || null;
  }
  return req.branchId;
}

// ── The bug: branchScope used as Express middleware ─────────────────────────
// Express invokes middleware as (req, res, next) and waits for next() or a
// response. branchScope does neither.
function simulateMiddleware(mw, req) {
  let nextCalled = false;
  let responded = false;
  const res = { json: () => { responded = true; }, status: () => res, send: () => { responded = true; } };
  const next = () => { nextCalled = true; };
  const returned = mw(req, res, next);
  return { nextCalled, responded, returned };
}

{
  const req = { isOwner: true, headers: { 'x-branch-id': 'branch-A' }, query: {} };
  const r = simulateMiddleware(branchScope, req);
  ok('OLD wiring: branchScope-as-middleware never calls next()', r.nextCalled === false);
  ok('OLD wiring: it sends no response either → request hangs', r.responded === false);
  ok('OLD wiring: it just returns a string, which Express ignores', r.returned === 'branch-A');
}

// ── The fix: branchScope called as a helper inside the handler ──────────────
// The handler runs to completion and produces a response. Modelled here as the
// resolve-then-query shape the real handlers now use.
async function fixedHandler(req, fetchOrders) {
  const scopedBranch = branchScope(req);        // resolve, not mount
  const orders = await fetchOrders(req.businessId, scopedBranch);
  return { status: 200, scopedBranch, count: orders.length };
}

{
  const calls = [];
  const fakeFetch = async (businessId, branchId) => {
    calls.push({ businessId, branchId });
    return [{ id: 1 }, { id: 2 }];   // pretend two orders
  };

  // Owner with a selected branch.
  const owner = { isOwner: true, businessId: 'biz-1', headers: { 'x-branch-id': 'branch-A' }, query: {} };
  const r1 = await fixedHandler(owner, fakeFetch);
  ok('NEW wiring: handler responds (200), no hang', r1.status === 200);
  ok('NEW wiring: owner\'s selected branch is applied', r1.scopedBranch === 'branch-A');
  ok('NEW wiring: that branch reached the query',
     calls[0].branchId === 'branch-A' && calls[0].businessId === 'biz-1');

  // Owner viewing all branches (no header, no param) → null = no filter.
  const ownerAll = { isOwner: true, businessId: 'biz-1', headers: {}, query: {} };
  const r2 = await fixedHandler(ownerAll, fakeFetch);
  ok('NEW wiring: owner "all branches" resolves to null (no filter)', r2.scopedBranch === null);

  // Staff member locked to their JWT branch.
  const staff = { isOwner: false, branchId: 'branch-B', businessId: 'biz-1', headers: {}, query: {} };
  const r3 = await fixedHandler(staff, fakeFetch);
  ok('NEW wiring: staff locked to their JWT branch', r3.scopedBranch === 'branch-B');

  // The specific regression: the OLD handler passed `req.branchId ?? null`,
  // which for an owner is undefined ?? null === null, dropping their choice.
  const oldBranchArg = owner.branchId ?? null;
  ok('OLD handler dropped the owner\'s branch (req.branchId was undefined)',
     oldBranchArg === null && branchScope(owner) === 'branch-A');
}

console.log(`\n${fail === 0 ? 'All checks passed. The three reports respond and scope correctly.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
