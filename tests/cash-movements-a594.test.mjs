// A594 — cash in / cash out: off for cashiers by default, a manager approves on the spot, every one gives a reason, a cash
// in that looks like a drawer count is asked again, and the web's Shift Reports shows how expected cash is made up.
// Owner, 2026-10-26 (a cashier typed the day's drawer counts into Cash in — twice, 21 s apart, no reason, nobody
// approving; Expected cash read about 10,000 over the drawer): "we need to turn off that option for cashiers by default
// unless allowed" — then "some items can be permissions; in fact we need to break those permissions further".
//
//   cd apps/server && npm run build && cd ../.. && node tests/cash-movements-a594.test.mjs
//
// Drives the REAL compiled routes (routes/shifts.js, routes/controls.js) behind the REAL requireAuth with an in-memory
// database (after migration 134: the role decides), the catalogue's defaults (shared/permissions.ts), and renders the web's
// ExpectedCashBreakdown with react-dom/server.
//
// MUTATIONS TO CONFIRM BITE:
//   - /:id/float approving only a float_out (type === 'float_out')   → "a cashier's cash in needs a manager" fails
//   - /:id/float without the reason check                          → "a cash in with no reason: 400" fails
//   - /:id/float without the looksLikeDrawerCount check            → "a cash in of the cash sales: 409" fails
//   - GET /:id giving expected_breakdown without seesDrawerFigures  → "a cashier never gets the breakdown" fails
//   - GET / giving expected_cash_parts to the drawer's own cashier  → "…nor the parts in the list" fails
//   - controls without OWNER_ONLY for approval_pin                  → "approval PIN: the owner only" fails
//   - Cashier's built-in defaults holding shifts.cash_movements      → "the Cashier role holds none of the three" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const DASH = path.join(ROOT, 'apps/dashboard');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
require(path.join(DIST, 'lib/permissionsState.js'))._setPermissionsMigrated(true);   // after 134: the role decides
const F = require(path.join(DIST, 'lib/posFeatures.js'));
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const SH = '33333333-3333-4333-8333-333333333333';
const CASHIER = '44444444-4444-4444-8444-444444444444', MANAGER = '55555555-5555-4555-8555-555555555555';
const IVY = '66666666-6666-4666-8666-666666666666', OWNER = '77777777-7777-4777-8777-777777777777';
const MANAGER_PIN_HASH = bcrypt.hashSync('4321', 4);
let db;
const reset = () => {
  db = {
    schema_migrations: [{ version: '134_permission_catalogue' }, { version: '175_cash_movement_rights' }],
    businesses: [{ id: BZ, name: 'Sample Shop', owner_id: OWNER, status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Main Branch', status: 'active' }],
    shifts: [{ id: SH, business_id: BZ, branch_id: BR, status: 'open', cashier_id: CASHIER, opening_float: 1000, opened_at: '2026-10-26T08:00:00Z' }],
    users: [
      { id: CASHIER, business_id: BZ, name: 'Amina', status: 'active', roles: { name: 'Cashier', role_permissions: [{ permissions: { key: 'orders.create' } }] }, user_permissions: [], user_branches: [{ branch_id: BR }] },
      { id: IVY, business_id: BZ, name: 'Ivy', status: 'active', roles: { name: 'Cashier', role_permissions: [] }, user_permissions: [], user_branches: [{ branch_id: BR }] },
      { id: MANAGER, business_id: BZ, name: 'Joshua', status: 'active', pin_hash: MANAGER_PIN_HASH,
        roles: { name: 'Manager', role_permissions: ['shifts.confirm', 'shifts.cash_movements'].map((key) => ({ permissions: { key } })) },
        user_permissions: [], user_branches: [{ branch_id: BR }] },
    ],
    feature_flags: [],
    orders: [{ id: 'o1', business_id: BZ, shift_id: SH, status: 'completed', total: 4450, cashier_id: CASHIER }],
    payments: [{ id: 'p1', order_id: 'o1', method: 'cash', status: 'completed', amount: 4450 }],
    float_transactions: [], expenses: [], expense_categories: [], business_settings: [],
  };
};

let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let upsert = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (upsert) { const list = (db[table] ??= []); const hit = list.find((r) => r.business_id === upsert.business_id && r.key === upsert.key); if (hit) Object.assign(hit, upsert); else list.push(upsert); return [upsert]; }
    if (inserted) return inserted; if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; } return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (x ?? null) === v]); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'upsert') return (r) => { upsert = { ...r }; return q; };
      if (prop === 'insert') return (r) => {
        const list = (db[table] ??= []);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, created_at: new Date(Date.now() + nextId).toISOString(), ...x }));
        list.push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
app.use('/api/controls', require(path.join(DIST, 'routes/controls.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tokenFor = (userId, keys, isOwner = false) => jwt.sign({ userId, businessId: BZ, branchId: BR, isOwner, permissionKeys: keys,
  permissionsVersion: 1, sessionId: 's-' + userId, surface: 'web', tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '15m' });
const CASHIER_T = tokenFor(CASHIER, ['orders.create']);                                  // A594's Cashier default
const IVY_T = tokenFor(IVY, ['orders.create', 'shifts.cash_movements']);                  // given Record cash in in Staff
const MANAGER_T = tokenFor(MANAGER, ['orders.create', 'shifts.confirm', 'shifts.cash_movements', 'shifts.cash_out', 'expenses.record', 'reports.shifts']);
const SETTINGS_T = tokenFor(MANAGER, ['settings.pos']);
const OWNER_T = tokenFor(OWNER, ['*'], true);
const req = async (method, url, token, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const float = (token, body) => req('POST', `/api/shifts/${SH}/float`, token, body);

try {
  console.log('\nThe catalogue (new businesses)\n');
  const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
  await ok('three rights from A453\'s switch — Record cash in (shifts.cash_movements), cash out, expenses — none a cashier default', () => {
    const lab = (k) => P.PERMISSIONS.find((p) => p.key === k)?.label;
    assert.equal(lab('shifts.cash_movements'), 'Record cash in');
    assert.equal(lab('shifts.cash_out'), 'Record cash out / pay-outs');
    assert.equal(lab('expenses.record'), 'Record expenses');
    const cashier = P.BUILT_IN_ROLES.find((r) => r.name === 'Cashier').keys;
    for (const k of ['shifts.cash_movements', 'shifts.cash_out', 'expenses.record']) {
      assert.ok(!cashier.includes(k), `the Cashier role holds none of the three: ${k}`);
      assert.ok(P.defaultKeysForRoleName('Manager').includes(k), `Manager: ${k}`);
      assert.ok(P.defaultKeysForRoleName('Supervisor').includes(k), `Supervisor: ${k}`);
      assert.ok(P.defaultKeysForRoleName('General Manager').includes(k), `General Manager: ${k}`);
      assert.ok(!P.defaultKeysForRoleName('Waiter').includes(k) && !P.defaultKeysForRoleName('Fuel attendant').includes(k), `as before: ${k}`);
    }
    assert.ok(!P.defaultKeysFor('cashier').includes('shifts.cash_movements'));
  });

  console.log('\nPOST /api/shifts/:id/float\n');
  await ok('a cash in with no reason: 400 REASON_REQUIRED, nothing written', async () => {
    reset();
    const r = await float(MANAGER_T, { type: 'float_in', amount: 200 });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'REASON_REQUIRED'); assert.equal(db.float_transactions.length, 0);
    const o = await float(MANAGER_T, { type: 'float_out', amount: 200, reason: '   ' });
    assert.equal(o.status, 400, 'a cash out too');
  });
  await ok('a cashier\'s cash in needs a manager — refused without one (nothing written)', async () => {
    reset();
    const r = await float(CASHIER_T, { type: 'float_in', amount: 200, reason: 'Change from the bank' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PAYOUT_APPROVAL_REQUIRED'); assert.equal(db.float_transactions.length, 0);
  });
  await ok('…a wrong PIN is refused; the manager\'s PIN approves it and the entry records the approver', async () => {
    reset();
    const bad = await float(CASHIER_T, { type: 'float_in', amount: 200, reason: 'Change', pin: '9999' });
    assert.equal(bad.status, 403); assert.equal(db.float_transactions.length, 0);
    const r = await float(CASHIER_T, { type: 'float_in', amount: 200, reason: 'Change from the bank', pin: '4321' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db.float_transactions[0].approved_by, MANAGER); assert.equal(db.float_transactions[0].approved_by_name, 'Joshua');
    assert.equal(db.float_transactions[0].reason, 'Change from the bank');
  });
  await ok('a person given Record cash in: a cash in needs nobody; their cash out still needs a manager (A388)', async () => {
    reset();
    const r = await float(IVY_T, { type: 'float_in', amount: 300, reason: 'Top-up' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(db.float_transactions[0].approved_by, null);
    const o = await float(IVY_T, { type: 'float_out', amount: 50, reason: 'Ice' });
    assert.equal(o.status, 403); assert.equal(o.body.code, 'PAYOUT_APPROVAL_REQUIRED');
  });
  await ok('a manager signed in: a cash in with nobody approving, a cash out approved as themselves (unchanged)', async () => {
    reset();
    assert.equal((await float(MANAGER_T, { type: 'float_in', amount: 120, reason: 'Change' })).status, 201);
    assert.equal((await float(MANAGER_T, { type: 'float_out', amount: 80, reason: 'Gas' })).status, 201);
    assert.equal(db.float_transactions[0].approved_by, null); assert.equal(db.float_transactions[1].approved_by, MANAGER);
  });
  await ok('a cash in of the cash sales (4,450) or of float + cash sales (5,450): 409 CASH_IN_LOOKS_LIKE_COUNT, no figures, nothing written', async () => {
    reset();
    for (const amount of [4450, 5450, 5449.5]) {
      const r = await float(CASHIER_T, { type: 'float_in', amount, reason: 'cash', pin: '4321' });
      assert.equal(r.status, 409, String(amount)); assert.equal(r.body.code, F.DRAWER_COUNT_CODE); assert.equal(r.body.error, F.DRAWER_COUNT_WARNING);
      assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error'], 'the figures never go back (a cashier\'s close stays blind)');
    }
    assert.equal(db.float_transactions.length, 0);
    const ack = await float(CASHIER_T, { type: 'float_in', amount: 4450, reason: 'Owner brought change', pin: '4321', count_ack: true });
    assert.equal(ack.status, 201, JSON.stringify(ack.body)); assert.equal(db.float_transactions[0].approved_by, MANAGER);
    const out = await float(MANAGER_T, { type: 'float_out', amount: 4450, reason: 'Banked' });
    assert.equal(out.status, 201, 'a cash out is never asked');
  });
  await ok('a drawer expense by a cashier: no outright refusal (A453 gone) — a manager approves it', async () => {
    reset();
    const r = await req('POST', `/api/shifts/${SH}/expense`, CASHIER_T, { description: 'Gas', amount: 300, payment_method: 'cash' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PAYOUT_APPROVAL_REQUIRED');
    const y = await req('POST', `/api/shifts/${SH}/expense`, CASHIER_T, { description: 'Gas', amount: 300, payment_method: 'cash', pin: '4321' });
    assert.equal(y.status, 201, JSON.stringify(y.body)); assert.equal(db.expenses[0].approved_by, MANAGER);
  });

  console.log('\nThe breakdown of expected cash (Shift Reports)\n');
  const seed = () => {
    reset();
    db.float_transactions.push(
      { id: 'f1', shift_id: SH, type: 'float_in', amount: 4450, reason: null, cashier_id: CASHIER, approved_by_name: null, created_at: '2026-10-26T19:47:00Z' },
      { id: 'f2', shift_id: SH, type: 'float_out', amount: 200, reason: 'Ice', cashier_id: CASHIER, approved_by_name: 'Joshua', created_at: '2026-10-26T12:00:00Z' });
    db.expenses.push({ id: 'e1', shift_id: SH, description: 'Gas', amount: 300, payment_method: 'cash', recorded_by: CASHIER, approved_by_name: 'Joshua', created_at: '2026-10-26T13:00:00Z' });
  };
  await ok('GET /:id: a drawer-figure viewer gets the parts (= expected) and every cash in / out and cash expense with who and why', async () => {
    seed();
    const r = await req('GET', `/api/shifts/${SH}`, MANAGER_T);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body.expected_breakdown;
    assert.ok(b, 'the breakdown');
    assert.deepEqual({ ...b, movements: undefined }, { opening_float: 1000, cash_sales: 4450, cash_in: 4450, cash_out: 200, expenses: 300, expected: 9400, movements: undefined });
    assert.equal(b.opening_float + b.cash_sales + b.cash_in - b.cash_out - b.expenses, b.expected);
    assert.deepEqual(b.movements.map((m) => [m.kind, m.amount, m.reason, m.by, m.approved_by]),
      [['cash_out', 200, 'Ice', 'Amina', 'Joshua'], ['expense', 300, 'Gas', 'Amina', 'Joshua'], ['cash_in', 4450, null, 'Amina', null]]);
  });
  await ok('a cashier never gets the breakdown (A494 seesDrawerFigures) …', async () => {
    seed();
    const r = await req('GET', `/api/shifts/${SH}`, CASHIER_T);
    assert.equal(r.body?.expected_breakdown, undefined);
  });
  await ok('…nor the parts in the list (their own drawer included); a viewer gets them beside the total', async () => {
    seed();
    const c = await req('GET', '/api/shifts', CASHIER_T);
    assert.equal(c.status, 200); assert.ok(c.body.length === 1 && c.body[0].expected_cash_parts === undefined, JSON.stringify(c.body[0]));
    const m = await req('GET', '/api/shifts', MANAGER_T);
    assert.equal(m.body[0].expected_cash_live, 9400); assert.equal(m.body[0].expected_cash_parts.expected, 9400);
    assert.equal(m.body[0].expected_cash_parts.cash_in, 4450);
  });

  console.log('\nOwner settings (A594 part C)\n');
  await ok('approval PIN: an owner option now — the owner only (a settings.pos holder is refused), audited as the others', async () => {
    reset();
    const no = await req('PUT', '/api/controls/pos/approval_pin', SETTINGS_T, { enabled: true });
    assert.equal(no.status, 403); assert.equal(no.body.code, 'OWNER_ONLY');
    const yes = await req('PUT', '/api/controls/pos/approval_pin', OWNER_T, { enabled: true });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(db.feature_flags.find((f) => f.key === 'approval_pin')?.enabled, true);
    const C = require(path.join(DIST, 'routes/controls.js'));
    assert.ok(C.ownerSetsFeature('approval_pin'), 'the admin portal may no longer switch it');
    assert.equal(C.ownerSetsFeature('receipt_compact_layout'), null, 'receipt tuning stays the admin portal\'s');
  });

  console.log('\nThe web\'s breakdown (rendered)\n');
  const dreq = createRequire(path.join(DASH, 'package.json'));
  const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a594-'));
  try {
    await dreq('esbuild').build({ entryPoints: [path.join(DASH, 'src/components/ExpectedCashBreakdown.tsx')], bundle: true, format: 'esm',
      platform: 'node', outfile: path.join(bundleDir, 'b.mjs'), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'] });
    const B = await import(pathToFileURL(path.join(bundleDir, 'b.mjs')).href);
    const React = dreq('react'); const { renderToStaticMarkup } = dreq('react-dom/server');
    const b = { opening_float: 1000, cash_sales: 4450, cash_in: 9900, cash_out: 0, expenses: 0, expected: 15350, movements: [
      { kind: 'cash_in', amount: 4450, at: '2026-10-26T19:47:10Z', reason: null, by: 'Mary', approved_by: null },
      { kind: 'cash_in', amount: 5450, at: '2026-10-26T19:47:31Z', reason: null, by: 'Mary', approved_by: null }] };
    const html = renderToStaticMarkup(React.createElement(B.default, { b, currency: 'KES' }));
    await ok('the popup shows float + cash sales + cash in − cash out − expenses = expected, and each cash in with who / why / approver', () => {
      for (const s of ['How expected cash is made up', 'Opening float', 'Cash sales', 'Cash in', 'Cash out', 'Expenses (cash)', 'Expected cash', 'data-testid="expected-breakdown-total"']) assert.ok(html.includes(s), s);
      assert.match(html, /15,350/); assert.match(html, /4,450/); assert.match(html, /5,450/);
      assert.equal((html.match(/no reason given/g) ?? []).length, 2); assert.equal((html.match(/no approver/g) ?? []).length, 2);
      assert.equal((html.match(/by Mary/g) ?? []).length, 2);
    });
    await ok('nothing is drawn without the breakdown (someone who may not see drawer figures)', () => {
      assert.equal(renderToStaticMarkup(React.createElement(B.default, { b: null, currency: 'KES' })), '');
    });
    const page = fs.readFileSync(path.join(DASH, 'src/pages/ShiftReportsPage.tsx'), 'utf8');
    await ok('Shift Reports reads expected_breakdown from GET /api/shifts/:id and shows it in the popup', () => {
      assert.match(page, /setViewBreakdown\(d\?\.expected_breakdown && Array\.isArray\(d\.expected_breakdown\.movements\) \? d\.expected_breakdown : null\)/);
      assert.match(page, /<ExpectedCashBreakdown b=\{viewBreakdown\} currency=\{currency\} \/>/);
    });
  } finally { try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ } }
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
