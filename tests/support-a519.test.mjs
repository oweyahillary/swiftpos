// A519 — the cloud's side of two till items: "Send logs to support" and the terminal codes a branch's tills use.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/support-a519.test.mjs
//
// RUNS the COMPILED routers (routes/support.ts, routes/supportAdmin.ts) behind the REAL auth middleware (till tokens,
// person tokens, admin tokens) over HTTP; the database in memory (tests/lib-memdb.mjs).
//
//   L  POST /api/support/logs: the till's own session only; a log too big (413), not base64 / not gzip / unpacking past
//      4 MB (400); redacted AGAIN before it is stored (a till on an older build); 5 per device per hour (429); a
//      technician token names who sent it; a reference to read out on the phone.
//   A  GET /api/admin/support-logs: admins only (a business's own token refused), a client's list without the log text,
//      by reference, one log unpacked, a download.
//   T  GET /api/support/terminal-codes: the branch's OTHER approved tills' codes, this machine's earlier installs (same
//      MAC) and retired / pending tills left out, the next free code; the till's own branch only.
//   W  the till may make this write (terminalWrites TILL_WRITES) — and only the log route.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-16):
//   - support.ts without the redactLog call before the insert       → L "redacted again" fails
//   - support.ts RATE_PER_HOUR check removed                        → L "sixth in an hour" fails
//   - support.ts accepting a person's token                         → L "a person's token" fails
//   - terminal-codes without the same-MAC filter                     → T "an earlier install of this machine" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/support.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
const S = require(path.join(DIST, 'routes/support.js'));
const TW = require(path.join(DIST, 'lib/terminalWrites.js'));

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CASH = 'aaaaaaaa-0000-4000-8000-000000000003', ADMIN = 'bbbbbbbb-0000-4000-8000-000000000001';
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', desktop_licensed: true }, { id: BR2, business_id: B, name: 'CBD', desktop_licensed: true }],
    users: [{ id: CASH, name: 'Joe', status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], roles: { name: 'Cashier', role_permissions: [{ permissions: { key: 'orders.create' } }] } }],
    user_branches: [], feature_flags: [], refresh_tokens: [],
    user_devices: [
      { id: 'd1', business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'approved', mac_address: 'aa:aa:aa:aa:aa:01' },
      { id: 'd2', business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 't2', status: 'approved', mac_address: 'aa:aa:aa:aa:aa:02' },
      { id: 'd3', business_id: B, branch_id: BR, device_id: 'dev-old', terminal_code: 'T3', status: 'approved', mac_address: 'aa:aa:aa:aa:aa:09' },
      { id: 'd4', business_id: B, branch_id: BR, device_id: 'dev-new', terminal_code: null, status: 'approved', mac_address: 'aa:aa:aa:aa:aa:09' },
      { id: 'd5', business_id: B, branch_id: BR, device_id: 'dev-gone', terminal_code: 'T4', status: 'approved', retired_at: '2026-09-01T00:00:00Z' },
      { id: 'd6', business_id: B, branch_id: BR, device_id: 'dev-wait', terminal_code: 'T5', status: 'pending' },
      { id: 'd7', business_id: B, branch_id: BR2, device_id: 'dev-cbd', terminal_code: 'T6', status: 'approved' },
    ],
    admin_users: [{ id: ADMIN, email: 'a@zaptill.test', role: 'agent', is_active: true }],
    support_logs: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/support', S.default);
app.use('/api/admin/support-logs', require(path.join(DIST, 'routes/supportAdmin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  till: (deviceId = 'dev-T1', branchId = BR) => sign({ userId: null, deviceId, till: true, branchId, permissionKeys: ['*'], surface: 'desktop' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos' }),
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], ownerLogin: true }),
  admin: jwt.sign({ adminId: ADMIN, email: 'a@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const gz = (s) => zlib.gzipSync(Buffer.from(s)).toString('base64');

try {
  state._setPermissionsMigrated(true);

  console.log('\nL. POST /api/support/logs\n');
  reset();
  await ok('the till\'s own session: stored, a reference to read out (6 letters/digits, no 0/O/1/I)', async () => {
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('ZapTill support log\n2026-10-16T08:00:00Z [sale] created T1--5 1250 cash'), terminal_code: 'T1', app_version: '1.0.18' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.reference, /^[A-HJ-NP-Z2-9]{6}$/);
    const row = mem.db.support_logs[0];
    assert.equal(row.business_id, B); assert.equal(row.device_id, 'dev-T1'); assert.equal(row.branch_id, BR); assert.equal(row.terminal_code, 'T1');
    assert.equal(row.reference, r.body.reference); assert.equal(row.sent_by, 'the till');
  });
  await ok('redacted AGAIN before it is stored (a till on an older build sent a token and a PIN)', async () => {
    reset();
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('x {"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXg"} pin=4321 Authorization: Bearer leaked-token-value') });
    assert.equal(r.status, 201);
    const text = zlib.gunzipSync(Buffer.from(mem.db.support_logs[0].log_gz_b64, 'base64')).toString();
    assert.ok(!/eyJhbGci|4321|leaked-token-value/.test(text), text);
  });
  await ok('a person\'s token (a cashier on the till, the owner) never sends a till\'s log: 403 TILL_ONLY', async () => {
    reset();
    for (const t of [T.cash, T.owner]) {
      const r = await call('POST', '/api/support/logs', t, { log_gz_b64: gz('x') });
      assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'TILL_ONLY');
    }
    assert.equal(mem.db.support_logs.length, 0);
  });
  await ok('too big (413), not base64 / not gzip (400), unpacking past 4 MB (400) — nothing stored', async () => {
    reset();
    const big = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: 'A'.repeat(S.MAX_B64 + 4) });
    assert.equal(big.status, 413, JSON.stringify(big.body));
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: 'not base64!' })).status, 400);
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: Buffer.from('plain text').toString('base64') })).status, 400);
    const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20)).toString('base64');
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: bomb });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(mem.db.support_logs.length, 0);
  });
  await ok('five per device per hour: the sixth is 429 (another till is not held back)', async () => {
    reset();
    for (let i = 0; i < S.RATE_PER_HOUR; i++) assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz(`log ${i}`) })).status, 201);
    const sixth = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('again') });
    assert.equal(sixth.status, 429, JSON.stringify(sixth.body)); assert.equal(sixth.body.code, 'RATE_LIMITED');
    assert.equal((await call('POST', '/api/support/logs', T.till('dev-T2'), { log_gz_b64: gz('other till') })).status, 201);
    mem.db.support_logs.forEach((l) => { l.created_at = new Date(Date.now() - 2 * 3600_000).toISOString(); });
    assert.equal((await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('an hour later') })).status, 201);
  });
  await ok('the table missing (migration 145 not applied): 503 in words, never a 500', async () => {
    reset(); mem.fail = (t) => (t === 'support_logs' ? { message: 'relation does not exist', code: '42P01' } : null);
    const r = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('x') });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'SUPPORT_LOGS_UNAVAILABLE');
  });

  console.log('\nA. GET /api/admin/support-logs\n');
  reset();
  const sent = await call('POST', '/api/support/logs', T.till(), { log_gz_b64: gz('ZapTill support log\nhello support'), terminal_code: 'T1' });
  await ok('a business\'s own token is refused (admins only)', async () => {
    assert.equal((await call('GET', `/api/admin/support-logs?business=${B}`, T.owner)).status, 401);
  });
  await ok('a client\'s list: reference, till, when — never the log text', async () => {
    const r = await call('GET', `/api/admin/support-logs?business=${B}`, T.admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.logs.length, 1); assert.equal(r.body.logs[0].reference, sent.body.reference); assert.equal(r.body.logs[0].terminal_code, 'T1');
    assert.ok(!('log_gz_b64' in r.body.logs[0]));
  });
  await ok('by the reference the client read out (any case)', async () => {
    const r = await call('GET', `/api/admin/support-logs?reference=${sent.body.reference.toLowerCase()}`, T.admin);
    assert.equal(r.body.logs.length, 1);
  });
  await ok('one log unpacked (never the packed column), and as a .txt download', async () => {
    const uid = '44444444-4444-4444-8444-444444444444';   // the database gives uuids; the in-memory table does not
    mem.db.support_logs.push({ ...mem.db.support_logs[0], id: uid, reference: 'ZZZZZZ' });
    const j = await call('GET', `/api/admin/support-logs/${uid}`, T.admin);
    assert.equal(j.status, 200); assert.match(j.body.text, /hello support/); assert.ok(!('log_gz_b64' in j.body));
    const r = await call('GET', `/api/admin/support-logs/${uid}?download=1`, T.admin);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="zaptill-T1-ZZZZZZ\.txt"/);
    assert.match(r.text, /hello support/);
  });
  await ok('bad input: no business or reference (400), a business that is not an id (400)', async () => {
    assert.equal((await call('GET', '/api/admin/support-logs', T.admin)).status, 400);
    assert.equal((await call('GET', '/api/admin/support-logs?business=x', T.admin)).status, 400);
  });

  console.log('\nT. GET /api/support/terminal-codes\n');
  reset();
  await ok('the branch\'s OTHER approved tills\' codes, and the next free one', async () => {
    const r = await call('GET', `/api/support/terminal-codes?branch_id=${BR}&code=t1`, T.till('dev-T2'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.in_use, ['T1', 'T3']); assert.equal(r.body.taken, true); assert.equal(r.body.suggestion, 'T2');
  });
  await ok('…an earlier install of this machine (same MAC), a retired till and one not approved are left out; another branch too', async () => {
    const r = await call('GET', `/api/support/terminal-codes?branch_id=${BR}&code=T3`, T.till('dev-new'));
    assert.ok(!r.body.in_use.includes('T3'), JSON.stringify(r.body)); assert.equal(r.body.taken, false);
    assert.ok(!r.body.in_use.includes('T4') && !r.body.in_use.includes('T5') && !r.body.in_use.includes('T6'));
  });
  await ok('the till\'s own branch only; a cashier refused; the owner may ask', async () => {
    assert.equal((await call('GET', `/api/support/terminal-codes?branch_id=${BR2}`, T.till('dev-T1'))).status, 403);
    assert.equal((await call('GET', `/api/support/terminal-codes?branch_id=${BR}`, T.cash)).status, 403);
    assert.equal((await call('GET', `/api/support/terminal-codes?branch_id=${BR}`, T.owner)).status, 200);
    assert.equal((await call('GET', `/api/support/terminal-codes?branch_id=55555555-5555-4555-8555-555555555555`, T.owner)).status, 404);
  });
  await ok('the next free code: T1 → T2, gaps filled, letters kept', async () => {
    assert.equal(S.nextFreeTerminalCode(['T1', 'T2'], 'T1'), 'T3'); assert.equal(S.nextFreeTerminalCode(['T1', 'T3'], 'T1'), 'T2');
    assert.equal(S.nextFreeTerminalCode([], 'T1'), 'T1'); assert.equal(S.nextFreeTerminalCode(['BAR1'], 'BAR1'), 'BAR2');
  });

  console.log('\nW. The till may make this write\n');
  await ok('POST /api/support/logs is a till write (its own token); nothing else under /api/support is', async () => {
    assert.equal(TW.terminalWriteVerdict('desktop', 'POST', '/api/support/logs', false), 'till');
    assert.equal(TW.terminalWriteVerdict('desktop', 'POST', '/api/support/other', false), 'denied');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
