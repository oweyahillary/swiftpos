/**
 * owner-resolve.test.mjs — 2026-10-02: the admin portal's "Enrol till" on a newly registered client said "Could not
 * resolve the business owner for this code" (an older test client worked). The owner was matched ONLY on the business's
 * contact email, which is not the owner's sign-in email when self-signup was given a separate contact email or the owner
 * changed it in Settings › Business › Profile. Runs the real rule (apps/server/dist/lib/ownerBusiness.js pickOwnerUserId).
 *
 * MUTATIONS TO CONFIRM BITE: drop the sign-in email step → "a contact email that is not the owner's" fails; take the
 * first of two users sharing an email → "never guess between two people" fails; drop the owner-role fallback → "no email
 * matches: the business's one owner" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/ownerBusiness.js'))) {
  console.log('\nCannot load apps/server/dist/lib/ownerBusiness.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { pickOwnerUserId } = require(path.join(DIST, 'lib/ownerBusiness.js'));

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const users = [
  { id: 'u-owner',   email: 'Jane@Fries.co.ke',   status: 'active', role_name: 'owner' },
  { id: 'u-manager', email: 'manager@fries.co.ke', status: 'active', role_name: 'manager' },
];

ok('the owner is found by their SIGN-IN email (case and spaces ignored)', () => {
  assert.equal(pickOwnerUserId(users, { authEmail: ' jane@fries.co.ke ', businessEmail: 'info@fries.co.ke' }), 'u-owner');
});
ok('a contact email that is not the owner\'s no longer blocks it (the new client\'s case)', () => {
  // The owner's staff record is not on the 'owner' role here, so only the sign-in email can find it.
  const noRole = [{ id: 'u-owner', email: 'jane@fries.co.ke', status: 'active', role_name: 'admin' }, users[1]];
  assert.equal(pickOwnerUserId(noRole, { authEmail: 'jane@fries.co.ke', businessEmail: 'orders@fries.co.ke' }), 'u-owner');
});
ok('clients that worked before still resolve by the business email', () => {
  assert.equal(pickOwnerUserId(users, { authEmail: null, businessEmail: 'jane@fries.co.ke' }), 'u-owner');
});
ok('no email matches: the business\'s one active owner', () => {
  assert.equal(pickOwnerUserId(users, { authEmail: 'x@y.z', businessEmail: 'info@fries.co.ke' }), 'u-owner');
});
ok('never guess between two people: two users on one email, or two owners, resolve to nobody', () => {
  const twin = [{ id: 'u-twin', email: 'jane@fries.co.ke', status: 'active', role_name: 'cashier' }, ...users];
  assert.equal(pickOwnerUserId(twin, { authEmail: 'jane@fries.co.ke', businessEmail: null }), 'u-owner',
    'two matches on the email fall through to the single owner-role user');
  const twoOwners = [...users, { id: 'u-owner2', email: 'b@fries.co.ke', status: 'active', role_name: 'owner' }];
  assert.equal(pickOwnerUserId(twoOwners, { authEmail: 'none@x.y', businessEmail: null }), null);
});
ok('an inactive owner is not taken by the fallback', () => {
  assert.equal(pickOwnerUserId([{ id: 'u-old', email: 'a@b.c', status: 'inactive', role_name: 'owner' }], { authEmail: null, businessEmail: null }), null);
});
ok('A415: an enrolment code needs no owner — a till joins as itself, so a client whose owner cannot be resolved still gets codes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/admin.ts'), 'utf8');
  const issue = src.split("/branches/:branchId/enrol-code'")[1].split('router.get(')[0];
  assert.ok(!/resolveOwnerUserId|NO_OWNER/.test(issue));
});
ok('the admin portal shows the enrolment error beside the branches', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'apps/admin/src/AdminPortal.tsx'), 'utf8');
  assert.match(ui, /catch\(e\) \{ setEnrolError\(`\$\{branch\.name\}: \$\{e\.message\}`\); \}/);
  // A393: one Branches & tills tab now (the overview's copy of the branch list is gone) — shown once, beside it.
  assert.equal((ui.match(/data-testid="enrol-error"/g) || []).length, 1);
  assert.match(ui, /\{enrolPanel\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
