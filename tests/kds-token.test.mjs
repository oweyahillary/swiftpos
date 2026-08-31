/**
 * kds-token.test.mjs — A3 fault 1 (per-branch KDS display token).
 *
 * A headless /kds display authenticates with a long-lived, branch-scoped SwiftPOS
 * JWT marked surface:'kds'. Two guarantees this test locks:
 *   1. the kitchen router MINTS it (owner-only, branch-validated, surface:'kds'),
 *      and ACCEPTS it (sets branch from the token) before falling back to requireAuth;
 *   2. requireAuth REJECTS surface:'kds' everywhere else — so a leaked kitchen-screen
 *      token cannot read orders/payments/anything but its branch's tickets.
 * Source-level (mirrors owner-void-refund.test.mjs): removing the mint, the accept,
 * or the confinement fails the test.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitchen = fs.readFileSync(path.join(root, 'apps/server/src/routes/kitchen.ts'), 'utf8');
const auth    = fs.readFileSync(path.join(root, 'apps/server/src/middleware/auth.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('kitchen: mints an owner-only, branch-scoped kds token', () => {
  assert.match(kitchen, /\/kds-token/, 'mint route /kds-token must exist');
  assert.match(kitchen, /if \(!req\.isOwner\)/, 'mint must be owner-only');
  assert.match(kitchen, /surface:\s*'kds'[\s\S]*?jwt\.sign|jwt\.sign\([\s\S]*?surface:\s*'kds'/,
    'mint must sign a surface:kds token');
  assert.match(kitchen, /business_id.*req\.businessId|eq\('business_id',\s*req\.businessId\)/,
    'mint must validate the branch belongs to the caller business');
});

ok('kitchen: accepts a kds token and derives its branch', () => {
  assert.match(kitchen, /p\.surface === 'kds'/, 'router must detect a kds token');
  assert.match(kitchen, /req\.branchId\s*=\s*p\.branchId/, 'kds branch comes from the token, not the query');
  assert.match(kitchen, /return requireAuth\(req, res, next\)/, 'non-kds callers still go through requireAuth');
});

ok('auth: confines kds tokens out of every other route', () => {
  assert.match(auth, /req\.surface === 'kds'/, 'requireAuth must check for a kds token');
  assert.match(auth, /req\.surface === 'kds'[\s\S]{0,200}?res\.status\(403\)/,
    'requireAuth must 403 a kds token (it is only valid on the kitchen router)');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
