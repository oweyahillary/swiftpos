/**
 * staff-roster-cloud.test.mjs — A446: the cloud gives EVERY till of a branch its staff list (it was the branch server
 * only), with a version so a till asking every few seconds is told "unchanged", and binds a till the cloud had no branch
 * for (it used to answer "this device is not bound to a branch" — and the server silently never got the list: new
 * cashiers were "not recognised"). RUNS the built route (apps/server/dist routes/pos.js) over real HTTP against an
 * in-memory database, with real till sessions (A415).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/staff-roster-cloud.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: the route back to branch-server-only → "a plain till gets its branch's list" fails; no
 * binding from the till's session → "a till the cloud had no branch for" fails; the version ignored → "unchanged" fails;
 * a retired till served → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
if (!fs.existsSync(path.join(DIST, 'routes/pos.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const syncVersions = require(path.join(DIST, 'lib/syncVersions.js'));   // A528

const BZ = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222', K = '33333333-3333-4333-8333-333333333333';
const hash = (n) => `$2a$04$${String(n).padEnd(53, 'x')}`;
const user = (id, name, branches, extra = {}) => ({ id, business_id: BZ, name, status: 'active', pin_hash: hash(id), override_pin_hash: null,
  roles: { name: 'cashier', role_permissions: [{ permissions: { key: 'orders.create' } }] }, user_branches: branches.map((b) => ({ branch_id: b })),
  user_permissions: [], ...extra });
let db;
const reset = () => {
  db = {
    user_devices: [
      { business_id: BZ, device_id: 'dev-server', device_role: 'node', branch_id: W, status: 'approved', retired_at: null },
      { business_id: BZ, device_id: 'dev-bar', device_role: 'till', branch_id: W, status: 'approved', retired_at: null },
      { business_id: BZ, device_id: 'dev-new', device_role: 'till', branch_id: null, status: 'approved', retired_at: null, id: 'row-new' },
      { business_id: BZ, device_id: 'dev-old', device_role: 'till', branch_id: W, status: 'approved', retired_at: '2026-10-01T00:00:00Z' },
    ],
    users: [user('u-amy', 'Amy', [W]), user('u-kim', 'Kim', [K]), user('u-mary', 'Mary', []), user('u-gone', 'Gone', [W], { status: 'inactive' })],
    // A528: the staff version (migration 150) — the triggers bump it when staff change; this test bumps it by hand.
    sync_versions: [{ business_id: BZ, topic: 'staff', version: 1 }],
  };
};
reset();
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every((fn) => fn(r)));
  const run = () => { if (op === 'update') { const h = rows(); h.forEach((r) => Object.assign(r, payload)); return h; } return rows(); };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'update') return (row) => { op = 'update'; payload = row; return q; };
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const d = run()[0]; return Promise.resolve(d ? { data: d, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tillToken = (device, branch) => jwt.sign({ userId: null, deviceId: device, till: true, businessId: BZ, branchId: branch, isOwner: false,
  permissionKeys: [], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET);
const ask = async (device, branch, v = '') => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/pos/branch-staff${v ? `?v=${v}` : ''}`,
    { headers: { Authorization: `Bearer ${tillToken(device, branch)}`, 'x-device-id': device } });
  return { status: r.status, body: await r.json() };
};

await ok('a plain till (not only the branch server) gets its branch\'s list', async () => {
  const r = await ask('dev-bar', W);
  const names = (r.body.staff ?? []).map((s) => s.name).sort().join(',');
  assert(r.status === 200 && r.body.branch_id === W && names === 'Amy,Mary', `${r.status} ${JSON.stringify(r.body)}`);
});
await ok('…only its branch: Kim (another branch) and Gone (deactivated) are not sent; Mary (no branch = every branch) is', async () => {
  const r = await ask('dev-bar', W);
  assert(!r.body.staff.some((s) => s.name === 'Kim' || s.name === 'Gone') && r.body.staff.some((s) => s.name === 'Mary'));
});
await ok('the branch server still gets it', async () => { const r = await ask('dev-server', W); assert(r.status === 200 && r.body.staff.length === 2); });
await ok('a till asking again with the version it holds is told "unchanged" (nothing to store)', async () => {
  const first = await ask('dev-bar', W);
  const again = await ask('dev-bar', W, first.body.version);
  assert(again.body.unchanged === true && !again.body.staff && again.body.version === first.body.version, JSON.stringify(again.body));
});
await ok('…a change (a new cashier) changes the version and sends the list', async () => {
  const first = await ask('dev-bar', W);
  db.users.push(user('u-abdi', 'Abdi', [W]));
  db.sync_versions[0].version++;   // A528: what the users trigger does
  syncVersions.forgetTopic(BZ);     // A528: …seen after 15 s, or at once when the cashier is added through this server
  const r = await ask('dev-bar', W, first.body.version);
  assert(!r.body.unchanged && r.body.staff.some((s) => s.name === 'Abdi') && r.body.version !== first.body.version, JSON.stringify(r.body).slice(0, 200));
});
await ok('a till the cloud had no branch for is bound to its session\'s branch and gets the list (before: "not bound to a branch")', async () => {
  const r = await ask('dev-new', W);
  assert(r.status === 200 && r.body.branch_id === W && db.user_devices.find((d) => d.device_id === 'dev-new').branch_id === W, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
});
await ok('a retired till gets nothing', async () => {
  const r = await ask('dev-old', W);
  assert(r.status === 401 || r.status === 403, `${r.status}`);
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
