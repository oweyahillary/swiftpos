/**
 * shift-confirm.test.mjs — A365 (2026-09-29): a manager confirms every cashier's shift, on every payment method.
 *
 * Owner: "the managers should confirm shift before closing the day … They should recount incase the cashier submitted
 * less than the amount … applies to both [till and web] … on all payment method not just mpesa"; a manager's own
 * shift: "allowed, flagged".
 *
 *   node tests/shift-confirm.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED lib/shiftConfirm.js and routes/shifts.js (POST /:id/close, /confirmer, /:id/confirm) behind the
 * real auth middleware over HTTP, against an in-memory database.
 *
 * MUTATIONS TO CONFIRM BITE: mayConfirm true for a cashier → "a cashier's PIN confirms nothing" fails; the replay
 * without the same-till check → "another till cannot replay" fails; the update without `.is('confirmed_at', null)` +
 * the early 409 → "a second confirmation is refused" fails; the close not storing declared_methods → "the cashier's
 * declaration is stored" fails; confirm left off the till write allowlist → "the till may call /confirm" fails.
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

if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) {
  console.log('\nCannot load apps/server/dist/routes/shifts.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const C = require(path.join(DIST, 'lib/shiftConfirm.js'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const bcrypt = require('bcrypt');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const T1 = 'ed377ee4-bbe6-46c1-8fd7-e851d9edadb9', T2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S1 = '33333333-3333-4333-8333-333333333333';
const pinHash = (p) => bcrypt.hashSync(p, 4);
const role = (name, keys) => ({ name, role_permissions: keys.map((k) => ({ permissions: { key: k } })) });

let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER }],
    users: [
      { id: CASHIER, business_id: BZ, status: 'active', name: 'Test Cashier', pin_hash: pinHash('1111'), roles: role('Cashier', ['orders.create']), user_permissions: [] },
      { id: MANAGER, business_id: BZ, status: 'active', name: 'Mary Manager', pin_hash: pinHash('2222'), roles: role('Manager', ['orders.void', 'shifts.manage']), user_permissions: [] },
      { id: OWNER, business_id: BZ, status: 'active', name: 'Eugene', pin_hash: pinHash('3333'), roles: role('Owner', []), user_permissions: [] },
    ],
    shifts: [{ id: S1, business_id: BZ, branch_id: BR, device_id: T1, terminal_code: 'T1', cashier_id: CASHIER, opened_by: CASHIER,
               status: 'open', opening_float: 2000, opened_at: '2026-09-29T10:41:00Z' }],
    orders: [{ id: 'o1', shift_id: S1, status: 'completed' }, { id: 'o2', shift_id: S1, status: 'completed' }],
    payments: [
      { order_id: 'o1', method: 'cash', amount: 500, status: 'completed' },
      { order_id: 'o2', method: 'mpesa', amount: 3250, status: 'completed' },
      { order_id: 'o2', method: 'card', amount: 700, status: 'completed' },
    ],
    float_transactions: [], expenses: [],
  };
};

// In-memory stand-in for the Supabase client: filters, order/range, update, maybeSingle/single.
supabase.from = (table) => {
  const f = []; let patch = null; let range = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (patch) {
      const hit = rows();
      for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null };
    }
    const all = rows();
    return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (v === null ? x == null : x === v)]); return q; };
      if (prop === 'range') return (a, b) => { range = [a, b]; return q; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); };
      if (prop === 'single') return () => { const r = run(); return Promise.resolve(r.data[0] ? { data: r.data[0], error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tok = (userId, surface, keys = []) => jwt.sign({ userId, businessId: BZ, branchId: BR, isOwner: userId === OWNER, permissionKeys: keys,
  permissionsVersion: 0, sessionId: 's', surface }, process.env.JWT_SECRET);
const call = async (p, body, { user = CASHIER, surface = 'desktop', keys = ['orders.create'], device = T1 } = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/shifts${p}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok(user, surface, keys)}`, 'content-type': 'application/json', 'x-device-id': device },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const shift = () => db.shifts.find((s) => s.id === S1);

try {
  await ok('rules: a cashier may not confirm; a manager (orders.void / shifts.manage), the owner may', () => {
    reset();
    assert.equal(C.mayConfirm(db.users[0], OWNER), false);
    assert.equal(C.mayConfirm(db.users[1], OWNER), true);
    assert.equal(C.mayConfirm(db.users[2], OWNER), true);
    assert.equal(C.mayConfirm({ id: 'x', roles: role('Supervisor', ['settings.manage']) }, OWNER), true);
  });
  await ok('rules: a method map is cleaned (codes lower-case, cents) and a bad one refused', () => {
    assert.deepEqual(C.methodMap({ ' Cash ': 5500.004, MPESA: '3250' }), { cash: 5500, mpesa: 3250 });
    assert.equal(C.methodMap({ cash: -1 }), null);
    assert.equal(C.methodMap({ cash: 'x' }), null);
    assert.equal(C.methodMap({}), null);
    assert.equal(C.methodMap([1]), null);
  });
  await ok('rules: lines per method — cash first; variance = confirmed − expected; mismatch = recount ≠ declaration', () => {
    const l = C.confirmationLines({ cash: 2500, mpesa: 3250 }, { cash: 2500, mpesa: 3250, card: 700 }, { cash: 2400, mpesa: 3250, card: 700 });
    assert.deepEqual(l.map((x) => x.method), ['cash', 'card', 'mpesa']);
    assert.deepEqual(l[0], { method: 'cash', declared: 2500, expected: 2500, confirmed: 2400, variance: -100, mismatch: true });
    assert.equal(l[1].mismatch, true, 'the cashier declared no card (0) — the manager found 700');
    assert.equal(l[2].mismatch, false);
  });

  await ok('the cashier\'s declaration is stored at close (cash = the counted drawer, whatever else was sent)', async () => {
    reset();
    const r = await call(`/${S1}/close`, { closing_float: 2500, declared_methods: { cash: 9, MPESA: 3250, card: 0 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(shift().declared_methods, { cash: 2500, mpesa: 3250, card: 0 });
  });
  await ok('a close from an older build (no declaration) stores none — nothing awaits a manager', async () => {
    reset();
    const r = await call(`/${S1}/close`, { closing_float: 2500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(shift().declared_methods, undefined);
  });

  const closeFirst = async () => { reset(); await call(`/${S1}/close`, { closing_float: 2500, declared_methods: { mpesa: 3250, card: 0 } }); };

  await ok('an open shift cannot be confirmed', async () => {
    reset();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 } }, { user: MANAGER, surface: 'web', keys: ['orders.void'] });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'SHIFT_OPEN');
  });
  await ok('the web POS: a cashier alone cannot confirm — a manager\'s PIN is needed', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 } }, { surface: 'web' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CONFIRMER_REQUIRED');
    assert.equal(shift().confirmed_at, undefined);
  });
  await ok('a cashier\'s PIN confirms nothing (same answer as a wrong PIN)', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 }, pin: '1111' }, { surface: 'web' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'INVALID_CONFIRMER_PIN');
  });
  await ok('a manager\'s PIN at the web POS confirms: every method, expected from the cloud, lines back', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2400, mpesa: 3250, card: 700 }, pin: '2222' }, { surface: 'web' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = shift();
    assert.equal(s.confirmed_by, MANAGER); assert.equal(s.confirm_self, false); assert.ok(s.confirmed_at);
    assert.deepEqual(s.expected_methods, { cash: 2500, mpesa: 3250, card: 700 });
    assert.deepEqual(s.confirmed_methods, { cash: 2400, mpesa: 3250, card: 700 });
    assert.equal(r.body.confirmer_name, 'Mary Manager');
    assert.deepEqual(r.body.lines.find((x) => x.method === 'cash'), { method: 'cash', declared: 2500, expected: 2500, confirmed: 2400, variance: -100, mismatch: true });
  });
  await ok('a second confirmation is refused', async () => {
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 }, pin: '3333' }, { surface: 'web' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'ALREADY_CONFIRMED');
    assert.equal(shift().confirmed_by, MANAGER, 'the first confirmation stands');
  });
  await ok('a manager signed in on the dashboard confirms as themselves (no PIN)', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500, mpesa: 3250, card: 700 } }, { user: MANAGER, surface: 'web', keys: ['orders.void'] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(shift().confirmed_by, MANAGER);
  });
  await ok('the owner confirming a shift they worked is allowed — flagged self-confirmed', async () => {
    await closeFirst(); shift().cashier_id = OWNER;
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 }, pin: '3333' }, { surface: 'web' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(shift().confirm_self, true);
  });
  await ok('the till replays its offline confirmation: the till\'s manager, the till\'s time and figures', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500, mpesa: 3250 }, confirmed_by: MANAGER,
      confirmed_at: '2026-09-29T09:02:00.000Z', expected_methods: { cash: 2500, mpesa: 3250 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(shift().confirmed_by, MANAGER); assert.equal(shift().confirmed_at, '2026-09-29T09:02:00.000Z');
    assert.equal(C.replayTime('2999-01-01T00:00:00Z', new Date('2026-09-29T12:00:00Z')), '2026-09-29T12:00:00.000Z', 'a time from the future is not kept');
    assert.deepEqual(shift().expected_methods, { cash: 2500, mpesa: 3250 });
  });
  await ok('the replay is refused when the named person may not confirm (a cashier)', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 }, confirmed_by: CASHIER });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'NOT_A_CONFIRMER');
  });
  await ok('another till cannot replay a confirmation for T1\'s shift', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500 }, confirmed_by: MANAGER }, { device: T2 });
    assert.equal(r.status, 403); assert.equal(shift().confirmed_at, undefined);
  });
  await ok('POST /confirmer: a manager\'s PIN names them; a cashier\'s does not', async () => {
    reset();
    const a = await call('/confirmer', { pin: '2222' });
    assert.equal(a.status, 200); assert.deepEqual(a.body, { id: MANAGER, name: 'Mary Manager' });
    const b = await call('/confirmer', { pin: '1111' });
    assert.equal(b.status, 403); assert.equal(b.body.code, 'INVALID_CONFIRMER_PIN');
  });
  await ok('the till may call /confirm and /confirmer when the terminal write guard is enforced', () => {
    const { terminalWriteDenied } = require(path.join(DIST, 'middleware/auth.js'));
    assert.equal(terminalWriteDenied('desktop', 'POST', `/api/shifts/${S1}/confirm`), false);
    assert.equal(terminalWriteDenied('desktop', 'POST', '/api/shifts/confirmer'), false);
    assert.equal(terminalWriteDenied('desktop', 'DELETE', `/api/shifts/${S1}`), true, 'still no blanket /api/shifts');
  });
  await ok('the web POS: Close Shift declares every method and sends it; "Manager: confirm now" posts a PIN + recount', () => {
    const m = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/ShiftModal.tsx'), 'utf8');
    assert.match(m, /toDeclare\.map\(\(m\) => \(/);
    assert.match(m, /declared_methods: declared\.map,/);
    assert.match(m, /data-testid="confirm-now"/);
    assert.match(m, /signedInManager \? \{ confirmed_methods: r\.map \} : \{ confirmed_methods: r\.map, pin: confirmPin\.trim\(\) \}/);
  });
  await ok('0.6.23 web POS: only methods with money on them; the float reminder; a signed-in manager is not asked for a PIN; no wheel', () => {
    const m = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/ShiftModal.tsx'), 'utf8');
    assert.match(m, /const toDeclare = methodsToDeclare\(taken\);/);
    assert.match(m, /posApi\.get<\{ by_method\?: \{ method: string; amount: number \}\[\] \}>\(`\/api\/shifts\/\$\{shiftId\}`\)/);
    assert.match(m, /Cash Counted \(\{currency\}\) — include the opening float/);
    assert.match(m, /const signedInManager = maySignedInConfirm\(session\);/);
    assert.match(m, /\{!signedInManager && \(/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/main.tsx'), 'utf8'), /stopWheelOnNumberInputs\(document\);/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/index.css'), 'utf8'), /input\[type='number'\]::-webkit-inner-spin-button/);
  });
  await ok('0.6.23 cloud: a manager signed in on the web POS confirms without a PIN', async () => {
    await closeFirst();
    const r = await call(`/${S1}/confirm`, { confirmed_methods: { cash: 2500, mpesa: 3250, card: 700 } }, { user: MANAGER, surface: 'web', keys: ['orders.void'] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(shift().confirmed_by, MANAGER);
  });
  await ok('the dashboard lists shifts awaiting a manager and confirms them blind; mismatches and self-confirms shown', () => {
    const c = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/components/ShiftConfirmations.tsx'), 'utf8');
    assert.match(c, /api\.post\(`\/api\/shifts\/\$\{target\.id\}\/confirm`, \{ confirmed_methods: r\.map \}\)/);
    const dialog = c.split('{target && (')[1];
    assert.ok(!/expected_methods|declared_methods\[|money\(target/.test(dialog), 'the recount dialog shows no figures');
    assert.match(c, /data-testid="self-confirmed"/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/OpenShiftsPage.tsx'), 'utf8'), /<ShiftConfirmations \/>/);
  });
  await ok('0.6.23 Shift Reports page: list (cashier, till, shift, status, difference, View), filters, CSV; View = the per-method table', () => {
    const pg = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/ShiftReportsPage.tsx'), 'utf8');
    assert.match(pg, /api\.get<ShiftRow\[\]>\(`\/api\/shifts\?\$\{qs\}`\)/);
    assert.match(pg, /<th className="px-3 py-2">Cashier<\/th><th>Till<\/th><th>Shift<\/th><th>Status<\/th><th>Difference<\/th>/);
    assert.match(pg, /api\.get<\{ by_method\?: \{ method: string; amount: number \}\[\] \}>\(`\/api\/shifts\/\$\{s\.id\}`\)/);
    assert.match(pg, /<th className="py-1">Method<\/th><th className="text-right">Cashier said<\/th><th className="text-right">Manager counted<\/th><th className="text-right">Till recorded<\/th><th className="text-right">Variance<\/th>/);
    assert.match(pg, /\['problems', `Problems \(\$\{counts\.problems\}\)`\]/);
    assert.match(pg, /const exportCsv = \(\) =>/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/App.tsx'), 'utf8'), /<Route path="shift-reports"\s+element=\{<ShiftReportsPage \/>\} \/>/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/components/DashboardLayout.tsx'), 'utf8'), /\{ to: '\/dashboard\/shift-reports', label: 'Shift Reports'/);
  });
  await ok('Shift Reports print a REPORT (an A4 document built from the data), never the page', () => {
    const pg = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/ShiftReportsPage.tsx'), 'utf8');
    assert.ok(!/window\.print\(\)/.test(pg), 'no page print');
    assert.match(pg, /printDocument\(shiftDocSpec\(\{/);
    assert.match(pg, /printDocument\(shiftListDocSpec\(\{/);
    const ds = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/documentSpecs.ts'), 'utf8');
    assert.match(ds, /docType: 'SHIFT REPORT',/);
    assert.match(ds, /\{ label: 'Method' \}, \{ label: 'Cashier said', align: 'right' \}, \{ label: 'Manager counted', align: 'right' \},/);
    assert.match(ds, /signatures: \['Cashier', 'Manager'\],/);
    assert.match(ds, /docType: 'SHIFT REPORTS',/);
    assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/printDocument.ts'), 'utf8'), /\.note \{ margin-top:20px; font-size:12px; white-space:pre-line; \}/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
