// A564 — find an item in another branch's stock, and ask that branch for it (the cloud's half, and the web's wiring).
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/branch-stock-a564.test.mjs
//
// Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
// manager can request for them".
//
// RUNS the COMPILED server (routes/index.js behind the real requireAuth, requirePermission, the terminal-write guard and
// the till scope — both ENFORCED here) over HTTP; the database in memory (tests/lib-memdb.mjs) — migration 163's SQL runs
// for real in scripts/test-migration-163.mjs. The pure rules (lib/transferRequests.ts) are run directly.
//
//   S  the rules: the search cleaned (no LIKE / filter characters), the cap, the quantity, which branch acts on each step.
//   L  GET /api/stock/other-branches: inventory.view (a cashier yes, the kitchen role no); this business only; tracked
//      active products only; every OTHER active branch (none missing: no level → 0); never a cost; the owner with no
//      branch picked sees every branch, with one picked the others; a count at a branch hides the figure (A394); capped;
//      a till's own sign-in refused.
//   R  the request lifecycle: a manager asks for their own branch (never another's: 403), once (409 while it waits); the
//      branch asked sees it (and the count); accept → an ordinary transfer, despatched (stock leaves the sender through
//      the transfer's own step) and received by the asking branch through PATCH /transfers/:id/status (stock arrives);
//      not more than asked, not more than held; decline needs a reason; cancel is the asking branch's; a decided request
//      is final (409); the asking branch cannot accept, the asked branch cannot cancel; another business 404; the owner
//      and a partner of every branch act for any branch; who and when on every step.
//   T  a manager's PIN sign-in on a till may ask and answer (the terminal-write allowlist); the till's own sign-in may not.
//   W  the web: the dashboard page, the nav gate and the badge, the web POS stock tab, no polling in the lookup.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A564 report):
//   - /other-branches without the business filter on products            → L "this business only" fails
//   - /other-branches not leaving out the caller's own branch              → L "every OTHER branch" fails
//   - /other-branches selecting cost_price                                 → L "never a cost" fails
//   - POST /requests without assertBranchAccess(to)                        → R "never for another branch" fails
//   - accept / decline without the actingBranch check                      → R "the asking branch cannot accept" fails
//   - accept without the on-hand check                                     → R "not more than held" fails
//   - accept despatching by writing stock_levels itself (not despatchStock) → R "through the transfer's own step" fails
//   - decide() without .eq('status', 'requested')                          → R "a decided request is final" (race) fails
//   - MANAGER_WRITES without the /requests entries                         → T "a manager's PIN sign-in" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/transferRequests.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TERMINAL_WRITE_ENFORCE = 'true';
process.env.TILL_SCOPE_ENFORCE = 'true';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const S = require(path.join(DIST, 'lib/transferRequests.js'));
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222', K = '33333333-2222-4222-8222-222222222222', KR = '55555555-2222-4222-8222-222222222222';
const SHUT = '66666666-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MAX = 'aaaaaaaa-0000-4000-8000-000000000002', KIM = 'aaaaaaaa-0000-4000-8000-000000000003';
const CATE = 'aaaaaaaa-0000-4000-8000-000000000004', KITCH = 'aaaaaaaa-0000-4000-8000-000000000005', GM = 'aaaaaaaa-0000-4000-8000-000000000006';
const P1 = 'bbbbbbbb-0000-4000-8000-000000000001', P2 = 'bbbbbbbb-0000-4000-8000-000000000002', SODA = 'bbbbbbbb-0000-4000-8000-000000000003';
const OLD = 'bbbbbbbb-0000-4000-8000-000000000004', PX = 'bbbbbbbb-0000-4000-8000-000000000005';
const MGR = ['inventory.view', 'inventory.transfer', 'products.view'];
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });

mem.rpc = async (name, a) => {
  if (name === 'adjust_product_stock') {   // the receiving leg of a transfer (applyProductStockIn), as Postgres does it
    const rows = (mem.db.stock_levels ??= []);
    let l = rows.find((r) => r.product_id === a.p_product_id && r.branch_id === a.p_branch_id);
    if (!l) { l = { id: `sl-${rows.length + 1}`, product_id: a.p_product_id, branch_id: a.p_branch_id, quantity: 0, qty_pieces: 0, low_stock_threshold: 5 }; rows.push(l); }
    l.quantity = Number(l.quantity) + Number(a.p_qty_delta); l.qty_pieces = Number(l.qty_pieces) + Number(a.p_piece_delta);
    return { data: [{ quantity: l.quantity, qty_pieces: l.qty_pieces }], error: null };
  }
  return { data: null, error: null };
};

const reset = () => {
  mem.fail = () => null; mem.calls = []; AC._resetAuthCache();
  const user = (id, name, biz, role, branches) => ({ id, name, status: 'active', business_id: biz, permissions_version: 0, role_id: role ? `role-${id}` : null,
    roles: role, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Test Bar', type: 'retail', currency: 'KES', status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'retail', currency: 'KES', status: 'active' }],
    branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active', is_main: true }, { id: K, business_id: B, name: 'Kilimani', status: 'active' },
      { id: KR, business_id: B, name: 'Karen', status: 'active' }, { id: SHUT, business_id: B, name: 'Closed one', status: 'inactive' },
      { id: BRX, business_id: B2, name: 'Theirs', status: 'active' }],
    users: [user(OWNER, 'Owner', B, { name: 'Admin', role_permissions: [] }, []),
      user(MAX, 'Max', B, perms('Manager', ...MGR), [W]), user(KIM, 'Kim', B, perms('Manager', ...MGR), [K]),
      user(CATE, 'Cate', B, perms('Cashier', 'orders.create', 'inventory.view', 'products.view'), [W]),
      user(KITCH, 'Kit', B, perms('Kitchen', 'products.view'), [W]),
      user(GM, 'Grace', B, perms('General Manager', ...MGR), [W, K, KR])],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: W, user_id: OWNER }],
    products: [
      { id: P1, business_id: B, name: 'Tusker lager', status: 'active', track_stock: true, sold_by: 'unit', cost_price: 120, base_price: 250 },
      { id: P2, business_id: B, name: 'Tusker Lite', status: 'active', track_stock: true, sold_by: 'unit', cost_price: 130, base_price: 260 },
      { id: SODA, business_id: B, name: 'Soda tusker-free', status: 'active', track_stock: false, sold_by: 'unit', cost_price: 30 },
      { id: OLD, business_id: B, name: 'Old Tusker', status: 'inactive', track_stock: true, sold_by: 'unit' },
      { id: PX, business_id: B2, name: 'Tusker theirs', status: 'active', track_stock: true, sold_by: 'unit' }],
    stock_levels: [
      { id: 'sl-a', product_id: P1, branch_id: W, quantity: 10, qty_pieces: 0, low_stock_threshold: 5, updated_at: '2026-10-22T07:00:00Z' },
      { id: 'sl-b', product_id: P1, branch_id: K, quantity: 24, qty_pieces: 0, low_stock_threshold: 5, updated_at: '2026-10-22T08:00:00Z' },
      { id: 'sl-c', product_id: P2, branch_id: K, quantity: 5, qty_pieces: 0, low_stock_threshold: 5, updated_at: '2026-10-22T08:00:00Z' },
      { id: 'sl-d', product_id: P2, branch_id: KR, quantity: 9, qty_pieces: 0, low_stock_threshold: 5, updated_at: '2026-10-22T08:00:00Z' },
      { id: 'sl-e', product_id: P1, branch_id: SHUT, quantity: 7, qty_pieces: 0, low_stock_threshold: 5 },
      { id: 'sl-x', product_id: PX, branch_id: BRX, quantity: 99, qty_pieces: 0, low_stock_threshold: 5 }],
    stock_movements: [], stock_transfers: [], stock_transfer_items: [], stock_transfer_requests: [], stock_takes: [], stock_take_lines: [],
    notifications: [], audit_log: [], refresh_tokens: [], sync_versions: [], sync_changes: [], business_settings: [], branch_settings: [], feature_flags: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  max: sign({ userId: MAX, branchId: W, permissionKeys: MGR }),
  kim: sign({ userId: KIM, branchId: K, permissionKeys: MGR }),
  cate: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'inventory.view', 'products.view'] }),
  kitchen: sign({ userId: KITCH, branchId: W, permissionKeys: ['products.view'] }),
  gm: sign({ userId: GM, branchId: null, webPartner: true, partnerBranches: [W, K, KR], allBranches: true, permissionKeys: MGR }),
  maxTill: sign({ userId: MAX, branchId: W, permissionKeys: MGR, surface: 'desktop', pinSignIn: true }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, branchId: W, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const level = (p, b) => Number(mem.db.stock_levels.find((r) => r.product_id === p && r.branch_id === b)?.quantity ?? 0);
const reqRow = (id) => mem.db.stock_transfer_requests.find((r) => r.id === id);
const ask = (token, body) => call('POST', '/api/stock/requests', token, body);
const step = (token, id, s, body = {}) => call('POST', `/api/stock/requests/${id}/${s}`, token, body);

try {
  state._setPermissionsMigrated(true);

  console.log('\nS. the rules\n');
  await ok('the search: trimmed, spaces collapsed, LIKE and filter characters dropped, at most 60', async () => {
    assert.equal(S.searchTerm('  tusker   lager '), 'tusker lager');
    assert.equal(S.searchTerm('50%_off,(x)*'), '50 off x');
    assert.equal(S.searchTerm('%'), '');
    assert.equal(S.searchTerm('x'.repeat(80)).length, 60);
    assert.equal(S.searchTerm(42), '');
  });
  await ok('the cap: 20 by default, never above 50; a quantity above 0 and at most 100000; a note at most 300', async () => {
    assert.deepEqual([S.lookupLimit(undefined), S.lookupLimit('5'), S.lookupLimit(999), S.lookupLimit(-1)], [20, 5, 50, 20]);
    assert.deepEqual([S.requestQuantity(6), S.requestQuantity('2.5'), S.requestQuantity(0), S.requestQuantity(-3), S.requestQuantity('x'), S.requestQuantity(100001)],
      [6, 2.5, null, null, null, null]);
    assert.equal(S.cleanNote('  '), null); assert.equal(S.cleanNote('x'.repeat(400)).length, 300);
  });
  await ok('who acts: the branch asked accepts and declines, the branch that asked cancels', async () => {
    const r = { from_branch_id: K, to_branch_id: W };
    assert.deepEqual([S.actingBranch('accept', r), S.actingBranch('decline', r), S.actingBranch('cancel', r)], [K, K, W]);
    assert.deepEqual([S.nextStatus('accept'), S.nextStatus('decline'), S.nextStatus('cancel')], ['accepted', 'declined', 'cancelled']);
  });

  console.log('\nL. GET /api/stock/other-branches\n');
  await ok('a cashier (inventory.view) sees every OTHER active branch: "Kilimani: 24 · Karen: 0" — never their own, never a closed branch', async () => {
    reset();
    const r = await call('GET', '/api/stock/other-branches?q=tusker', T.cate);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.branch_id, W);
    const lager = r.body.products.find((p) => p.product_id === P1);
    assert.deepEqual(lager.branches.map((b) => `${b.branch_name}: ${b.quantity}`), ['Karen: 0', 'Kilimani: 24'], 'by name; no level → 0');
    assert.equal(lager.branches.find((b) => b.branch_id === K).updated_at, '2026-10-22T08:00:00Z', 'when the level last changed');
    assert.ok(r.body.products.every((p) => p.branches.every((b) => b.branch_id !== W)) && !r.text.includes('Westlands'), 'their own branch is not "another"');
    assert.ok(!r.text.includes('Closed one'));
  });
  await ok('this business only; tracked, active products only (not untracked, not inactive, not another business\'s)', async () => {
    reset();
    const r = await call('GET', '/api/stock/other-branches?q=tusker', T.cate);
    assert.deepEqual(r.body.products.map((p) => p.name).sort(), ['Tusker Lite', 'Tusker lager']);
    assert.ok(!r.text.includes('Theirs') && !r.text.includes('Tusker theirs') && !r.text.includes('99'));
  });
  await ok('never a cost: no cost field, no cost figure — even for the owner', async () => {
    reset();
    for (const t of [T.cate, T.owner, T.max]) {
      const r = await call('GET', '/api/stock/other-branches?q=tusker', t);
      assert.equal(r.status, 200);
      assert.ok(!/cost|margin|price/i.test(r.text), r.text);
      assert.ok(!r.text.includes('120') && !r.text.includes('130'));
    }
  });
  await ok('the owner: no branch picked → every active branch; one picked (X-Branch-Id) → the others', async () => {
    reset();
    const all = await call('GET', `/api/stock/other-branches?product_id=${P1}`, T.owner);
    assert.deepEqual(all.body.products[0].branches.map((b) => b.branch_name), ['Karen', 'Kilimani', 'Westlands']);
    const picked = await call('GET', `/api/stock/other-branches?product_id=${P1}`, T.owner, undefined, { 'x-branch-id': K });
    assert.deepEqual(picked.body.products[0].branches.map((b) => `${b.branch_name}: ${b.quantity}`), ['Karen: 0', 'Westlands: 10']);
  });
  await ok('the kitchen role (products.view only) is refused 403; a search under 2 letters 400; another business\'s product id: nothing', async () => {
    reset();
    assert.equal((await call('GET', '/api/stock/other-branches?q=tusker', T.kitchen)).status, 403);
    const short = await call('GET', '/api/stock/other-branches?q=%25', T.cate);
    assert.equal(short.status, 400); assert.equal(short.body.code, 'SEARCH_TOO_SHORT');
    const x = await call('GET', `/api/stock/other-branches?product_id=${PX}`, T.cate);
    assert.equal(x.status, 200); assert.deepEqual(x.body.products, []);
  });
  await ok('capped: limit=1 → one product and "more match"', async () => {
    reset();
    const r = await call('GET', '/api/stock/other-branches?q=tusker&limit=1', T.cate);
    assert.equal(r.body.products.length, 1); assert.equal(r.body.truncated, true);
  });
  await ok('A394: an item a count at Kilimani is counting shows "being counted" (no figure) to the cashier; the owner sees it', async () => {
    reset();
    mem.db.stock_takes.push({ id: 'tk-1', business_id: B, branch_id: K, ref: 'SC-1', status: 'counting', freeze_sales: false });
    mem.db.stock_take_lines.push({ id: 'tl-1', stock_take_id: 'tk-1', product_id: P1, ingredient_id: null });
    const c = await call('GET', `/api/stock/other-branches?product_id=${P1}`, T.cate);
    const kc = c.body.products[0].branches.find((b) => b.branch_id === K);
    assert.deepEqual([kc.quantity, kc.counting], [null, true]);
    const o = await call('GET', `/api/stock/other-branches?product_id=${P1}`, T.owner);
    assert.equal(o.body.products[0].branches.find((b) => b.branch_id === K).quantity, 24);
  });
  await ok('the till\'s own sign-in is refused (the till scope); a person\'s PIN sign-in on the till reads it', async () => {
    reset();
    assert.equal((await call('GET', '/api/stock/other-branches?q=tusker', T.till)).status, 403);
    assert.equal((await call('GET', '/api/stock/other-branches?q=tusker', T.maxTill)).status, 200);
  });

  console.log('\nR. the request lifecycle\n');
  let rid;
  await ok('a manager asks Kilimani for 6 × Tusker lager FOR their own branch — who and when recorded; the branch asked sees it', async () => {
    reset();
    const r = await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 6, note: 'Weekend rush' });
    assert.equal(r.status, 201, r.text);
    rid = r.body.id;
    const row = reqRow(rid);
    assert.deepEqual([row.from_branch_id, row.to_branch_id, row.status, Number(row.quantity), row.note, row.requested_by, row.requested_by_name],
      [K, W, 'requested', 6, 'Weekend rush', MAX, 'Max']);
    assert.ok(row.requested_at);
    assert.equal(r.body.from_branch_name, 'Kilimani'); assert.equal(r.body.product_name, 'Tusker lager');
    const k = await call('GET', '/api/stock/requests', T.kim);
    assert.equal(k.body.incoming_open, 1); assert.equal(k.body.requests[0].id, rid);
    assert.equal((await call('GET', '/api/stock/requests/count', T.kim)).body.incoming, 1, 'Kilimani\'s badge');
    assert.equal((await call('GET', '/api/stock/requests/count', T.max)).body.incoming, 0, 'not Westlands\' to answer');
    assert.equal((await call('GET', '/api/stock/requests/count', T.cate)).body.incoming, 0, 'a cashier: 0');
    const m = await call('GET', '/api/stock/requests', T.max);
    assert.equal(m.body.incoming_open, 0); assert.equal(m.body.requests.length, 1);
    assert.equal((await call('GET', '/api/stock/requests', T.owner)).body.incoming_open, 1, 'the owner sees every request');
  });
  await ok('once: the same ask while it waits → 409; never for another branch (403); not the branch itself; a cashier cannot ask', async () => {
    const d = await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 2 });
    assert.equal(d.status, 409); assert.equal(d.body.code, 'ALREADY_REQUESTED');
    const other = await ask(T.max, { from_branch_id: KR, to_branch_id: K, product_id: P1, quantity: 2 });
    assert.equal(other.status, 403); assert.equal(other.body.code, 'NOT_YOUR_BRANCH');
    assert.equal((await ask(T.max, { from_branch_id: W, product_id: P1, quantity: 2 })).body.code, 'SAME_BRANCH');
    assert.equal((await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 0 })).body.code, 'INVALID_QUANTITY');
    assert.equal((await ask(T.cate, { from_branch_id: K, product_id: P1, quantity: 1 })).status, 403);
    assert.equal(mem.db.stock_transfer_requests.length, 1);
  });
  await ok('another business: its branch or product 404; its request 404 (never answered)', async () => {
    assert.equal((await ask(T.max, { from_branch_id: BRX, product_id: P1, quantity: 1 })).status, 404);
    assert.equal((await ask(T.max, { from_branch_id: K, product_id: PX, quantity: 1 })).status, 404);
    mem.db.stock_transfer_requests.push({ id: 'req-x', business_id: B2, from_branch_id: BRX, to_branch_id: BRX, product_id: PX, quantity: 1, status: 'requested' });
    assert.equal((await step(T.owner, 'req-x', 'accept')).status, 404);
    assert.equal((await step(T.owner, 'req-x', 'decline', { reason: 'x' })).status, 404);
    assert.equal(reqRow('req-x').status, 'requested');
    mem.db.stock_transfer_requests = mem.db.stock_transfer_requests.filter((r) => r.id !== 'req-x');
  });
  await ok('the asking branch cannot accept or decline its own ask (NOT_SENDER); the branch asked cannot cancel it (NOT_REQUESTER)', async () => {
    const a = await step(T.max, rid, 'accept');
    assert.equal(a.status, 403); assert.equal(a.body.code, 'NOT_SENDER');
    assert.equal((await step(T.max, rid, 'decline', { reason: 'no' })).body.code, 'NOT_SENDER');
    const c = await step(T.kim, rid, 'cancel');
    assert.equal(c.status, 403); assert.equal(c.body.code, 'NOT_REQUESTER');
    assert.equal(reqRow(rid).status, 'requested');
  });
  await ok('accept: a sent quantity of 0 or nonsense is refused (400); more than the branch holds 409; the request still waits', async () => {
    for (const q of [0, -2, 'x']) {
      const r = await step(T.kim, rid, 'accept', { quantity: q });
      assert.equal(r.status, 400, String(q)); assert.equal(r.body.code, 'INVALID_QUANTITY');
    }
    assert.equal((await step(T.kim, rid, 'accept', { quantity: 30 })).body.code, 'NOT_ENOUGH_STOCK');
    assert.equal(reqRow(rid).status, 'requested');
  });
  let transferId;
  await ok('accept and send: an ordinary transfer Kilimani → Westlands, despatched — the stock leaves Kilimani through the transfer\'s own step', async () => {
    const r = await step(T.kim, rid, 'accept');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'accepted'); assert.equal(r.body.transfer.status, 'in_transit');
    const row = reqRow(rid);
    assert.deepEqual([row.status, row.decided_by, row.decided_by_name, Number(row.sent_quantity)], ['accepted', KIM, 'Kim', 6]);
    assert.ok(row.decided_at);
    const t = mem.db.stock_transfers.find((x) => x.id === row.transfer_id);
    transferId = t.id;
    assert.deepEqual([t.business_id, t.from_branch_id, t.to_branch_id, t.status, t.despatched_by, t.created_by], [B, K, W, 'in_transit', KIM, KIM]);
    assert.match(t.transfer_number, /^TRF-/); assert.match(t.notes, /Asked for by Max: Weekend rush/);
    assert.deepEqual(mem.db.stock_transfer_items.filter((i) => i.transfer_id === t.id).map((i) => [i.product_id, i.quantity]), [[P1, 6]]);
    assert.equal(level(P1, K), 18, 'left Kilimani');
    assert.equal(level(P1, W), 10, 'not at Westlands until received');
    const mv = mem.db.stock_movements.filter((m) => m.movement_type === 'transfer_out');
    assert.deepEqual(mv.map((m) => [m.product_id, m.branch_id, m.quantity_change]), [[P1, K, -6]], 'the transfer\'s own movement');
  });
  await ok('…received by Westlands through PATCH /transfers/:id/status (the existing path): the stock arrives', async () => {
    // PostgREST embeds the transfer's lines (stock_transfer_items ( … )); the in-memory database does not — hand them over.
    const t = mem.db.stock_transfers.find((x) => x.id === transferId);
    t.stock_transfer_items = mem.db.stock_transfer_items.filter((i) => i.transfer_id === transferId).map((i) => ({ product_id: i.product_id, quantity: i.quantity }));
    const r = await call('PATCH', `/api/stock/transfers/${transferId}/status`, T.max, { status: 'received' });
    assert.equal(r.status, 200, r.text);
    assert.equal(level(P1, W), 16);
    assert.deepEqual(mem.db.stock_movements.filter((m) => m.movement_type === 'transfer_in').map((m) => [m.branch_id, m.quantity_change]), [[W, 6]]);
  });
  await ok('a decided request is final: accept, decline or cancel again → 409 ALREADY_DECIDED; no second transfer', async () => {
    for (const [t, s, b] of [[T.kim, 'accept', {}], [T.kim, 'decline', { reason: 'x' }], [T.max, 'cancel', {}]]) {
      const r = await step(t, rid, s, b);
      assert.equal(r.status, 409, `${s} ${r.status}`); assert.equal(r.body.code, 'ALREADY_DECIDED');
    }
    assert.equal(mem.db.stock_transfers.length, 1);
  });
  await ok('two managers answering at once: one transfer, the other 409 (the status is claimed conditionally)', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 2 })).body.id;
    const kim2 = sign({ userId: KIM, branchId: K, permissionKeys: MGR, sessionId: 's2' });
    let gate; const barrier = new Promise((r) => { gate = r; });
    let reads = 0;
    mem.latency = (table, op, filters) => (table === 'stock_levels' && filters.branch_id === K && ++reads <= 2 ? (reads === 2 && gate(), barrier) : 0);
    const [a, b] = await Promise.all([step(T.kim, id, 'accept'), step(kim2, id, 'accept')]);
    mem.latency = () => 0;
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(mem.db.stock_transfers.length, 1); assert.equal(level(P1, K), 22);
  });
  await ok('not more than the branch holds: 409 NOT_ENOUGH_STOCK with what it holds; nothing created, the request still waits', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: K, product_id: P2, quantity: 8 })).body.id;
    const r = await step(T.kim, id, 'accept');
    assert.equal(r.status, 409); assert.equal(r.body.code, 'NOT_ENOUGH_STOCK'); assert.equal(r.body.on_hand, 5);
    assert.equal(reqRow(id).status, 'requested'); assert.equal(mem.db.stock_transfers.length, 0); assert.equal(level(P2, K), 5);
    const less = await step(T.kim, id, 'accept', { quantity: 5 });
    assert.equal(less.status, 200, less.text); assert.equal(Number(reqRow(id).sent_quantity), 5); assert.equal(level(P2, K), 0);
  });
  await ok('owner decision: the sending manager CHANGES the quantity — asked 6, sends 20 (more): both kept, the transfer moves the SENT 20', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 6 })).body.id;
    const r = await step(T.kim, id, 'accept', { quantity: 20 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.quantity, r.body.sent_quantity], [6, 20], 'asked 6 · sent 20, shown to the requester');
    const t = mem.db.stock_transfers.find((x) => x.id === reqRow(id).transfer_id);
    assert.deepEqual(mem.db.stock_transfer_items.filter((i) => i.transfer_id === t.id).map((i) => i.quantity), [20]);
    assert.equal(level(P1, K), 4, 'the SENT 20 left Kilimani');
    const m = await call('GET', '/api/stock/requests', T.max);
    assert.deepEqual([m.body.requests[0].quantity, m.body.requests[0].sent_quantity], [6, 20]);
  });
  await ok('…and fewer: asked 6, sends 2 — the transfer moves 2', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 6 })).body.id;
    assert.equal((await step(T.kim, id, 'accept', { quantity: 2 })).status, 200);
    assert.equal(Number(reqRow(id).sent_quantity), 2); assert.equal(level(P1, K), 22);
  });
  await ok('a request without a quantity (a blank form) is refused 400 INVALID_QUANTITY', async () => {
    reset();
    for (const q of [undefined, '', null]) {
      const r = await ask(T.max, { from_branch_id: K, product_id: P1, quantity: q });
      assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_QUANTITY');
    }
    assert.equal(mem.db.stock_transfer_requests.length, 0);
  });
  await ok('decline: a reason is required (400), then declined with who, when and why; the asking branch sees it; nothing moves', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 3 })).body.id;
    const no = await step(T.kim, id, 'decline', { reason: '   ' });
    assert.equal(no.status, 400); assert.equal(no.body.code, 'REASON_REQUIRED');
    const r = await step(T.kim, id, 'decline', { reason: 'We need it for the weekend' });
    assert.equal(r.status, 200, r.text);
    const row = reqRow(id);
    assert.deepEqual([row.status, row.decline_reason, row.decided_by_name], ['declined', 'We need it for the weekend', 'Kim']);
    assert.equal(level(P1, K), 24); assert.equal(mem.db.stock_transfers.length, 0);
    const m = await call('GET', '/api/stock/requests', T.max);
    assert.equal(m.body.requests[0].decline_reason, 'We need it for the weekend');
  });
  await ok('cancel: the asking branch, while it waits; Kilimani cannot cancel or answer Karen\'s', async () => {
    reset();
    const id = (await ask(T.max, { from_branch_id: KR, product_id: P2, quantity: 1 })).body.id;
    assert.equal((await step(T.kim, id, 'cancel')).status, 403);
    assert.equal((await step(T.kim, id, 'accept')).status, 403, 'Kilimani was not asked');
    const r = await step(T.max, id, 'cancel');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([reqRow(id).status, reqRow(id).decided_by_name], ['cancelled', 'Max']);
  });
  await ok('the owner acts for any branch: asks FOR Karen (to_branch_id), accepts AS Westlands; a request needs a branch to be for', async () => {
    reset();
    const none = await ask(T.owner, { from_branch_id: W, product_id: P1, quantity: 1 });
    assert.equal(none.status, 400); assert.equal(none.body.code, 'TO_BRANCH_REQUIRED');
    const r = await ask(T.owner, { from_branch_id: W, to_branch_id: KR, product_id: P1, quantity: 4 });
    assert.equal(r.status, 201, r.text); assert.equal(reqRow(r.body.id).requested_by_name, 'Owner');
    const a = await step(T.owner, r.body.id, 'accept');
    assert.equal(a.status, 200, a.text); assert.equal(level(P1, W), 6);
  });
  await ok('a partner of every branch (A550) acts for any of theirs: asks for Kilimani, Karen declines through them', async () => {
    reset();
    const r = await ask(T.gm, { from_branch_id: KR, to_branch_id: K, product_id: P2, quantity: 2 });
    assert.equal(r.status, 201, r.text); assert.equal(reqRow(r.body.id).requested_by_name, 'Grace');
    const d = await step(T.gm, r.body.id, 'decline', { reason: 'Counting tonight' });
    assert.equal(d.status, 200, d.text);
  });

  console.log('\nT. the till: a manager\'s PIN sign-in, never the till\'s own sign-in\n');
  await ok('a manager\'s PIN sign-in on a till asks, the branch asked answers from its till (the terminal-write allowlist, enforced)', async () => {
    reset();
    const r = await ask(T.maxTill, { from_branch_id: K, product_id: P1, quantity: 1 });
    assert.equal(r.status, 201, r.text);
    const kimTill = sign({ userId: KIM, branchId: K, permissionKeys: MGR, surface: 'desktop', pinSignIn: true });
    assert.equal((await step(kimTill, r.body.id, 'accept')).status, 200);
    const r2 = await ask(T.maxTill, { from_branch_id: K, product_id: P2, quantity: 1 });
    assert.equal((await step(T.maxTill, r2.body.id, 'cancel')).status, 200);
  });
  await ok('the till\'s own sign-in may not ask, accept, decline or cancel (TERMINAL_WRITE_FORBIDDEN)', async () => {
    reset();
    const r = await ask(T.till, { from_branch_id: K, product_id: P1, quantity: 1 });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'TERMINAL_WRITE_FORBIDDEN');
    const id = (await ask(T.max, { from_branch_id: K, product_id: P1, quantity: 1 })).body.id;
    for (const s of ['accept', 'decline', 'cancel']) assert.equal((await step(T.till, id, s, { reason: 'x' })).status, 403, s);
    assert.equal(reqRow(id).status, 'requested');
  });

  console.log('\nW. the web\n');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  await ok('Stock › Other branches: routed, gated on inventory.view or inventory.transfer, a badge of what waits', async () => {
    assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="stock\/other-branches"\s+element=\{<OtherBranchesPage \/>\} \/>/);
    const lay = read('apps/dashboard/src/components/DashboardLayout.tsx');
    assert.match(lay, /'\/dashboard\/stock\/other-branches':\s+\['inventory\.view', 'inventory\.transfer'\]/);
    assert.match(lay, /badgeKey: 'branchRequests'/);
    assert.match(lay, /api\.get<\{ incoming: number \}>\('\/api\/stock\/requests\/count'\)/);
  });
  await ok('the panel: searches only when asked (no timer), Accept and send / Decline (a reason) / Cancel request; the web POS stock tab has it', async () => {
    const p = read('apps/dashboard/src/components/OtherBranchesPanel.tsx');
    assert.match(p, /\/api\/stock\/other-branches\?q=\$\{encodeURIComponent\(q\.trim\(\)\)\}/);
    assert.ok(!/setInterval|setTimeout/.test(p), 'no polling');
    assert.match(p, /Accept and send/); assert.match(p, /disabled=\{busy === r\.id \|\| !declining\.reason\.trim\(\)\}/);
    assert.match(p, /\/api\/stock\/requests\/\$\{r\.id\}\/\$\{step\}/);
    const pos = read('apps/dashboard/src/pages/pos/POSInventoryTab.tsx');
    assert.match(pos, /<OtherBranchesPanel http=\{posApi\} canRequest=\{hasPermission\('inventory\.transfer'\)\} \/>/);
  });
  await ok('the forms (owner, 2026-10-22): a blank quantity is never sent ("Enter how many"); the sender sets what goes, "asked 30 · sent 20"', async () => {
    const R = await import(new URL('../apps/dashboard/src/lib/branchStock.ts', import.meta.url).href);
    assert.equal(R.quantityProblem(''), 'Enter how many.'); assert.equal(R.quantityProblem('  '), 'Enter how many.');
    assert.equal(R.quantityProblem('0'), 'Enter a quantity above 0.'); assert.equal(R.quantityProblem('abc'), 'Enter a quantity above 0.');
    assert.equal(R.quantityProblem('25', 24, 'Kilimani'), 'Kilimani holds 24.'); assert.equal(R.quantityProblem('6', 24), null);
    assert.equal(R.askedSent({ status: 'accepted', quantity: 30, sent_quantity: 20 }), 'asked 30 · sent 20');
    assert.equal(R.askedSent({ status: 'accepted', quantity: 30, sent_quantity: 30 }), '');
    assert.equal(R.askedSent({ status: 'requested', quantity: 30, sent_quantity: null }), '');
    const p = read('apps/dashboard/src/components/OtherBranchesPanel.tsx');
    assert.match(p, /const \[n, setN\] = useState\(''\);/, 'the request form opens blank');
    assert.match(p, /const why = quantityProblem\(n, s\.quantity, s\.branch_name\);\n\s+if \(why\) \{ setErr\(why\); return; \}/);
    assert.match(p, /void decide\(r, 'accept', undefined, Number\(accepting\.qty\)\)/, 'accept sends the quantity the sender set');
    assert.match(p, /reason \? \{ reason \} : quantity !== undefined \? \{ quantity \} : \{\}/);
    assert.equal(read('apps/dashboard/src/lib/branchStock.ts'), read('apps/desktop/src/renderer/lib/branchStock.ts'), 'the till and the web: one text');
  });
  await ok('Analytics\' "Start a transfer →" (A565: ?from=&to=&products=) opens the new transfer filled in, quantities blank', async () => {
    const t = read('apps/dashboard/src/pages/stock/StockTransfersPage.tsx');
    assert.match(t, /const from = params\.get\('from'\) \?\? '', to = params\.get\('to'\) \?\? '';/);
    assert.match(t, /picked\.map\(id => \(\{ product_id: id, quantity: '' \}\)\)/);
    assert.match(t, /if \(prefilled\.current \|\| loading\) return;/);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
