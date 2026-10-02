/**
 * approver.test.mjs — A355 (2026-09-28): a manager approves a void or refund with their OWN sign-in PIN.
 *
 * Owner, on v0.6.17 (M4): the till's refund refused the manager's PIN ("Invalid supervisor PIN") — it wanted a second,
 * separate override PIN. → "manager can replace that role", "3 is okay": approve with the manager's own PIN; override
 * PINs and the legacy business supervisor PIN keep working.
 *
 *   node tests/approver.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED apps/server/dist/lib/approver.js with real bcrypt hashes (apps/server's bcrypt), then pins that
 * routes/orders.ts wires it into BOTH the void and the refund handler with the legacy fallback and one clear refusal.
 *
 * MUTATIONS TO CONFIRM BITE: drop the `mayApprove` filter on sign-in PINs → "a cashier's PIN never approves" fails; let
 * user_permissions not override the role → "a revoked orders.void" fails; skip the override loop → "override PINs still
 * work" fails; return 'none' when only sign-in PINs exist → "none only when nobody can approve" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist/lib/approver.js');
if (!fs.existsSync(DIST)) {
  console.log('\nCannot load apps/server/dist/lib/approver.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
const require = createRequire(DIST);
const A = require(DIST);
const bcrypt = require('bcrypt');

let pass = 0, fail = 0;
const ok = async (name, f) => {
  try { await f(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const h = (pin) => bcrypt.hashSync(pin, 4);
const role = (name, keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const checks = { loginPin: (p, x) => bcrypt.compare(p, x), overridePin: (p, x) => bcrypt.compare(p, x) };

const OWNER = 'u-owner';
const rows = [
  { id: OWNER, pin_hash: h('1111'), roles: role('owner', []) },
  { id: 'u-mgr', pin_hash: h('2222'), roles: role('Manager', ['orders.create', 'orders.void']) },
  { id: 'u-cash', pin_hash: h('3333'), roles: role('Cashier', ['orders.create']) },
  { id: 'u-mgr-revoked', pin_hash: h('4444'), roles: role('Manager', ['orders.void']),
    user_permissions: [{ granted: false, permissions: { key: 'orders.void' } }] },
  { id: 'u-cash-granted', pin_hash: h('5555'), roles: role('Cashier', ['orders.create']),
    user_permissions: [{ granted: true, permissions: { key: 'orders.void' } }] },
  { id: 'u-sup', pin_hash: h('6666'), override_pin_hash: h('9090'), roles: role('Supervisor', ['orders.void']) },
];
const find = (pin, extra = {}) => A.findApprover(rows, { pin, ownerId: OWNER, ...extra }, checks);

await ok('a manager approves with their OWN sign-in PIN — recorded as that person', async () => {
  assert.deepEqual(await find('2222'), { result: 'ok', userId: 'u-mgr', via: 'pin' });
});
await ok('the owner approves with their sign-in PIN', async () => {
  assert.deepEqual(await find('1111'), { result: 'ok', userId: OWNER, via: 'pin' });
});
await ok('a cashier\'s PIN never approves (and is not reported as anyone\'s)', async () => {
  assert.deepEqual(await find('3333'), { result: 'invalid' });
});
await ok('a revoked orders.void (per-person) beats the role — that manager cannot approve', async () => {
  assert.deepEqual(await find('4444'), { result: 'invalid' });
});
await ok('a per-person orders.void grant lets that cashier approve', async () => {
  assert.deepEqual(await find('5555'), { result: 'ok', userId: 'u-cash-granted', via: 'pin' });
});
await ok('override PINs set before 0.6.18 still work (checked first)', async () => {
  assert.deepEqual(await find('9090'), { result: 'ok', userId: 'u-sup', via: 'override' });
  assert.deepEqual(await find('6666'), { result: 'ok', userId: 'u-sup', via: 'pin' }, 'and that person\'s sign-in PIN too');
});
await ok('a wrong or empty PIN is invalid', async () => {
  assert.deepEqual(await find('0000'), { result: 'invalid' });
  assert.deepEqual(await find(''), { result: 'invalid' });
  assert.deepEqual(await find(undefined), { result: 'invalid' });
});
await ok('a picked approver (authorizer_id) is the only one checked', async () => {
  assert.deepEqual(await find('2222', { authorizerId: 'u-mgr' }), { result: 'ok', userId: 'u-mgr', via: 'pin' });
  assert.deepEqual(await find('2222', { authorizerId: 'u-sup' }), { result: 'invalid' });
});
await ok('"none" only when nobody can approve with a PIN (the caller then tries the legacy business PIN)', async () => {
  assert.deepEqual(await A.findApprover([rows[2]], { pin: '3333', ownerId: OWNER }, checks), { result: 'none' });
  assert.deepEqual(await A.findApprover([{ id: 'u-mgr', pin_hash: null, roles: role('Manager', ['orders.void']) }],
    { pin: '2222', ownerId: OWNER }, checks), { result: 'none' }, 'a manager with no PIN cannot approve by PIN');
  assert.equal((await A.findApprover([rows[1]], { pin: 'x', ownerId: OWNER }, checks)).result, 'invalid');
});
await ok('mayApprove: owner id, owner/admin role, "*", orders.void — never a plain cashier', async () => {
  assert.equal(A.mayApprove({ id: 'x', roles: role('Admin', []) }, OWNER), true);
  assert.equal(A.mayApprove({ id: 'x', roles: role('Custom', ['*']) }, OWNER), true);
  assert.equal(A.mayApprove({ id: OWNER, roles: null }, OWNER), true);
  assert.equal(A.mayApprove(rows[2], OWNER), false);
});

// ── The routes use it: both handlers, legacy fallback, one clear refusal ──────────────────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
const body = (marker) => { const i = src.indexOf(marker); const rest = src.slice(i + marker.length); return rest.slice(0, rest.indexOf('router.post(')); };
await ok('orders.ts: verifyOverrideAuthorizer asks findApprover with the real sign-in PIN check and the business owner', async () => {
  assert.match(src, /import \{ verifyPin \} from '\.\/auth';/);
  assert.match(src, /findApprover\(\(rows \?\? \[\]\) as ApproverRow\[\], \{ pin, authorizerId, ownerId: \(biz as any\)\?\.owner_id \?\? null \}/);
  assert.match(src, /loginPin:\s+async \(p, h\) => \(await verifyPin\(p, h, businessId\)\)\.valid/);
});
await ok('void AND refund: legacy business PIN still accepted; otherwise one clear refusal (no "Invalid supervisor PIN")', async () => {
  for (const m of ["router.post('/:id/void'", "router.post('/:id/refund'"]) {
    const b = body(m);
    assert.match(b, /const legacy = await verifySupervisorPin\(req\.businessId, pin\);\s+if \(legacy !== true\) \{/, m);
    assert.match(b, /res\.status\(403\)\.json\(APPROVER_PIN_REFUSED\)/, m);
    assert.ok(!/Invalid supervisor PIN/.test(b), m);
  }
  assert.match(src, /error: 'That PIN was not recognised\. Enter the PIN of a manager \(or the owner\) on duty\.'/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
