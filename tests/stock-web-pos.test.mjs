/**
 * stock-web-pos.test.mjs — A346 (2026-09-27): the cloud tells the till whether the business has the web POS, so the till
 * shows its Stock screen only then.
 *
 * Owner: "stock should not appear in the desktop app thats a web pos feature pro feature" → "stock should only appear if the
 * web pos is enabled"; asked when a lapsed subscription hides it: "While web is fully usable" (active or grace — not the
 * reports-only week, not never-subscribed, not suspended).
 *
 *   node tests/stock-web-pos.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED GET /api/pos/init behind the real auth middleware over HTTP (database in memory; JWTs signed with a
 * per-run random secret) and reads `webPosEnabled` for each web-access state. The till's side is
 * apps/desktop/test/stock-web-pos.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - webPosEnabled = canLogin (not fullAccess)       → "reports-only week → no" fails
 *   - webPosEnabled left out of the response          → every "→ yes" check fails
 *   - the business's status not passed (suspended)    → "a suspended business → no" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/pos.js'))) {
  console.log('\nCannot load apps/server/dist/routes/pos.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 3600 * 1000;
const db = {
  businesses: [{ id: BZ, name: 'B Foods', type: 'restaurant', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active', web_access_expires_at: null }],
  branches: [{ id: BR, business_id: BZ, name: 'Main', is_main: true, desktop_licensed: true }],
  feature_flags: [],
  user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null }],   // A415: the till, on the business
};
// A permissive in-memory stand-in: every builder method chains; filters apply to the rows the tables above hold, and any
// other table reads as empty.
supabase.from = (table) => {
  const f = [];
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = rows(); return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
      return () => q;   // select, order, is, not, or, limit, range, gte, lte …
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const init = async () => {
  // A415: the till's own session — no person.
  const t = jwt.sign({ userId: null, deviceId: 'dev-T1', till: true, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pos/init?branch_id=${BR}`, { headers: { Authorization: `Bearer ${t}`, 'x-device-id': 'dev-T1' } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const setAccess = ({ flag = null, expiresInDays = null, status = 'active' }) => {
  db.feature_flags = flag === null ? [] : [{ business_id: BZ, key: 'web_hosting', enabled: flag }];
  db.businesses[0].web_access_expires_at = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY).toISOString();
  db.businesses[0].status = status;
};

try {
  await ok('never subscribed to the web → no (the till hides Stock)', async () => {
    setAccess({});
    const r = await init();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.webPosEnabled, false);
  });
  await ok('the web_hosting flag on (no renewal date yet) → yes', async () => {
    setAccess({ flag: true });
    assert.equal((await init()).body.webPosEnabled, true);
  });
  await ok('a paid renewal date in the future → yes', async () => {
    setAccess({ expiresInDays: 200 });
    assert.equal((await init()).body.webPosEnabled, true);
  });
  await ok('expired 10 days ago (grace — web still fully usable) → yes', async () => {
    setAccess({ expiresInDays: -10 });
    assert.equal((await init()).body.webPosEnabled, true);
  });
  await ok('expired 25 days ago (reports-only week) → no', async () => {
    setAccess({ expiresInDays: -25 });
    assert.equal((await init()).body.webPosEnabled, false);
  });
  await ok('expired 40 days ago (web locked) → no', async () => {
    setAccess({ expiresInDays: -40 });
    assert.equal((await init()).body.webPosEnabled, false);
  });
  await ok('a suspended business → no, whatever its dates', async () => {
    setAccess({ expiresInDays: 200, status: 'suspended' });
    assert.equal((await init()).body.webPosEnabled, false);
  });
  await ok('the till still gets its catalogue either way (only the one field differs)', async () => {
    setAccess({});
    const r = await init();
    assert.ok(Array.isArray(r.body.products) && 'themeId' in r.body && 'receiptHeader' in r.body, Object.keys(r.body).join(','));
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
