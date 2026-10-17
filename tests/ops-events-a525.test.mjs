// A525 — what the production server runs, whether a deploy reached it, what the dependencies carry.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/ops-events-a525.test.mjs
//
// Production silently failed every deploy from 1.0.16 to 1.0.18 and nobody noticed for two releases; npm audit showed 7
// vulnerabilities nobody was told about. Owner, 2026-10-17: "these results are written to the db and I can read through".
//
// RUNS the COMPILED routers (routes/ops.ts, routes/opsAdmin.ts) behind the REAL admin auth over HTTP; the database in
// memory (tests/lib-memdb.mjs).
//
//   I  POST /api/ops/events: off without a token or with a short one (503 OPS_INGEST_DISABLED); a wrong token 401; the
//      right one 201 and the row stored; a bad kind, 'boot' (only the server says it started), oversized details refused;
//      a 'fail' tells the ZapTill admin (e-mail) and the answer does not wait for it.
//   A  GET /api/admin/ops/events and /summary: super admins only (an agent, a business's token refused); newest first, a
//      page at a time with the total; the summary: the latest start, deploy check and scan, and what runs now.
//   B  recordBoot: a missing table or a throw never throws; the row it writes; skipped under NODE_ENV=test.
//   H  /health carries commit (12 characters of RENDER_GIT_COMMIT, or null) and started_at — in both answers.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-17):
//   - opsEvents.ts ingestToken without the 32-character minimum      → I "a short token" fails
//   - opsEvents.ts IngestSchema kind allowing 'boot'                   → I "'boot' refused" fails
//   - opsAdmin.ts without requireSuperAdmin                            → A "an agent is refused" fails
//   - ops.ts without the notifyAdmin call on fail                      → I "a fail tells the admin" fails
//   - opsEvents.ts recordBoot's catch rethrowing                     → B "a throw never throws" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/ops.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
process.env.ADMIN_ALERT_EMAIL = 'ops@zaptill.test';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const sent = [];
let mailDelay = 0;
mailer.sendEmailChecked = async (m) => { if (mailDelay) await new Promise((r) => setTimeout(r, mailDelay)); sent.push(m); return { ok: true, provider: 'none' }; };
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const OPS = require(path.join(DIST, 'lib/opsEvents.js'));

const AG = 'eeeeeeee-0000-4000-8000-000000000001', SA = 'eeeeeeee-0000-4000-8000-000000000002';
const TOKEN = 'a'.repeat(40) + randomBytes(8).toString('hex');
const reset = () => {
  mem.fail = () => null; mem.calls = []; sent.length = 0; mailDelay = 0;
  mem.db = {
    ops_events: [],
    admin_users: [
      { id: AG, email: 'agent@zaptill.test', role: 'agent', is_active: true },
      { id: SA, email: 'boss@zaptill.test', role: 'super_admin', is_active: true },
    ],
  };
  process.env.OPS_INGEST_TOKEN = TOKEN;
  adminAuth.forgetAdmin();
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/ops', require(path.join(DIST, 'routes/ops.js')).default);
app.use('/api/admin/ops', require(path.join(DIST, 'routes/opsAdmin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const adminTok = (id, role) => jwt.sign({ adminId: id, email: `${role}@zaptill.test`, role }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const T = {
  agent: adminTok(AG, 'agent'),
  boss: adminTok(SA, 'super_admin'),
  business: jwt.sign({ userId: 'u', sessionId: 's', businessId: 'b', isOwner: true, permissionKeys: ['*'] }, process.env.JWT_SECRET, { expiresIn: '5m' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};
const post = (body, token = TOKEN) => call('POST', '/api/ops/events', token, body);
const DEPLOY_OK = { kind: 'deploy_check', status: 'ok', commit: 'abc123def456', title: 'Production runs abc123def456', details: { expected: 'abc123def456', running: 'abc123def456' } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('\nI. POST /api/ops/events\n');
  await ok('off without OPS_INGEST_TOKEN: 503 OPS_INGEST_DISABLED, nothing stored', async () => {
    reset(); delete process.env.OPS_INGEST_TOKEN;
    const r = await post(DEPLOY_OK, 'anything');
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'OPS_INGEST_DISABLED');
    assert.equal(mem.db.ops_events.length, 0);
  });
  await ok('a short token (under 32 characters) is off too — even when it is the one sent', async () => {
    reset(); process.env.OPS_INGEST_TOKEN = 'short-token-123';
    const r = await post(DEPLOY_OK, 'short-token-123');
    assert.equal(r.status, 503); assert.equal(r.body.code, 'OPS_INGEST_DISABLED');
    assert.equal(mem.db.ops_events.length, 0);
  });
  await ok('a wrong token, a missing one and an admin\'s session: 401', async () => {
    reset();
    for (const t of [TOKEN + 'x', TOKEN.slice(0, -1), null, T.boss]) {
      const r = await post(DEPLOY_OK, t);
      assert.equal(r.status, 401, `${t}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(mem.db.ops_events.length, 0);
  });
  await ok('the right token: 201 { id }, the row stored (source defaults to github)', async () => {
    reset();
    const r = await post(DEPLOY_OK);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = mem.db.ops_events[0];
    assert.equal(row.id, r.body.id);
    assert.equal(row.kind, 'deploy_check'); assert.equal(row.status, 'ok'); assert.equal(row.commit, 'abc123def456');
    assert.equal(row.source, 'github'); assert.deepEqual(row.details, DEPLOY_OK.details); assert.ok(row.created_at);
    assert.equal(sent.length, 0, 'an ok is not mailed');
  });
  await ok('a bad kind, a bad status, no title, a title over 200: 400, nothing stored', async () => {
    reset();
    for (const b of [{ ...DEPLOY_OK, kind: 'reboot' }, { ...DEPLOY_OK, status: 'bad' }, { ...DEPLOY_OK, title: '' }, { ...DEPLOY_OK, title: 'x'.repeat(201) },
      { ...DEPLOY_OK, commit: 'c'.repeat(65) }, { ...DEPLOY_OK, source: 's'.repeat(41) }, { ...DEPLOY_OK, details: ['not', 'an', 'object'] }]) {
      const r = await post(b);
      assert.equal(r.status, 400, `${JSON.stringify(b).slice(0, 80)} → ${r.status}`);
    }
    assert.equal(mem.db.ops_events.length, 0);
  });
  await ok('\'boot\' refused from the ingest — only the server itself says it started', async () => {
    reset();
    const r = await post({ ...DEPLOY_OK, kind: 'boot' });
    assert.equal(r.status, 400); assert.equal(mem.db.ops_events.length, 0);
  });
  await ok('details over 64 KB refused; just under accepted', async () => {
    reset();
    const big = await post({ ...DEPLOY_OK, details: { blob: 'x'.repeat(64 * 1024) } });
    assert.equal(big.status, 400, JSON.stringify(big.body).slice(0, 200));
    const fits = await post({ ...DEPLOY_OK, details: { blob: 'x'.repeat(60 * 1024) } });
    assert.equal(fits.status, 201);
    assert.equal(mem.db.ops_events.length, 1);
  });
  await ok('a fail tells the admin (e-mail: what failed, expected, running, what to do, the run) — the answer does not wait', async () => {
    reset(); mailDelay = 200;
    const t0 = Date.now();
    const r = await post({ kind: 'deploy_check', status: 'fail', commit: '111111111111', title: 'Production still runs 000000000000',
      details: { expected: '111111111111', running: '000000000000', run_url: 'https://github.com/x/y/actions/runs/1', what_to_do: 'Open Render and deploy.' } });
    assert.equal(r.status, 201);
    assert.ok(Date.now() - t0 < 180, 'answered before the mail went');
    await tick(300);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ops@zaptill.test');
    for (const s of ['Production still runs 000000000000', 'Expected: 111111111111', 'Running: 000000000000', 'Open Render and deploy.', 'actions/runs/1']) assert.ok(sent[0].html.includes(s), s);
  });
  await ok('a failing alert never fails the request', async () => {
    reset();
    mailer.sendEmailChecked = async () => { throw new Error('mail down'); };
    try {
      const r = await post({ ...DEPLOY_OK, status: 'fail' });
      assert.equal(r.status, 201); await tick();
      assert.equal(mem.db.ops_events.length, 1);
    } finally { mailer.sendEmailChecked = async (m) => { sent.push(m); return { ok: true, provider: 'none' }; }; }
  });
  await ok('the table missing (migration 149 not run): 503 OPS_EVENTS_UNAVAILABLE', async () => {
    reset(); mem.fail = (t) => (t === 'ops_events' ? { code: '42P01', message: 'relation "ops_events" does not exist' } : null);
    const r = await post(DEPLOY_OK);
    assert.equal(r.status, 503); assert.equal(r.body.code, 'OPS_EVENTS_UNAVAILABLE');
  });

  console.log('\nA. GET /api/admin/ops/*\n');
  const seed = () => {
    const at = (m) => new Date(Date.UTC(2026, 9, 17, 6, m)).toISOString();
    mem.db.ops_events = [];
    for (let i = 0; i < 30; i++) mem.db.ops_events.push({ id: `b${i}`, kind: 'boot', status: 'ok', commit: `c${i}`, title: `boot ${i}`, details: {}, source: 'server', created_at: at(i) });
    mem.db.ops_events.push({ id: 'd1', kind: 'deploy_check', status: 'fail', commit: 'aaa', title: 'old', details: { expected: 'aaa' }, source: 'github', created_at: at(31) });
    mem.db.ops_events.push({ id: 'd2', kind: 'deploy_check', status: 'ok', commit: 'bbb', title: 'new', details: {}, source: 'github', created_at: at(40) });
    mem.db.ops_events.push({ id: 'v1', kind: 'vuln_scan', status: 'warn', commit: 'bbb', title: 'scan', details: { totals: { high: 0, moderate: 2 } }, source: 'github', created_at: at(35) });
  };
  await ok('an agent is refused (403 SUPER_ADMIN_REQUIRED), a business\'s token and no token 401', async () => {
    reset(); seed();
    for (const p of ['/api/admin/ops/events', '/api/admin/ops/summary']) {
      const a = await call('GET', p, T.agent);
      assert.equal(a.status, 403, `${p}: ${JSON.stringify(a.body)}`); assert.equal(a.body.code, 'SUPER_ADMIN_REQUIRED');
      assert.equal((await call('GET', p, T.business)).status, 401);
      assert.equal((await call('GET', p, null)).status, 401);
    }
  });
  await ok('a super admin: newest first, a page at a time, the total for the pager', async () => {
    reset(); seed();
    const r = await call('GET', '/api/admin/ops/events?size=25', T.boss);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 33); assert.equal(r.body.page, 1); assert.equal(r.body.size, 25);
    assert.equal(r.body.events.length, 25);
    assert.deepEqual(r.body.events.slice(0, 4).map((e) => e.id), ['d2', 'v1', 'd1', 'b29']);
    const p2 = await call('GET', '/api/admin/ops/events?size=25&page=2', T.boss);
    assert.equal(p2.body.events.length, 8); assert.equal(p2.body.events.at(-1).id, 'b0');
  });
  await ok('filtered by kind and status; a bad kind 400; an odd size falls back to 50', async () => {
    reset(); seed();
    const r = await call('GET', '/api/admin/ops/events?kind=deploy_check', T.boss);
    assert.deepEqual(r.body.events.map((e) => e.id), ['d2', 'd1']); assert.equal(r.body.total, 2);
    const f = await call('GET', '/api/admin/ops/events?kind=deploy_check&status=fail', T.boss);
    assert.deepEqual(f.body.events.map((e) => e.id), ['d1']);
    assert.equal((await call('GET', '/api/admin/ops/events?kind=nope', T.boss)).status, 400);
    assert.equal((await call('GET', '/api/admin/ops/events?size=7', T.boss)).body.size, 50);
  });
  await ok('the summary: the latest of each kind and what this server runs now', async () => {
    reset(); seed();
    const r = await call('GET', '/api/admin/ops/summary', T.boss);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.boot.id, 'b29'); assert.equal(r.body.deploy_check.id, 'd2'); assert.equal(r.body.vuln_scan.id, 'v1');
    assert.ok('commit' in r.body.live); assert.match(r.body.live.started_at, /^\d{4}-\d\d-\d\dT/);
  });
  await ok('the summary before migration 149: 503 with what runs now', async () => {
    reset(); mem.fail = (t) => (t === 'ops_events' ? { code: '42P01', message: 'missing' } : null);
    const r = await call('GET', '/api/admin/ops/summary', T.boss);
    assert.equal(r.status, 503); assert.ok(r.body.live?.started_at);
  });

  console.log('\nB. recordBoot\n');
  await ok('writes one boot row: the full commit, node, started_at, env', async () => {
    reset();
    const c = 'ABCDEF0123456789abcdef0123456789abcdef01';
    assert.equal(await OPS.recordBoot({ NODE_ENV: 'production', RENDER_GIT_COMMIT: c }), true);
    const row = mem.db.ops_events[0];
    assert.equal(row.kind, 'boot'); assert.equal(row.status, 'ok'); assert.equal(row.source, 'server');
    assert.equal(row.commit, c.toLowerCase()); assert.match(row.title, /abcdef012345/);
    assert.equal(row.details.node, process.version); assert.equal(row.details.env, 'production'); assert.ok(row.details.started_at);
  });
  await ok('a missing table, or a throw, never throws (false, a warning)', async () => {
    reset(); mem.fail = (t) => (t === 'ops_events' ? { code: '42P01', message: 'missing' } : null);
    assert.equal(await OPS.recordBoot({ NODE_ENV: 'production' }), false);
    const from = supabase.from;
    supabase.from = () => { throw new Error('boom'); };
    try { assert.equal(await OPS.recordBoot({ NODE_ENV: 'production' }), false); } finally { supabase.from = from; }
  });
  await ok('skipped under NODE_ENV=test', async () => {
    reset();
    assert.equal(await OPS.recordBoot({ NODE_ENV: 'test' }), false);
    assert.equal(mem.db.ops_events.length, 0);
  });

  console.log('\nH. /health says what it runs\n');
  await ok('buildInfo: 12 characters of RENDER_GIT_COMMIT (or null), started_at fixed at start', async () => {
    const a = OPS.buildInfo({ RENDER_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567' });
    assert.equal(a.commit, '0123456789ab');
    assert.equal(OPS.buildInfo({}).commit, null);
    assert.equal(OPS.buildInfo({ RENDER_GIT_COMMIT: 'not a sha!' }).commit, null);
    assert.equal(OPS.buildInfo({}).started_at, a.started_at);
  });
  await ok('index.ts /health spreads buildInfo() into both answers (up and db down)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/index.ts'), 'utf8');
    const h = src.slice(src.indexOf("app.get('/health',"), src.indexOf("app.get('/health/schema'"));
    assert.equal((h.match(/\.\.\.buildInfo\(\)/g) ?? []).length, 2, 'both the 200 and the 503 answer');
    assert.ok(/void recordBoot\(\)/.test(src.slice(src.indexOf('app.listen('))), 'the start is recorded after listen');
  });
  await ok('the admin portal: System in the menu for super admins only, and the page itself gated', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/admin/src/AdminPortal.tsx'), 'utf8');
    assert.match(src, /\{ id: "system",[^}]*superOnly: true \}/);
    assert.match(src, /page === "system" && admin\?\.role === "super_admin"\) return <SystemPage/);
    const page = fs.readFileSync(path.join(ROOT, 'apps/admin/src/SystemPage.tsx'), 'utf8');
    for (const s of ['/ops/summary', '/ops/events?', 'what_to_do', 'isSemVerMajor', 'AdminPager']) assert.ok(page.includes(s), s);
  });
  await ok('the token compare: equal only when equal, whatever the lengths', async () => {
    assert.equal(OPS.tokenMatches(TOKEN, TOKEN), true);
    assert.equal(OPS.tokenMatches(TOKEN + 'x', TOKEN), false);
    assert.equal(OPS.tokenMatches('', TOKEN), false);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
