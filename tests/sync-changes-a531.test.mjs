// A531 — change-triggered sync, the cloud's half: only the rows that changed, pushed when they change, compressed, and the
// menu built once per version.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/sync-changes-a531.test.mjs
//
// Owner, 2026-10-19: "the till does not have to check, the trigger should happen instantly — if I change fries from 100 to
// 150 the trigger should only send the affected product and price, not the whole menu (70 products → 69 needless); if
// Eugene's PIN changes only Eugene's change gets synced, not all 150 staff." Measured after A528: /api/pos 5.0 MB in 36 min
// across ~4 tills (the whole /init every 10 minutes per till).
//
// RUNS the COMPILED server (routes/index.js behind the real requireAuth, apiHelmet, the traffic counter and compressJson;
// lib/liveHub.js on a real HTTP server with a real WebSocket client) over HTTP; the database in memory (tests/lib-memdb.mjs)
// — the change log's SQL (triggers, sync_changes_since, heads, prune) is run for real in scripts/test-migration-151.mjs;
// here the two functions are stood in by the same rules, so what is tested is what the server does with their rows.
//
//   Z  compression: a big JSON answer gzip-compressed with its real (smaller) length, which the traffic counter counts; a
//      small one, a client that does not accept it, an update file path and a redirect are not.
//   I  /init built once per version: a second till costs no database read; a new version is rebuilt; another business /
//      branch never gets this one's; cost prices removed per caller after the cache (a till none, the owner's present).
//   C  /changes: fries 100 → 150 is ONE product row (its new price, this branch's price, no cost); Eugene's PIN ONE staff
//      row (the roster row with its bcrypt hash to the till's own session only); a delete is a marker; another branch's
//      table never reaches the till; another business's product named in an entry is a delete marker (nothing leaks);
//      paging (500 + more); full_resync_needed behind the floor; a settings change is its topic's keys only; the answer
//      is shared 5 s by the business's tills; before migration 151: 404 CHANGES_UNAVAILABLE.
//   W  the push channel: a bad token, a revoked till, a person's session are refused; a till is answered `ready`; a write
//      through the API rings its business's tills within a second; a change made in SQL rings on the 5 s read; another
//      business's change never rings; the upgrade answer is signed (A529).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
//   - compressJson's size floor removed                                            → Z "not compressed" fails
//   - posInit.ts initAnswer without the kept-answer return                         → I "no database read" fails
//   - pos.ts sending built.body without stripFields for a till                      → I "a till gets no cost" fails
//   - syncChanges.ts rowsFor products without the business filter                   → C "nothing leaks" fails
//   - syncChanges.ts staff without the isTill gate on roster                        → C "only to the till" fails
//   - syncChanges.ts tables without the branch check                                → C "another branch's table" fails
//   - forgetOnWrite.ts without nudge()                                              → W "a write rings" fails
//   - liveHub.ts without the till-only check                                        → W "a person's session refused" fails
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/syncChanges.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const TR = require(path.join(DIST, 'lib/trafficStats.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SC = require(path.join(DIST, 'lib/syncChanges.js'));
const LH = require(path.join(DIST, 'lib/liveHub.js'));
const { compressJson } = require(path.join(DIST, 'lib/compressJson.js'));
const WebSocket = require('ws');
const warn = console.warn; console.warn = () => {};

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', EUGENE = 'aaaaaaaa-0000-4000-8000-000000000003';
const pid = (i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
const FRIES = pid(0);
const perms = (...keys) => ({ name: 'Cashier', role_permissions: keys.map((key) => ({ permissions: { key } })) });

// The change log, as public.sync_changes_since / sync_changes_heads answer (migration 151 — tested in PGlite).
let rpcCalls = [];
mem.rpc = async (name, a) => {
  rpcCalls.push({ name, a });
  if (mem.rpcError) return { data: null, error: mem.rpcError };
  const all = (mem.db.sync_changes ?? []).slice().sort((x, y) => x.seq - y.seq);
  if (name === 'sync_changes_since') {
    return { data: all.filter((c) => c.business_id === a.p_business && c.seq > a.p_since
      && (!c.branch_id || !a.p_branch || c.branch_id === a.p_branch)).slice(0, a.p_limit), error: null };
  }
  if (name === 'sync_changes_heads') {
    const by = new Map();
    for (const c of all.filter((c) => c.seq > a.p_after)) {
      const h = by.get(c.business_id) ?? { business_id: c.business_id, max_seq: 0, n: 0, topics: [] };
      h.max_seq = Math.max(h.max_seq, c.seq); h.n++; if (!h.topics.includes(c.topic)) h.topics.push(c.topic);
      by.set(c.business_id, h);
    }
    return { data: [...by.values()], error: null };
  }
  return { data: null, error: null };
};
let seq = 10;
const logChange = (biz, table_name, row_id, op = 'upsert', topic = 'menu', branch_id = null) =>
  mem.db.sync_changes.push({ seq: ++seq, business_id: biz, branch_id, topic, table_name, row_id, op, changed_at: new Date(Date.now() - 10_000).toISOString() });

const reset = () => {
  mem.fail = () => null; mem.calls = []; mem.rpcError = null; rpcCalls = []; seq = 10;
  SV._resetSyncVersions(); AC._resetAuthCache(); TR._resetTraffic(); PI._resetInitCache(); SC._resetSyncChanges();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', type: 'restaurant', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'retail', currency: 'KES', vat_rate: 16, status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true },
      { id: BR2, business_id: B, name: 'CBD', is_main: false, desktop_licensed: true },
      { id: BRX, business_id: B2, name: 'Theirs', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 1, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      ...Array.from({ length: 150 }, (_, i) => ({ id: i === 0 ? EUGENE : `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, name: i === 0 ? 'Eugene' : `Staff ${i}`,
        status: 'active', business_id: B, permissions_version: 1, role_id: 'role-c', pin_hash: `$2b$10$${'x'.repeat(53)}${i}`,
        roles: perms('orders.create'), user_branches: [], user_permissions: [] }))],
    user_devices: [
      { id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER },
      { id: 'ud-3', business_id: B, device_id: 'dev-T3', status: 'blocked', retired_at: null, branch_id: BR, user_id: OWNER },
      { id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: BRX, user_id: 'x' },
    ],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }, { business_id: B, topic: 'staff', version: 3 }, { business_id: B2, topic: 'catalogue', version: 40 }],
    products: [
      ...Array.from({ length: 70 }, (_, i) => ({ id: pid(i), business_id: B, name: i === 0 ? 'Fries' : `Item ${i} with a longer menu description`, base_price: i === 0 ? 150 : 100 + i,
        cost_price: 40, status: 'active', is_combo: false, category_id: 'cat-1', categories: { name: 'Sides', color: '#f97316' } })),
      { id: 'theirs-1', business_id: B2, name: 'Their secret', base_price: 999, cost_price: 1, status: 'active', is_combo: false },
    ],
    branch_prices: [{ id: 'bp-1', business_id: B, branch_id: BR, product_id: FRIES, price: 140 }, { id: 'bp-2', business_id: B, branch_id: BR2, product_id: FRIES, price: 160 }],
    categories: [{ id: 'cat-1', business_id: B, name: 'Sides', status: 'active', sort_order: 1 }],
    tables: [{ id: 't-here', business_id: B, branch_id: BR, name: 'T1', status: 'active' }, { id: 't-there', business_id: B, branch_id: BR2, name: 'T9', status: 'active' }],
    business_settings: [{ business_id: B, key: 'receipt_footer', value: 'Asante' }], branch_settings: [], feature_flags: [], business_branding: [],
    payment_methods: [{ business_id: B, code: 'voucher', name: 'Voucher', is_active: true, sort_order: 1 }],
    offers: [], promotions: [], stock_takes: [], variant_groups: [], modifier_groups: [], combo_items: [],
    sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }],
    refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(require(path.join(DIST, 'lib/apiHeaders.js')).apiHelmet());
app.use(TR.countTraffic);
app.use(compressJson);
app.use(express.json());
// The compression cases' own routes (an update file path, a redirect, a small and a big answer).
app.get('/z/big', (_q, res) => res.json({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row ${i}` })) }));
app.get('/z/small', (_q, res) => res.json({ ok: true }));
app.get('/api/desktop-update/big', (_q, res) => res.json({ rows: Array.from({ length: 200 }, (_, i) => ({ i })) }));
app.get('/z/redirect', (_q, res) => res.redirect(302, 'https://github.com/x/y/releases/download/v1/ZapTill.exe'));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
LH.attachLiveHub(server);
const port = server.address().port;
const sign = (p, exp = '5m') => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: exp });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  till1: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till3: sign({ userId: null, deviceId: 'dev-T3', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  tillX: sign({ userId: null, businessId: B2, branchId: BRX, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, body: json, text };
};
/** The raw bytes and headers as they cross the wire (Node's fetch unpacks gzip by itself). */
const raw = (p, token, accept = 'gzip, deflate') => new Promise((resolve, reject) => {
  const h = { ...(accept ? { 'accept-encoding': accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  http.get({ host: '127.0.0.1', port, path: p, headers: h }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
const reads = (table) => mem.calls.filter((c) => c.table === table && c.op === 'select').length;
const tillGet = (p, tok = T.till1, dev = 'dev-T1') => call('GET', p, tok, undefined, { 'x-device-id': dev });

try {
  state._setPermissionsMigrated(true);
  console.log('\nZ. compression\n');
  await ok('a big JSON answer: gzip, its real (smaller) length, and the traffic counter counts the bytes sent', async () => {
    reset();
    const r = await raw('/z/big');
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(Number(r.headers['content-length']), r.body.length);
    const plain = zlib.gunzipSync(r.body);
    assert.ok(r.body.length < plain.length / 3, `${r.body.length} vs ${plain.length}`);
    assert.equal(JSON.parse(plain).rows.length, 200);
    assert.match(String(r.headers.vary ?? ''), /Accept-Encoding/i);
    const fam = TR.trafficSnapshot().routes.find((x) => x.family === '/z/big');
    assert.equal(fam?.bytes, r.body.length);
  });
  await ok('not compressed: a small answer, a client that does not ask, an update file path, a redirect', async () => {
    assert.equal((await raw('/z/small')).headers['content-encoding'], undefined);
    assert.equal((await raw('/z/big', null, '')).headers['content-encoding'], undefined);
    assert.equal((await raw('/api/desktop-update/big')).headers['content-encoding'], undefined);
    const red = await raw('/z/redirect');
    assert.equal(red.status, 302); assert.equal(red.headers['content-encoding'], undefined);
  });
  await ok('/api/pos/init to a till: gzip on the wire, the same answer unpacked', async () => {
    reset();
    const r = await raw(`/api/pos/init?branch_id=${BR}`, T.till1);
    assert.equal(r.status, 200, String(r.body).slice(0, 200));
    assert.equal(r.headers['content-encoding'], 'gzip');
    const body = JSON.parse(zlib.gunzipSync(r.body));
    assert.equal(body.products.length, 70);
    console.log(`      (init: ${zlib.gunzipSync(r.body).length} bytes of JSON, ${r.body.length} on the wire)`);
  });

  console.log('\nI. /init built once per version\n');
  await ok('a second till of the business: no database read for the menu at all (only its own sign-in row)', async () => {
    reset();
    assert.equal((await tillGet(`/api/pos/init?branch_id=${BR}`)).status, 200);
    assert.ok(reads('products') > 0);
    mem.calls = [];
    const r2 = await tillGet(`/api/pos/init?branch_id=${BR}`, T.till2, 'dev-T2');
    assert.equal(r2.status, 200); assert.equal(r2.body.products.length, 70);
    const other = mem.calls.filter((c) => c.table !== 'user_devices');
    assert.deepEqual(other.map((c) => c.table), [], 'only the till row');
  });
  await ok('a new catalogue version is built again (the change is in it)', async () => {
    reset();
    await tillGet(`/api/pos/init?branch_id=${BR}`);
    mem.db.products[0].base_price = 175; mem.db.sync_versions[0].version = 8; SV.forgetTopic(B, 'catalogue');
    const r = await tillGet(`/api/pos/init?branch_id=${BR}`);
    assert.equal(r.body.products.find((p) => p.id === FRIES).base_price, 175);
  });
  await ok('another business and another branch never get this one\'s answer', async () => {
    reset();
    await tillGet(`/api/pos/init?branch_id=${BR}`);
    const x = await call('GET', `/api/pos/init?branch_id=${BRX}`, T.tillX, undefined, { 'x-device-id': 'dev-X' });
    assert.equal(x.status, 200);
    assert.deepEqual(x.body.products.map((p) => p.id), ['theirs-1']);
    const cbd = await tillGet(`/api/pos/init?branch_id=${BR2}`);
    assert.equal(cbd.body.products.find((p) => p.id === FRIES).branch_price, 160);
    assert.equal((await tillGet(`/api/pos/init?branch_id=${BR}`)).body.products.find((p) => p.id === FRIES).branch_price, 140);
  });
  await ok('per caller after the cache: a till gets no cost price, the owner (same kept answer) does', async () => {
    reset();
    const t = await tillGet(`/api/pos/init?branch_id=${BR}`);
    assert.equal(t.body.products[0].cost_price, undefined);
    mem.calls = [];
    const o = await call('GET', `/api/pos/init?branch_id=${BR}`, T.owner);
    assert.equal(o.body.products[0].cost_price, 40);
    assert.equal(reads('products'), 0, 'the owner was answered from the kept answer');
  });
  await ok('the desktop licence gate stays per request (a till at an unlicensed branch is refused, the kept answer or not)', async () => {
    reset();
    mem.db.branches[1].desktop_licensed = false;
    const r = await tillGet(`/api/pos/init?branch_id=${BR2}`);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'BRANCH_NOT_LICENSED');
  });

  console.log('\nC. /changes — only the rows that changed\n');
  await ok('no `since`: where the log is now', async () => {
    reset(); logChange(B, 'categories', 'cat-1'); logChange(B2, 'products', 'theirs-1');
    const r = await tillGet('/api/pos/changes');
    assert.equal(r.status, 200); assert.deepEqual(r.body, { last_seq: 11, changes: [] });
  });
  let friesBytes = 0, eugeneBytes = 0;
  await ok('fries 100 → 150: ONE product row — its new price, this branch\'s price, no cost, nothing else', async () => {
    reset(); mem.db.products[0].base_price = 150;
    logChange(B, 'products', FRIES);
    const r = await raw(`/api/pos/changes?since=10&branch_id=${BR}`, T.till1);
    const text = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body).toString() : r.body.toString();
    const body = JSON.parse(text);
    friesBytes = r.body.length;
    assert.equal(body.last_seq, 11);
    assert.equal(body.changes.length, 1);
    const c = body.changes[0];
    assert.deepEqual([c.table, c.id, c.op, c.topic], ['products', FRIES, 'upsert', 'menu']);
    assert.equal(c.row.product.base_price, 150); assert.equal(c.row.product.branch_price, 140);
    assert.equal(c.row.product.cost_price, undefined);
    assert.equal(c.row.product.categories.name, 'Sides');
    assert.ok(friesBytes < 1000, `${friesBytes} bytes`);
    console.log(`      (fries: ${friesBytes} bytes on the wire, ${text.length} bytes of JSON)`);
  });
  await ok('Eugene\'s PIN: ONE staff row — his roster row with the bcrypt hash, to the till\'s own session only', async () => {
    reset(); mem.db.users[1].pin_hash = '$2b$10$' + 'n'.repeat(53);
    logChange(B, 'staff', EUGENE, 'upsert', 'staff');
    const r = await raw(`/api/pos/changes?since=10&branch_id=${BR}`, T.till1);
    eugeneBytes = r.body.length;
    const body = JSON.parse(r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);
    assert.equal(body.changes.length, 1);
    const row = body.changes[0].row;
    assert.equal(row.user.name, 'Eugene');
    assert.equal(row.roster.staff_id, EUGENE); assert.equal(row.roster.pin_hash, '$2b$10$' + 'n'.repeat(53));
    assert.equal(row.roster.override_pin_hash, null); assert.equal(row.roster.branch_id, BR);
    assert.equal(row.roster.permissions['orders.create'], true);
    const o = await call('GET', `/api/pos/changes?since=10&branch_id=${BR}`, T.owner);
    assert.equal(o.body.changes.length, 1); assert.ok(!('roster' in o.body.changes[0].row), 'no PIN hash to a person');
    console.log(`      (Eugene: ${eugeneBytes} bytes on the wire)`);
  });
  await ok('a delete is a marker (no row); a product switched off is a delete too', async () => {
    reset();
    logChange(B, 'products', 'gone-product', 'delete');
    mem.db.products[1].status = 'inactive'; logChange(B, 'products', pid(1));
    const r = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    assert.deepEqual(r.body.changes.map((c) => [c.id, c.op, 'row' in c]), [['gone-product', 'delete', false], [pid(1), 'delete', false]]);
  });
  await ok('another branch\'s table never reaches the till (a marker to drop it if it had it)', async () => {
    reset();
    logChange(B, 'tables', 't-there', 'upsert', 'setup'); logChange(B, 'tables', 't-here', 'upsert', 'setup');
    const r = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    const there = r.body.changes.find((c) => c.id === 't-there');
    assert.equal(there.op, 'delete'); assert.ok(!('row' in there));
    assert.equal(r.body.changes.find((c) => c.id === 't-here').row.name, 'T1');
  });
  await ok('nothing of another business: its product named in an entry is a marker; the log is read by this business only', async () => {
    reset();
    logChange(B, 'products', 'theirs-1');
    logChange(B2, 'products', 'theirs-1');
    const r = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    assert.deepEqual(r.body.changes.map((c) => [c.id, c.op]), [['theirs-1', 'delete']]);
    assert.ok(!r.text.includes('Their secret'));
    assert.ok(rpcCalls.every((c) => c.name !== 'sync_changes_since' || c.a.p_business === B));
  });
  await ok('a settings change: its topic\'s keys only (money: payment methods, VAT …), never the menu', async () => {
    reset();
    logChange(B, 'config', 'money', 'upsert', 'money');
    const r = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    const c = r.body.changes[0];
    assert.equal(c.table, 'config'); assert.equal(c.id, 'money');
    assert.deepEqual(c.row.paymentMethods, [{ code: 'voucher', name: 'Voucher' }]);
    assert.equal(c.row.vatRate, 16);
    assert.ok(!('products' in c.row) && !('receiptFooter' in c.row) && !('branding' in c.row));
  });
  await ok('paging: 500 entries a page and `more`; the next page from last_seq', async () => {
    reset();
    for (let i = 0; i < 501; i++) logChange(B, 'categories', `c-${i}`);
    const r1 = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    assert.equal(r1.body.changes.length, 500); assert.equal(r1.body.more, true); assert.equal(r1.body.last_seq, 510);
    const r2 = await tillGet(`/api/pos/changes?since=510&branch_id=${BR}`);
    assert.equal(r2.body.changes.length, 1); assert.ok(!r2.body.more);
  });
  await ok('behind the floor (pruned): full_resync_needed', async () => {
    reset(); mem.db.sync_change_floor[0].floor_seq = 100; logChange(B, 'categories', 'cat-1');
    const r = await tillGet(`/api/pos/changes?since=50&branch_id=${BR}`);
    assert.equal(r.body.full_resync_needed, true); assert.deepEqual(r.body.changes, []);
  });
  await ok('the tills of a business that heard the same push share one answer (5 s): no second read', async () => {
    reset(); logChange(B, 'products', FRIES);
    await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    mem.calls = []; rpcCalls = [];
    await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`, T.till2, 'dev-T2');
    assert.equal(rpcCalls.length, 0); assert.equal(reads('products'), 0);
  });
  await ok('before migration 151: 404 CHANGES_UNAVAILABLE (the till keeps its old way); a busy database: 503', async () => {
    reset(); mem.rpcError = { code: 'PGRST202', message: 'Could not find the function public.sync_changes_since' };
    const r = await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`);
    assert.equal(r.status, 404); assert.equal(r.body.code, 'CHANGES_UNAVAILABLE');
    SC._resetSyncChanges(); mem.rpcError = { code: '57014', message: 'canceling statement due to statement timeout' };
    assert.equal((await tillGet(`/api/pos/changes?since=10&branch_id=${BR}`)).status, 503);
  });

  console.log('\nW. the push channel\n');
  const connect = (token) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pos/live`);
    const got = []; let headers = null;
    ws.on('upgrade', (res) => { headers = res.headers; });
    ws.on('open', () => { if (token) ws.send(JSON.stringify({ type: 'hello', token })); });
    ws.on('message', (m) => { got.push(JSON.parse(String(m))); });
    ws.on('close', (code) => { ws.closedWith = code; });
    setTimeout(() => resolve({ ws, got, headers: () => headers }), 400);
  });
  const until = async (f, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  await ok('refused: a bad token (4001), a blocked till (4001), a person\'s session (4003)', async () => {
    reset();
    const bad = await connect('not-a-token');
    assert.ok(await until(() => bad.ws.closedWith === 4001), `closed ${bad.ws.closedWith}`);
    const blocked = await connect(T.till3);
    assert.ok(await until(() => blocked.ws.closedWith === 4001), `closed ${blocked.ws.closedWith}`);
    const person = await connect(T.owner);
    assert.ok(await until(() => person.ws.closedWith === 4003), `closed ${person.ws.closedWith}`);
    assert.equal(LH.liveCount(), 0);
  });
  await ok('a till: `ready` with where the log is; the upgrade answer is signed (X-ZapTill-Server)', async () => {
    reset(); logChange(B, 'categories', 'cat-1');
    const c = await connect(T.till1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    assert.equal(c.got.find((m) => m.type === 'ready').last_seq, 11);
    assert.equal(c.headers()['x-zaptill-server'], '1');
    c.ws.close();
  });
  await ok('a write through the API rings the business\'s tills within a second; another business\'s till hears nothing', async () => {
    reset();
    const mine = await connect(T.till1);
    const theirs = await connect(T.tillX);
    assert.ok(await until(() => mine.got.some((m) => m.type === 'ready') && theirs.got.some((m) => m.type === 'ready')));
    const w = await call('POST', '/api/categories', T.owner, { name: 'Drinks' });
    assert.ok(w.status < 300, JSON.stringify(w.body));
    logChange(B, 'categories', 'new-cat');                    // what the trigger writes (migration 151)
    assert.ok(await until(() => mine.got.some((m) => m.type === 'changed'), 1500), JSON.stringify(mine.got));
    assert.equal(mine.got.find((m) => m.type === 'changed').last_seq, 11);
    assert.ok(!theirs.got.some((m) => m.type === 'changed'));
    mine.ws.close(); theirs.ws.close();
  });
  await ok('a change made in SQL (no write through this server) rings on the 5 s read — one read for every business', async () => {
    reset();
    assert.equal(LH.HEADS_EVERY_MS, 5000);
    const c = await connect(T.till1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    await LH.headsTick();                                     // the first read notes where the log is
    logChange(B, 'products', FRIES);
    rpcCalls = [];
    await LH.headsTick();
    assert.equal(rpcCalls.filter((x) => x.name === 'sync_changes_heads').length, 1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'changed' && m.topics.includes('menu'))), JSON.stringify(c.got));
    c.ws.close();
  });
  await ok('a change to the business\'s tills (forgetOnWrite `tills` → recheckBusiness) closes its sockets: they sign in again (a blocked till is refused — above)', async () => {
    reset();
    const c = await connect(T.till1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    LH.recheckBusiness(B);
    assert.ok(await until(() => c.ws.closedWith === 4001));
  });

  // A554 (B Foods' log, 2026-10-21: "push channel closed (1006)" every ~13 minutes — the till renews its 15-minute token
  // every 13 and the socket ended with the token it signed in with).
  console.log('\nW (A554). the renewed token on the open socket, the keepalive\n');
  const expOf = (t) => jwt.decode(t).exp * 1000;
  await ok('A554: `ready` names what the till may send after its hello (ping, reauth)', async () => {
    reset();
    const c = await connect(T.till1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    assert.deepEqual(c.got.find((m) => m.type === 'ready').features, ['ping', 'reauth']);
    c.ws.close();
  });
  await ok('A554: { type: ping } → pong (the till\'s own keepalive)', async () => {
    reset();
    const c = await connect(T.till1);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    assert.ok(await until(() => c.got.some((m) => m.type === 'pong')), JSON.stringify(c.got));
    c.ws.close();
  });
  await ok('A554: the till\'s renewed token on the open socket → reauthed; the socket now ends with the NEW token (nothing closed)', async () => {
    reset();
    const first = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }, '2m');
    const renewed = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }, '15m');
    const c = await connect(first);
    assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
    assert.equal(LH._liveConnsForTest()[0].exp, expOf(first));
    c.ws.send(JSON.stringify({ type: 'reauth', token: renewed }));
    assert.ok(await until(() => c.got.some((m) => m.type === 'reauthed')), JSON.stringify(c.got));
    assert.equal(LH._liveConnsForTest()[0].exp, expOf(renewed));
    assert.equal(c.ws.closedWith, undefined); assert.equal(LH.liveCount(), 1);
    c.ws.close();
  });
  await ok('A554: a reauth with another till\'s token, another business\'s, a person\'s or a bad one is refused (4001) — never adopted', async () => {
    for (const bad of [T.till2, T.tillX, T.owner, 'not-a-token']) {
      reset();
      const c = await connect(T.till1);
      assert.ok(await until(() => c.got.some((m) => m.type === 'ready')));
      c.ws.send(JSON.stringify({ type: 'reauth', token: bad }));
      assert.ok(await until(() => c.ws.closedWith === 4001), `closed ${c.ws.closedWith}`);
      assert.ok(!c.got.some((m) => m.type === 'reauthed'));
    }
  });
} finally {
  console.warn = warn;
  LH._resetLiveHub();
  server.close();
  server.closeAllConnections?.();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
