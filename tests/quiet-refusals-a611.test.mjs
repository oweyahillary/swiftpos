/**
 * quiet-refusals-a611.test.mjs — A611: a refused request, or one that changed nothing, no longer makes the server forget
 * what it remembers for the business.
 *
 * Owner, 2026-10-30 (the System page's Supabase card: 22,432 calls a day of the 15,000 target, GET /api/pos/branch-drawers
 * 6,575 calls for 2,564 asks with BRANCH_DRAWERS_MEMO_S=300 set; POST /api/day-close/ack 1,145 a day, yet one ack landed
 * in three days): every non-GET request moved its business's write generation (lib/writeActivity.ts) unless it was
 * refused with no business — so a POS posting an ack that matched nothing, or was refused, made every remembered answer
 * of its business (the branch drawers above all) read again on the next ask.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/quiet-refusals-a611.test.mjs
 *
 * RUNS the COMPILED trackWrites() middleware with a fake request / response; pins routes/day-close.ts.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - the status check back to `!b && (…)`              → "a refused request of a signed-in business" fails
 *   - the forgetNothing line removed from trackWrite     → "a route that says it changed nothing" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/writeActivity.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const WA = require(path.join(DIST, 'lib/writeActivity.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const B = 'biz-krunch', OTHER = 'biz-other';
const track = WA.trackWrites();
/** One request through the middleware, finished with `status` (and the route's res.locals). */
const run = ({ method = 'POST', url = '/api/day-close/ack', businessId = B, status = 200, locals = {} } = {}) => {
  const res = Object.assign(new EventEmitter(), { statusCode: status, locals });
  const req = { method, originalUrl: url, url, businessId };
  let nexted = false;
  track(req, res, () => { nexted = true; });
  assert.ok(nexted, 'the middleware always lets the request through');
  res.emit('finish');
};
const reset = () => { WA._resetWrites(); WA._setTracking(true); };

console.log('A611 — refusals and no-change requests leave the remembered answers alone\n');

ok('a write that succeeds still moves its business (and only its business)', () => {
  reset();
  const before = WA.writeGen(B), other = WA.writeGen(OTHER);
  run({ status: 200 });
  assert.notEqual(WA.writeGen(B), before);
  assert.equal(WA.writeGen(OTHER), other);
});

ok('a refused request of a signed-in business (401 / 403 / 429) moves nothing', () => {
  reset();
  const before = WA.writeGen(B);
  for (const status of [401, 403, 429]) run({ status });
  assert.equal(WA.writeGen(B), before);
});

ok('a refused request with no business still moves nothing (as before)', () => {
  reset();
  const before = WA.writeGen(B);
  run({ businessId: undefined, status: 401 });
  assert.equal(WA.writeGen(B), before);
});

ok('a route that says it changed nothing (res.locals.forgetNothing) moves nothing', () => {
  reset();
  const before = WA.writeGen(B);
  run({ status: 200, locals: { forgetNothing: true } });
  assert.equal(WA.writeGen(B), before);
});

ok('other failures still count (a 409 or a 5xx may have written part of a change)', () => {
  for (const status of [400, 409, 500, 503]) {
    reset();
    const before = WA.writeGen(B);
    run({ status });
    assert.notEqual(WA.writeGen(B), before, String(status));
  }
});

ok('a GET is never a write', () => {
  reset();
  const before = WA.writeGen(B);
  run({ method: 'GET', url: '/api/pos/branch-drawers' });
  assert.equal(WA.writeGen(B), before);
});

ok('day-close ack: the "still waiting" note and an ack that matched nothing say forgetNothing', () => {
  const dc = read('apps/server/src/routes/day-close.ts');
  assert.match(dc, /if \(wErr\) \{ sendError\(res, wErr\); return; \}\s*\/\/ A611[^\n]*\n\s*res\.locals\.forgetNothing = true;\s*res\.json\(\{ \.\.\.\(still/);
  assert.match(dc, /if \(!data\) res\.locals\.forgetNothing = true;\s*res\.json\(data \?\? \{ id: instructionId/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
