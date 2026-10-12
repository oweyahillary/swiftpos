/**
 * till-changes-cloud.test.mjs — A448: the cloud's side of a change made on a till. RUNS the built route
 * (apps/server/dist/routes/changes.js, lib/changeApply.js) over real HTTP against an in-memory database: a till's change is
 * applied, identical (kept once, the till told the cloud's id), awaiting the owner (a clash — not applied, the owner
 * notified), or refused (with the reason); the owner decides; a PIN set on a till wins over the cloud's unless another
 * person has it; who may send and who may decide.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/till-changes-cloud.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: judgeUpdate ignoring `base` (always apply) → "a clash is not applied" fails; the maker's
 * permission not checked → "a cashier's change sent by the till is refused" fails; mayDecide letting a till token decide →
 * "a till cannot decide" fails; pinTakenBy skipped for staff_pin → "a PIN another person has is refused" fails; the
 * replay check removed → "sent twice, answered the same" fails; decideChange writing to entity_id, not canonical_id →
 * "approve writes to the cloud's own row" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

if (!fs.existsSync(path.join(DIST, 'routes/changes.js'))) {
  console.log('\nCannot load apps/server/dist/routes/changes.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const bcrypt = require('bcrypt');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444', ABDI = '55555555-5555-4555-8555-555555555555', TOM = '66666666-6666-4666-8666-666666666666';
const AMY = '77777777-7777-4777-8777-777777777777', MARY = '88888888-8888-4888-8888-888888888888';
const R_MGR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', R_CASH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', R_OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOOD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', BURGER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', GRILL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const perms = (...keys) => ({ role_permissions: keys.map((key) => ({ permissions: { key } })) });

const db = {
  businesses: [{ id: BZ, owner_id: OWNER }],
  roles: [{ id: R_MGR, name: 'manager' }, { id: R_CASH, name: 'cashier' }, { id: R_OWNER, name: 'owner' }],
  users: [
    { id: OWNER, business_id: BZ, name: 'Owner', status: 'active', permissions_version: 0, pin_hash: null, roles: perms('*'), user_permissions: [] },
    { id: ABDI, business_id: BZ, name: 'Abdi', status: 'active', permissions_version: 0, pin_hash: null,
      roles: perms('products.manage', 'stations.manage', 'staff.manage'), user_permissions: [] },
    { id: TOM, business_id: BZ, name: 'Tom', status: 'active', permissions_version: 0, pin_hash: null, roles: perms('orders.create'), user_permissions: [] },
    { id: AMY, business_id: BZ, name: 'Amy', status: 'active', permissions_version: 0, pin_hash: bcrypt.hashSync('1111', 4), roles: perms(), user_permissions: [] },
    { id: MARY, business_id: BZ, name: 'Mary', status: 'active', permissions_version: 0, pin_hash: bcrypt.hashSync('9999', 4), roles: perms(), user_permissions: [] },
  ],
  user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null }],
  categories: [{ id: FOOD, business_id: BZ, name: 'Food', status: 'active', sort_order: 0, is_kitchen: false, color: null, icon: null }],
  products: [{ id: BURGER, business_id: BZ, name: 'Burger', base_price: 700, category_id: FOOD, status: 'active', barcode: '600100' }],
  print_stations: [{ id: GRILL, business_id: BZ, branch_id: BR, name: 'Grill', kind: 'kitchen', sort_order: 0, active: true }],
  change_requests: [], notifications: [], user_branches: [],
};

// A small in-memory PostgREST: select / eq / neq / in / is / ilike / order / limit / maybeSingle / single / insert / update / delete.
const likeRe = (pat) => new RegExp('^' + String(pat).replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]])/g,
  (m, esc, wild, re) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : wild ? (wild === '%' ? '.*' : '.') : '\\' + re) + '$', 'is');
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      for (const p of [].concat(payload)) {
        if (p.id && db[table].some((r) => r.id === p.id)) return { data: null, error: { code: '23505', message: 'duplicate' } };
        db[table].push({ id: p.id ?? randomUUID(), created_at: new Date().toISOString(), received_at: new Date().toISOString(), ...p });
      }
      return { data: null, error: null };
    }
    if (op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
    if (op === 'delete') { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    const r = rows();
    return { data: r, error: null, count: r.length };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'insert') return (row) => { op = 'insert'; payload = row; return q; };
      if (prop === 'update') return (row) => { op = 'update'; payload = row; return q; };
      if (prop === 'delete') return () => { op = 'delete'; return q; };
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'ilike') return (k, p) => { const re = likeRe(p); f.push((r) => re.test(String(r[k] ?? ''))); return q; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); };
      if (prop === 'single') return () => { const d = run().data?.[0]; return Promise.resolve(d ? { data: d, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/changes', require(path.join(DIST, 'routes/changes.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/changes`;
const TOKENS = {
  till:  { till: true, deviceId: 'dev-T1', businessId: BZ, branchId: BR, permissionKeys: ['*'], surface: 'desktop', permissionsVersion: 0 },
  owner: { userId: OWNER, businessId: BZ, branchId: null, isOwner: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'dashboard' },
  abdi:  { userId: ABDI, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['products.manage', 'stations.manage', 'staff.manage'], permissionsVersion: 0, sessionId: 's', surface: 'desktop', pinSignIn: true },
};
const call = async (who, method, url = '', body) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { Authorization: `Bearer ${jwt.sign(TOKENS[who], process.env.JWT_SECRET)}`, 'content-type': 'application/json', 'x-branch-id': BR },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const change = (entity, op, entity_id, data, base = null, made_by = ABDI, made_by_name = 'Abdi') =>
  ({ id: randomUUID(), entity, op, entity_id, base, data, made_by, made_by_name, made_at: new Date().toISOString() });
const send = async (who, ...changes) => (await call(who, 'POST', '', { changes })).body?.results ?? [];
const product = () => db.products.find((p) => p.id === BURGER);

console.log('\nA till\'s change reaches the cloud\n');
await ok('a station made on an offline till is applied — the till\'s session sends it after the manager signed out', async () => {
  const id = randomUUID();
  const [r] = await send('till', change('station', 'create', id, { name: 'Barista', kind: 'kitchen' }));
  const st = db.print_stations.find((s) => s.id === id);
  assert(r.status === 'applied' && st?.branch_id === BR && st.active === true, JSON.stringify(r));
});
await ok('a price nobody else changed is applied (the cloud still held what the till saw)', async () => {
  const [r] = await send('till', change('product', 'update', BURGER, { base_price: 750 }, { base_price: 700 }));
  assert(r.status === 'applied' && product().base_price === 750, JSON.stringify(r));
});
await ok('sent twice, answered the same — and applied once', async () => {
  const c = change('product', 'update', BURGER, { base_price: 760 }, { base_price: 750 });
  const [a] = await send('till', c); product().base_price = 1;   // anything after it
  const [b] = await send('till', c);
  assert(a.status === 'applied' && b.status === 'applied' && product().base_price === 1 && db.change_requests.filter((x) => x.id === c.id).length === 1, JSON.stringify([a, b]));
  product().base_price = 760;
});
await ok('the same change made on the cloud too is identical, not a clash (the till\'s 1 is the cloud\'s true)', async () => {
  const [r] = await send('till', change('product', 'update', BURGER, { base_price: 760 }, { base_price: 700 }));
  const [s] = await send('till', change('category', 'update', FOOD, { is_kitchen: 0 }, { is_kitchen: 1 }));
  assert(r.status === 'identical' && s.status === 'identical', JSON.stringify([r, s]));
});
await ok('the same station made on the web and on a till is kept once: the till is told the cloud\'s id', async () => {
  const [r] = await send('till', change('station', 'create', randomUUID(), { name: 'grill', kind: 'kitchen' }));
  assert(r.status === 'identical' && r.canonical_id === GRILL && db.print_stations.filter((s) => /grill/i.test(s.name)).length === 1, JSON.stringify(r));
});
await ok('a name with % in it is matched as written, not as a pattern', async () => {
  const [r] = await send('till', change('station', 'create', randomUUID(), { name: 'G%', kind: 'kitchen' }));
  assert(r.status === 'applied' && !r.canonical_id, JSON.stringify(r));
});

console.log('\nDifferent changes to the same thing: the owner decides\n');
let clash;
await ok('a clash is not applied: it waits, with the cloud\'s value, and the owner is notified', async () => {
  product().base_price = 720;   // the web changed it after the till last saw 760
  const c = change('product', 'update', BURGER, { base_price: 800 }, { base_price: 760 });
  const [r] = await send('till', c);
  clash = db.change_requests.find((x) => x.id === c.id);
  const note = db.notifications.find((n) => n.message.includes(`[change:${c.id}]`));
  assert(r.status === 'awaiting' && product().base_price === 720 && clash.cloud_value.base_price === 720 && note?.user_id === OWNER
    && note.link === '/dashboard/approvals', JSON.stringify({ r, clash, note }));
});
await ok('the owner sees it, with the till\'s value next to the cloud\'s', async () => {
  const r = await call('owner', 'GET', '?status=awaiting');
  const row = r.body.find((x) => x.id === clash.id);
  assert(r.status === 200 && row?.proposed.base_price === 800 && row.cloud_value.base_price === 720 && /product/i.test(row.summary), JSON.stringify(r.body));
});
await ok('a till cannot see or decide them (its session carries * but is no person); a manager without settings.manage neither', async () => {
  const a = await call('till', 'GET', '?status=awaiting');
  const b = await call('till', 'POST', `/${clash.id}/decide`, { approve: true });
  const c = await call('abdi', 'POST', `/${clash.id}/decide`, { approve: true });
  assert(a.status === 403 && b.status === 403 && c.status === 403 && product().base_price === 720, `${a.status} ${b.status} ${c.status}`);
});
await ok('the owner approves: the till\'s value is applied, the till hears "approved", the notification is read', async () => {
  const r = await call('owner', 'POST', `/${clash.id}/decide`, { approve: true });
  const s = await call('till', 'GET', `/state?ids=${clash.id}`);
  assert(r.status === 200 && product().base_price === 800 && s.body[0]?.status === 'approved' && s.body[0].decided_by_name === 'Owner'
    && db.notifications.find((n) => n.message.includes(clash.id)).read_at, JSON.stringify({ r, s }));
  const again = await call('owner', 'POST', `/${clash.id}/decide`, { approve: false });
  assert(again.status === 409 && product().base_price === 800, 'decided once');
});
await ok('the owner keeps the cloud\'s: nothing changes on the cloud, the till hears "rejected"', async () => {
  product().name = 'Beef Burger';
  const c = change('product', 'update', BURGER, { name: 'Big Burger' }, { name: 'Burger' });
  await send('till', c);
  const r = await call('owner', 'POST', `/${c.id}/decide`, { approve: false });
  const s = await call('till', 'GET', `/state?ids=${c.id}`);
  assert(r.status === 200 && product().name === 'Beef Burger' && s.body[0]?.status === 'rejected', JSON.stringify(s.body));
});
await ok('approve writes to the cloud\'s own row when it had the same thing under another id', async () => {
  const c = change('station', 'create', randomUUID(), { name: 'Grill', kind: 'dispatch' });   // the cloud's Grill is kitchen
  const [r] = await send('till', c);
  await call('owner', 'POST', `/${c.id}/decide`, { approve: true });
  assert(r.status === 'awaiting' && r.canonical_id === GRILL && db.print_stations.find((s) => s.id === GRILL).kind === 'dispatch'
    && !db.print_stations.some((s) => s.id === c.entity_id), JSON.stringify(r));
});

await ok('A450: the web’s Approvals badge counts what waits — for the owner; 0 for a till or a manager', async () => {
  const before = db.change_requests.filter((x) => x.status === 'awaiting').length;
  product().base_price = 900;
  await send('till', change('product', 'update', BURGER, { base_price: 950 }, { base_price: 800 }));
  const o = await call('owner', 'GET', '/count'), t = await call('till', 'GET', '/count'), m = await call('abdi', 'GET', '/count');
  assert(o.status === 200 && o.body.count === before + 1 && t.body.count === 0 && m.body.count === 0, JSON.stringify([o.body, t.body, m.body, before]));
  product().base_price = 800;
});

console.log('\nWho may\n');
await ok('a cashier\'s change sent by the till is refused (the maker\'s own permissions are checked)', async () => {
  const [r] = await send('till', change('product', 'update', BURGER, { base_price: 1 }, { base_price: 800 }, TOM, 'Tom'));
  assert(r.status === 'refused' && /Tom may not/.test(r.message) && product().base_price === 800, JSON.stringify(r));
});
await ok('a manager signed in sends with their own keys', async () => {
  const [r] = await send('abdi', change('category', 'create', randomUUID(), { name: 'Desserts' }));
  assert(r.status === 'applied' && db.categories.some((x) => x.name === 'Desserts'), JSON.stringify(r));
});
await ok('a product naming a category not on the cloud yet is sent again later (not recorded)', async () => {
  const c = change('product', 'create', randomUUID(), { name: 'Cake', base_price: 300, category_id: randomUUID() });
  const [r] = await send('till', c);
  assert(r.status === 'refused' && r.retry === true && !db.change_requests.some((x) => x.id === c.id), JSON.stringify(r));
});
await ok('a barcode another product has is refused with the reason', async () => {
  const [r] = await send('till', change('product', 'create', randomUUID(), { name: 'Chips', base_price: 200, category_id: FOOD, barcode: '600100' }));
  assert(r.status === 'refused' && /600100/.test(r.message), JSON.stringify(r));
});

console.log('\nStaff and PINs (offline supersedes online)\n');
await ok('a PIN set on a till wins over the one the web set meanwhile', async () => {
  db.users.find((u) => u.id === AMY).pin_hash = bcrypt.hashSync('3333', 4);   // the web, meanwhile
  const [r] = await send('till', change('staff_pin', 'update', AMY, { pin: '2580' }));
  const cr = db.change_requests.at(-1);
  assert(r.status === 'applied' && bcrypt.compareSync('2580', db.users.find((u) => u.id === AMY).pin_hash)
    && !JSON.stringify(cr).includes('2580'), JSON.stringify({ r, cr }));
});
await ok('a PIN another person has is refused, with the reason, and the owner is told', async () => {
  const [r] = await send('till', change('staff_pin', 'update', AMY, { pin: '9999' }));
  assert(r.status === 'refused' && /Mary/.test(r.message) && bcrypt.compareSync('2580', db.users.find((u) => u.id === AMY).pin_hash)
    && db.notifications.some((n) => /Mary/.test(n.message)), JSON.stringify(r));
});
await ok('a cashier added on a till is on the cloud with a bcrypt PIN and the till\'s branch; the PIN is not kept', async () => {
  const id = randomUUID();
  const [r] = await send('till', change('staff', 'create', id, { name: 'Cora', role_id: R_CASH, pin: '4242' }));
  const u = db.users.find((x) => x.id === id);
  assert(r.status === 'applied' && u?.pin_hash.startsWith('$2') && bcrypt.compareSync('4242', u.pin_hash)
    && db.user_branches.some((b) => b.user_id === id && b.branch_id === BR)
    && JSON.stringify(db.change_requests.find((x) => x.entity_id === id).proposed) === JSON.stringify({ name: 'Cora', role_id: R_CASH, pin_set: true }), JSON.stringify(r));
});
await ok('a manager cannot add an owner from a till', async () => {
  const [r] = await send('till', change('staff', 'create', randomUUID(), { name: 'Boss', role_id: R_OWNER, pin: '5151' }));
  assert(r.status === 'refused' && /only the owner/.test(r.message), JSON.stringify(r));
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
