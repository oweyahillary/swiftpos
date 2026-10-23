// A533 — ZapTill support pulls a till's (or a branch server's) log from the admin portal: the cloud's side.
//
// Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
// investigating such issues" — and, on the admin portal's Desktop updates tab: "how do I pull logs".
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/log-requests-a533.test.mjs
//
// RUNS the COMPILED routers (routes/logRequestsAdmin.ts, routes/support.ts) behind the REAL auth middleware (admin
// tokens, till tokens, person tokens) over HTTP, with the REAL /admin write hook (lib/forgetOnWrite.ts) in front; the
// database in memory (tests/lib-memdb.mjs); the push channel's sockets as stand-ins (liveHub _addTestConn).
//
//   C  create: a super admin and an agent may; a business's own token, a till's token refused; a device of another
//      business (404), retired / not approved (409); the reason required and cleaned; the range only 24/72/168; audited
//      in admin_audit_log; 20 per admin per hour (429, another admin not held back); a till too old to answer is noted.
//   D  the doorbell: that business's sockets hear { type: 'log_request', device_id } — another business's never; the
//      /admin write hook does not make every socket sign in again for a log request.
//   M  GET /api/support/log-requests/mine: the till's own session only; only ITS waiting requests (another till's,
//      another business's, a cancelled / delivered one never).
//   U  the upload with request_id: linked to the stored log and marked delivered (not counted against the 5 an hour);
//      another till cannot answer it (403); a cancelled / delivered / expired one is refused (409); unknown (404).
//   X  cancel (waiting only; audited); expiry after 7 days (on the admin list, on /mine, on the upload).
//   L  the admin list: newest first, the device's label, version and last seen, the linked log's reference; the devices.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - support.ts /mine without .eq('device_id', …)                       → M "only ITS waiting requests" fails
//   - support.ts upload without the device check                          → U "another till cannot answer it" fails
//   - support.ts upload not marking the request delivered                 → U "linked … delivered" fails
//   - logRequestsAdmin.ts without the per-admin hour count                → C "20 per admin per hour" fails
//   - logRequestsAdmin.ts device looked up without the business            → C "a device of another business" fails
//   - liveHub ringLogRequest ringing every business                        → D "another business's never" fails
//   - lib/logRequests.ts expireWaiting not called / wrong comparison       → X "expiry" fails
//   - forgetOnWrite ignoring res.locals.forgetNothing                      → D "does not make every socket sign in again" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/logRequestsAdmin.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const hub = require(path.join(DIST, 'lib/liveHub.js'));
const LR = require(path.join(DIST, 'lib/logRequests.js'));
const { forgetOnWrite } = require(path.join(DIST, 'lib/forgetOnWrite.js'));
const { forgetAdmin } = require(path.join(DIST, 'middleware/adminAuth.js'));

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-9999-4999-8999-999999999999', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CASH = 'aaaaaaaa-0000-4000-8000-000000000003';
const AGENT = 'bbbbbbbb-0000-4000-8000-000000000001', SUPER = 'bbbbbbbb-0000-4000-8000-000000000002', AGENT2 = 'bbbbbbbb-0000-4000-8000-000000000003';
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  forgetAdmin();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'KRUNCH', currency: 'KES' }, { id: B2, owner_id: OWNER, name: 'Other', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', desktop_licensed: true }],
    users: [{ id: CASH, name: 'Joe', status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], roles: { name: 'Cashier', role_permissions: [{ permissions: { key: 'orders.create' } }] } }],
    user_branches: [], feature_flags: [], refresh_tokens: [],
    user_devices: [
      { id: 'd1', business_id: B, branch_id: BR, device_id: 'dev-T1', device_label: 'Front till', terminal_code: 'T1', device_role: 'till', status: 'approved', app_version: '1.0.20', last_seen_at: '2026-10-20T11:02:00Z' },
      { id: 'd2', business_id: B, branch_id: BR, device_id: 'dev-T2', device_label: 'Bar', terminal_code: 'T2', device_role: 'till', status: 'approved', app_version: '1.0.5', last_seen_at: '2026-10-20T10:00:00Z' },
      { id: 'd3', business_id: B, branch_id: BR, device_id: 'dev-SRV', device_label: 'Server', terminal_code: 'S1', device_role: 'node', status: 'approved', app_version: '1.0.20' },
      { id: 'd4', business_id: B, branch_id: BR, device_id: 'dev-gone', terminal_code: 'T4', status: 'approved', retired_at: '2026-09-01T00:00:00Z' },
      { id: 'd5', business_id: B, branch_id: BR, device_id: 'dev-wait', terminal_code: 'T5', status: 'pending' },
      { id: 'd6', business_id: B2, branch_id: null, device_id: 'dev-other', terminal_code: 'X1', status: 'approved', app_version: '1.0.20' },
    ],
    admin_users: [{ id: AGENT, email: 'agent@zaptill.test', role: 'agent', is_active: true }, { id: SUPER, email: 'super@zaptill.test', role: 'super_admin', is_active: true },
      { id: AGENT2, email: 'agent2@zaptill.test', role: 'agent', is_active: true }],
    admin_audit_log: [], support_logs: [], log_requests: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/admin', forgetOnWrite({ catalogue: true, staff: true, tills: true, people: true, everyBusiness: true }));   // as routes/index.ts
app.use('/api/admin/clients', require(path.join(DIST, 'routes/logRequestsAdmin.js')).default);
app.use('/api/admin/clients', (_req, res) => res.status(418).json({ fell: 'through' }));   // the admin router's own /clients routes
app.use('/api/support', require(path.join(DIST, 'routes/support.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const adminTok = (id, role) => jwt.sign({ adminId: id, email: `${role}@zaptill.test`, role }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const T = {
  till: (deviceId = 'dev-T1', businessId = B) => sign({ userId: null, deviceId, till: true, businessId, permissionKeys: ['*'], surface: 'desktop' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos' }),
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], ownerLogin: true }),
  agent: adminTok(AGENT, 'agent'), super: adminTok(SUPER, 'super_admin'), agent2: adminTok(AGENT2, 'agent'),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};
const gz = (s) => zlib.gzipSync(Buffer.from(s)).toString('base64');
const base = `/api/admin/clients/${B}/log-requests`;
const ask = (tok = T.agent, body = {}) => call('POST', base, tok, { device_id: 'dev-T1', reason: 'printer stops at lunch', range_hours: 72, ...body });

try {
  state._setPermissionsMigrated(true);

  console.log('\nC. Create a request\n');
  reset();
  await ok('an agent asks: waiting, 72 h, the reason kept, expires in 7 days, audited in admin_audit_log', async () => {
    const r = await ask(T.agent, { include: { auth: true, other: true } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = mem.db.log_requests[0];
    assert.equal(row.status, 'waiting'); assert.equal(row.range_hours, 72); assert.equal(row.device_id, 'dev-T1'); assert.equal(row.business_id, B);
    assert.equal(row.reason, 'printer stops at lunch'); assert.deepEqual(row.include, { auth: true }); assert.equal(row.requested_by_admin, AGENT);
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    const days = (Date.parse(row.expires_at) - Date.parse(row.requested_at)) / 86_400_000;
    assert.ok(Math.abs(days - 7) < 0.001, String(days));
    const a = mem.db.admin_audit_log.find((x) => x.action === 'log_requests.create');
    assert.ok(a, 'no admin audit'); assert.equal(a.business_id, B); assert.equal(a.reason, 'printer stops at lunch'); assert.equal(a.after_data.request_id, row.id);
    assert.equal(r.body.note, null);
  });
  await ok('a super admin may too; the reason cleaned (control characters, spaces)', async () => {
    const r = await ask(T.super, { reason: '  sync\u0007   stuck \n since 9  ', range_hours: 24 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.log_requests.at(-1).reason, 'sync stuck since 9');
  });
  await ok('a business\'s own token (owner), a cashier\'s, a till\'s: refused (admins only) — nothing stored', async () => {
    reset();
    for (const t of [T.owner, T.cash, T.till()]) assert.equal((await ask(t)).status, 401);
    assert.equal(mem.db.log_requests.length, 0);
  });
  await ok('the reason is required (blank, spaces only, missing): 400 REASON_REQUIRED', async () => {
    reset();
    for (const reason of ['', '   ', undefined, 42]) {
      const r = await call('POST', base, T.agent, { device_id: 'dev-T1', reason, range_hours: 24 });
      assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'REASON_REQUIRED');
    }
    assert.equal(mem.db.log_requests.length, 0);
  });
  await ok('the range is 24, 72 or 168 hours only (48 refused, not rounded); none given → 24', async () => {
    reset();
    assert.equal((await ask(T.agent, { range_hours: 48 })).body.code, 'BAD_RANGE');
    assert.equal((await ask(T.agent, { range_hours: 168 })).status, 201);
    assert.equal((await call('POST', base, T.agent, { device_id: 'dev-T1', reason: 'x' })).status, 201);
    assert.deepEqual(mem.db.log_requests.map((r) => r.range_hours), [168, 24]);
  });
  await ok('a device of another business (404), a retired or unapproved one (409), none chosen (400)', async () => {
    reset();
    const other = await ask(T.agent, { device_id: 'dev-other' });
    assert.equal(other.status, 404, JSON.stringify(other.body)); assert.equal(other.body.code, 'NO_SUCH_DEVICE');
    assert.equal((await ask(T.agent, { device_id: 'dev-gone' })).body.code, 'DEVICE_NOT_ACTIVE');
    assert.equal((await ask(T.agent, { device_id: 'dev-wait' })).body.code, 'DEVICE_NOT_ACTIVE');
    assert.equal((await ask(T.agent, { device_id: '' })).body.code, 'DEVICE_REQUIRED');
    assert.equal(mem.db.log_requests.length, 0);
  });
  await ok('the branch server can be asked too (it is a device)', async () => {
    reset();
    assert.equal((await ask(T.agent, { device_id: 'dev-SRV' })).status, 201);
  });
  await ok('a till older than 1.0.20 is noted ("this till runs 1.0.5 … answer a pull from 1.0.20") — the request still waits', async () => {
    reset();
    const r = await ask(T.agent, { device_id: 'dev-T2' });
    assert.equal(r.status, 201);
    assert.match(r.body.note, /runs 1\.0\.5/); assert.match(r.body.note, /Tech page from 1\.0\.18/); assert.match(r.body.note, /pull from 1\.0\.20/);
  });
  await ok('20 per admin per hour: the 21st is 429; another admin is not held back; an hour later it goes again', async () => {
    reset();
    for (let i = 0; i < LR.REQUESTS_PER_ADMIN_HOUR; i++) assert.equal((await ask(T.agent)).status, 201);
    const over = await ask(T.agent);
    assert.equal(over.status, 429, JSON.stringify(over.body)); assert.equal(over.body.code, 'RATE_LIMITED');
    assert.equal((await ask(T.agent2)).status, 201);
    mem.db.log_requests.forEach((r) => { r.requested_at = new Date(Date.now() - 2 * 3600_000).toISOString(); });
    assert.equal((await ask(T.agent)).status, 201);
  });
  await ok('the table missing (migration 152 not applied): 503 in words, never a 500', async () => {
    reset(); mem.fail = (t) => (t === 'log_requests' ? { message: 'relation does not exist', code: '42P01' } : null);
    const r = await ask();
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'LOG_REQUESTS_UNAVAILABLE');
    assert.equal((await call('GET', base, T.agent)).status, 503);
  });
  await ok('a path this router does not serve falls through to the admin router (/clients/:id/devices)', async () => {
    reset();
    const r = await call('GET', `/api/admin/clients/${B}/devices`, T.agent);
    assert.equal(r.status, 418); assert.equal(r.body.fell, 'through');
  });

  console.log('\nD. The doorbell\n');
  reset(); hub._resetLiveHub();
  {
    const heard = { mine: [], server: [], other: [] };
    const off = [hub._addTestConn(B, 'dev-T1', (m) => heard.mine.push(m)), hub._addTestConn(B, 'dev-SRV', (m) => heard.server.push(m)),
      hub._addTestConn(B2, 'dev-other', (m) => heard.other.push(m))];
    const r = await ask(T.agent);
    await new Promise((res) => setTimeout(res, 50));
    await ok('that business\'s sockets hear { type: log_request, device_id } — the doorbell carries no request data', async () => {
      assert.equal(r.body.rung, 2);
      assert.deepEqual(heard.mine.filter((m) => m.type === 'log_request'), [{ type: 'log_request', device_id: 'dev-T1' }]);
      assert.deepEqual(heard.server.filter((m) => m.type === 'log_request'), [{ type: 'log_request', device_id: 'dev-T1' }]);
    });
    await ok('another business\'s sockets never', async () => { assert.equal(heard.other.length, 0, JSON.stringify(heard.other)); });
    await ok('the /admin write hook does not make every socket sign in again for a log request (nor forget the caches)', async () => {
      assert.equal([...heard.mine, ...heard.server, ...heard.other].filter((m) => m.type === '__closed').length, 0, JSON.stringify(heard));
    });
    off.forEach((f) => f()); hub._resetLiveHub();
  }

  console.log('\nM. GET /api/support/log-requests/mine\n');
  reset();
  const mk = (over = {}) => { const row = { id: randomUUID(), business_id: B, device_id: 'dev-T1', requested_by_admin: AGENT, requested_by_email: 'agent@zaptill.test',
    requested_at: new Date().toISOString(), reason: 'x', range_hours: 24, include: {}, status: 'waiting', delivered_at: null, support_log_id: null,
    cancelled_at: null, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), ...over }; mem.db.log_requests.push(row); return row; };
  const mine = mk({ range_hours: 168, include: { auth: true } });
  mk({ device_id: 'dev-T2' }); mk({ status: 'cancelled' }); mk({ status: 'delivered' }); mk({ business_id: B2, device_id: 'dev-T1' });
  await ok('only ITS waiting requests (another till\'s, a cancelled or delivered one, another business\'s never) — no reason sent', async () => {
    const r = await call('GET', '/api/support/log-requests/mine', T.till('dev-T1'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.requests.map((x) => x.id), [mine.id]);
    assert.equal(r.body.requests[0].range_hours, 168); assert.deepEqual(r.body.requests[0].include, { auth: true });
    assert.ok(!('reason' in r.body.requests[0]));
  });
  await ok('the other till sees its own only', async () => {
    const r = await call('GET', '/api/support/log-requests/mine', T.till('dev-T2'));
    assert.equal(r.body.requests.length, 1); assert.notEqual(r.body.requests[0].id, mine.id);
  });
  await ok('a person\'s token (a cashier, the owner) is refused: 403 TILL_ONLY', async () => {
    for (const t of [T.cash, T.owner]) assert.equal((await call('GET', '/api/support/log-requests/mine', t)).status, 403);
  });

  console.log('\nU. The upload answers it\n');
  await ok('another till cannot answer it (403 NOT_YOUR_REQUEST) — nothing stored, still waiting', async () => {
    const r = await call('POST', '/api/support/logs', T.till('dev-T2'), { log_gz_b64: gz('not mine'), request_id: mine.id });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'NOT_YOUR_REQUEST');
    assert.equal(mem.db.support_logs.length, 0); assert.equal(mine.status, 'waiting');
  });
  await ok('another business\'s till: 404 (never told it exists)', async () => {
    const r = await call('POST', '/api/support/logs', T.till('dev-other', B2), { log_gz_b64: gz('x'), request_id: mine.id });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
  await ok('the till\'s answer: stored (redacted again), linked to the request, marked delivered; "pulled by ZapTill support"', async () => {
    const r = await call('POST', '/api/support/logs', T.till('dev-T1'), { log_gz_b64: gz('2026-10-20T08:00:00Z [pin] pin=4321 ok'), request_id: mine.id, terminal_code: 'T1' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.request_id, mine.id);
    const log = mem.db.support_logs[0];
    assert.equal(mine.status, 'delivered'); assert.equal(mine.support_log_id, log.id); assert.ok(mine.delivered_at);
    assert.match(log.sent_by, /pulled by ZapTill support \(agent@zaptill\.test\)/);
    assert.ok(!/4321/.test(zlib.gunzipSync(Buffer.from(log.log_gz_b64, 'base64')).toString()));
  });
  await ok('answered again (a lost reply, retried): 409 REQUEST_CLOSED delivered — nothing more stored', async () => {
    const r = await call('POST', '/api/support/logs', T.till('dev-T1'), { log_gz_b64: gz('again'), request_id: mine.id });
    assert.equal(r.status, 409); assert.equal(r.body.status, 'delivered'); assert.equal(mem.db.support_logs.length, 1);
  });
  await ok('not counted against the 5 an hour: a till that sent 5 from its Tech page still answers a pull', async () => {
    reset();
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz(`tech ${i}`) })).status, 201);
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('sixth') })).status, 429);
    const r = mk();
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('pulled'), request_id: r.id })).status, 201);
    assert.equal(r.status, 'delivered');
  });
  await ok('an unknown request (404), not an id (400), a cancelled one (409)', async () => {
    reset();
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('x'), request_id: randomUUID() })).status, 404);
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('x'), request_id: 'abc' })).status, 400);
    const c = mk({ status: 'cancelled' });
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('x'), request_id: c.id });
    assert.equal(r.status, 409); assert.equal(r.body.status, 'cancelled'); assert.equal(mem.db.support_logs.length, 0);
  });

  console.log('\nX. Cancel and expiry\n');
  reset();
  await ok('cancel a waiting one: cancelled, audited; the till no longer sees it; cancelling again 409', async () => {
    const made = (await ask()).body.request;
    const r = await call('POST', `${base}/${made.id}/cancel`, T.agent, { reason: 'fixed on the phone' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.request.status, 'cancelled');
    assert.ok(mem.db.admin_audit_log.find((a) => a.action === 'log_requests.cancel' && a.reason === 'fixed on the phone'));
    assert.equal((await call('GET', '/api/support/log-requests/mine', T.till())).body.requests.length, 0);
    assert.equal((await call('POST', `${base}/${made.id}/cancel`, T.agent, {})).status, 409);
  });
  await ok('cancel: another business\'s request is not found from this client (404); not an admin (401)', async () => {
    const o = mk({ business_id: B2, device_id: 'dev-other' });
    assert.equal((await call('POST', `${base}/${o.id}/cancel`, T.agent, {})).status, 404);
    assert.equal((await call('POST', `${base}/${o.id}/cancel`, T.owner, {})).status, 401);
    assert.equal(o.status, 'waiting');
  });
  await ok('expiry: still waiting 7 days on → expired on the till\'s ask (it sees nothing) and on the upload (409 expired)', async () => {
    reset();
    const old = mk({ requested_at: new Date(Date.now() - 8 * 86_400_000).toISOString(), expires_at: new Date(Date.now() - 86_400_000).toISOString() });
    const fresh = mk();
    assert.deepEqual((await call('GET', '/api/support/log-requests/mine', T.till())).body.requests.map((r) => r.id), [fresh.id]);
    assert.equal(old.status, 'expired'); assert.equal(fresh.status, 'waiting');
    const old2 = mk({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('late'), request_id: old2.id });
    assert.equal(r.status, 409); assert.equal(r.body.status, 'expired');
  });
  await ok('expiry on the admin list too (no job needed)', async () => {
    reset();
    const old = mk({ device_id: 'dev-T2', expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await call('GET', base, T.agent);
    assert.equal(r.status, 200); assert.equal(old.status, 'expired'); assert.equal(r.body.requests[0].status, 'expired');
  });

  console.log('\nL. The admin list\n');
  reset();
  await ok('newest first; the device\'s label, version, last seen; the linked log\'s reference; a waiting old till\'s note', async () => {
    const a = mk({ requested_at: '2026-10-20T09:00:00Z' });
    await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('answer'), request_id: a.id });
    mk({ device_id: 'dev-T2', requested_at: '2026-10-20T10:00:00Z' });
    const r = await call('GET', base, T.super);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [first, second] = r.body.requests;
    assert.equal(first.device_label, 'Bar'); assert.equal(first.status, 'waiting'); assert.equal(first.last_seen_at, '2026-10-20T10:00:00Z');
    assert.match(first.note, /runs 1\.0\.5/);
    assert.equal(second.status, 'delivered'); assert.equal(second.support_log.reference, mem.db.support_logs[0].reference); assert.equal(second.note, null);
  });
  await ok('the devices that can be asked: approved and not retired, with version, role and whether each can answer', async () => {
    const r = await call('GET', base, T.agent);
    const ids = r.body.devices.map((d) => d.device_id).sort();
    assert.deepEqual(ids, ['dev-SRV', 'dev-T1', 'dev-T2']);
    const t2 = r.body.devices.find((d) => d.device_id === 'dev-T2');
    assert.equal(t2.can_answer, false); assert.equal(t2.app_version, '1.0.5'); assert.equal(t2.branch, 'Westlands');
    assert.equal(r.body.devices.find((d) => d.device_id === 'dev-SRV').role, 'node');
    assert.equal(r.body.devices.find((d) => d.device_id === 'dev-T1').can_answer, true);
  });
  await ok('helpers: versionBelow, rangeOf, cleanReason', async () => {
    assert.equal(LR.versionBelow('1.0.19', '1.0.20'), true); assert.equal(LR.versionBelow('1.0.20', '1.0.20'), false);
    assert.equal(LR.versionBelow('1.1.0', '1.0.20'), false); assert.equal(LR.versionBelow(null, '1.0.20'), true);
    assert.equal(LR.rangeOf('72'), 72); assert.equal(LR.rangeOf(0), null); assert.equal(LR.rangeOf(undefined), 24);
    assert.equal(LR.cleanReason('a'.repeat(400)).length, LR.REASON_MAX);
  });

  // A554 (the owner's screenshot, 2026-10-21): the warning showed twice (orange, then green), and appeared for a test
  // build labelled 1.0.19 that then delivered the log — the version alone decided. Now what the device says (its update
  // state's log_pull, A534's report) or did (a pull answered) decides first; the words say "may wait".
  console.log('\nA554. Whether a device answers a pull: what it says, not its version alone\n');
  const devOf = (r, id) => r.body.devices.find((d) => d.device_id === id);
  await ok('A554: a device reporting log_pull in its update state answers — whatever its version (no note, on the list and on a request)', async () => {
    reset();
    mem.db.user_devices.find((d) => d.device_id === 'dev-T2').update_state = { state: 'idle', running: '1.0.5', log_pull: true };
    const r = await call('GET', base, T.agent);
    assert.equal(devOf(r, 'dev-T2').can_answer, true); assert.equal(devOf(r, 'dev-T2').note, null);
    const a = await ask(T.agent, { device_id: 'dev-T2' });
    assert.equal(a.status, 201); assert.equal(a.body.note, null);
    const l = await call('GET', base, T.agent);
    assert.equal(l.body.requests[0].note, null);
  });
  await ok('A554: a device that answered a pull before answers (no note)', async () => {
    reset();
    mk({ device_id: 'dev-T2', status: 'delivered', delivered_at: new Date().toISOString() });
    const r = await call('GET', base, T.agent);
    assert.equal(devOf(r, 'dev-T2').can_answer, true); assert.equal(devOf(r, 'dev-T2').note, null);
    assert.equal((await ask(T.agent, { device_id: 'dev-T2' })).body.note, null);
  });
  await ok('A554: nothing known but an old version → noted, and softened ("may wait until it updates")', async () => {
    reset();
    const r = await call('GET', base, T.agent);
    assert.equal(devOf(r, 'dev-T2').can_answer, false);
    assert.match(devOf(r, 'dev-T2').note, /may wait until it updates/);
    assert.doesNotMatch(devOf(r, 'dev-T2').note, /The request waits until/);
    assert.equal(LR.canAnswerPull('1.0.19'), false); assert.equal(LR.canAnswerPull('1.0.19', { reportsLogPull: true }), true);
    assert.equal(LR.canAnswerPull('1.0.19', { answeredBefore: true }), true); assert.equal(LR.canAnswerPull('1.0.20'), true);
  });
  await ok('A554: the till\'s report carries log_pull and the cloud keeps it (cleanUpdateState); junk is false', async () => {
    const US = require(path.join(DIST, 'lib/updateState.js'));
    assert.equal(US.cleanUpdateState({ state: 'idle', log_pull: true }).log_pull, true);
    assert.equal(US.cleanUpdateState({ state: 'idle', log_pull: 'yes' }).log_pull, false);
    assert.equal(US.cleanUpdateState({ state: 'idle' }).log_pull, false);
    const rep = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/updateReport.ts'), 'utf8');
    assert.match(rep, /startup_failed: !!s\.startupFailed[^\n]*\n\s*log_pull: true,/);
  });
  await ok('A554: the admin card shows ONE warning in the warning colour (the device\'s note or the request\'s), the green notice only when it is not one', async () => {
    const card = fs.readFileSync(path.join(ROOT, 'apps/admin/src/PullLogsCard.tsx'), 'utf8');
    assert.match(card, /const warning = notice\?\.warn \? notice\.text : chosen && !chosen\.can_answer && chosen\.note \? chosen\.note : null;/);
    assert.match(card, /\{warning && <div style=\{\{ fontSize: 12, color: WARN, marginTop: 8 \}\} data-testid="pull-warning">\{warning\}<\/div>\}/);
    assert.match(card, /\{notice && !notice\.warn && <div style=\{\{ fontSize: 12, color: C\.green/);
    assert.match(card, /setNotice\(d\?\.note \? \{ text: d\.note, warn: true \}/);
    assert.doesNotMatch(card, /chosen\.note && <div/, 'the device note is not rendered on its own as well');
    assert.equal((card.match(/data-testid="pull-warning"/g) || []).length, 1);
  });
  await ok('A554: the device list shows the whole version — straight after the name, in a wider list', async () => {
    const card = fs.readFileSync(path.join(ROOT, 'apps/admin/src/PullLogsCard.tsx'), 'utf8');
    assert.match(card, /return `\$\{d\.label\}\$\{code\} · \$\{d\.app_version \? `v\$\{d\.app_version\}` : "version \?"\} · \$\{roleLabel\(d\.role\)\}/);
    assert.match(card, /data-testid="pull-device">/);
    assert.match(card, /flex: "1 1 380px", minWidth: 240, maxWidth: "100%"/);
    assert.doesNotMatch(card, /maxWidth: 320/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
