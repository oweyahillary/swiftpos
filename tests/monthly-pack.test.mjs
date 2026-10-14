// A455 — the monthly pack: a branch's month laid out like the clients' own workbooks (Summary, Expenses, Cash / M-Pesa
// books), downloadable and emailed on the 1st.
// Owner, 2026-10-12: "I want to be able to generate such reports from the system"; "email and downloadable"; "manager can
// record".
//
//   cd apps/server && npm run build && cd ../.. && node tests/monthly-pack.test.mjs
//
// The REAL compiled builder (lib/monthlyPack.js) on a month like a client's June workbook; the REAL routes (routes/reports-monthly.js)
// behind the REAL requireAuth with an in-memory database; the REAL Excel writer read back with exceljs; the email decision.
//
// MUTATIONS TO CONFIRM BITE:
//   - refund rows skipped in the summary                     → "a refund comes off its day" fails
//   - expected / counted taken from unconfirmed shifts too    → "only confirmed shifts are counted" fails
//   - the cash book ignoring drawings or deposits             → "the cash book runs" fails
//   - orders bucketed by UTC date instead of the business day → "a 01:30 sale is the next day's" fails
//   - decideMonthlySend sending twice                          → "once a month" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/reports-monthly.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { buildPack, monthDays, previousMonth } = require(path.join(DIST, 'lib/monthlyPack.js'));
const { cleanMovement } = require(path.join(DIST, 'lib/moneyMovements.js'));
const { decideMonthlySend } = require(path.join(DIST, 'jobs/monthlyPackDecision.js'));
const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');

// ── the pure builder ──────────────────────────────────────────────────────────
const june = monthDays('2026-06');
const base = {
  businessName: 'Your Business', branchName: 'Main Branch', currency: 'KES', month: '2026-06', days: june,
  orders: [
    { day: '2026-06-01', payments: [{ method: 'cash', amount: 60106, status: 'completed' }] },
    { day: '2026-06-01', payments: [{ method: 'mpesa', amount: 17765, status: 'completed' }, { method: 'glovo', amount: 2765, status: 'completed' }] },
    { day: '2026-06-02', payments: [{ method: 'cash', amount: 28655, status: 'completed' }, { method: 'cash', amount: -655, status: 'refunded' }, { method: 'card', amount: 999, status: 'failed' }] },
  ],
  shifts: [
    { day: '2026-06-01', cashier: 'Amina', closed: true, expected: { cash: 63106, mpesa: 17765 }, confirmed: { cash: 63000, mpesa: 17765 }, reasons: { cash: 'short 106 — change' } },
    { day: '2026-06-02', cashier: 'Brian', closed: true, expected: { cash: 31000 }, confirmed: null, reasons: null },
    { day: '2026-06-02', cashier: 'Amina', closed: false, expected: null, confirmed: null, reasons: null },
  ],
  expenses: [
    { day: '2026-06-01', type: 'Utilities', description: 'TOKEN', amount: 4000, method: 'cash', by: 'Joshua' },
    { day: '2026-06-01', type: 'Ingredients', description: 'chicken b', amount: 13750, method: 'mpesa', by: 'Joshua' },
    { day: '2026-06-02', type: null, description: 'CABAGE', amount: 100, method: 'cash', by: null },
  ],
  floats: [{ day: '2026-06-01', type: 'float_out', amount: 200, reason: 'rider' }, { day: '2026-06-02', type: 'float_in', amount: 500, reason: 'change' }],
  movements: [
    { day: '2026-06-01', method: 'cash', kind: 'opening', amount: 10000, note: null, by: 'Owner' },
    { day: '2026-06-01', method: 'mpesa', kind: 'other_income', amount: 1500, note: 'used cooking oil sold', by: 'Joshua' },
    { day: '2026-06-02', method: 'cash', kind: 'bank_deposit', amount: 50000, note: null, by: 'Joshua' },
    { day: '2026-06-02', method: 'cash', kind: 'drawing', amount: 1000, note: 'owner lunch', by: 'Joshua' },
    { day: '2026-06-02', method: 'mpesa', kind: 'charges', amount: 120, note: null, by: 'Joshua' },
    { day: '2026-07-01', method: 'cash', kind: 'drawing', amount: 999, note: 'next month', by: 'Joshua' },
  ],
};
const P = buildPack(base);
const day = (d) => P.summary.rows.find((r) => r.day === d);

console.log('\nSummary — the client\'s "Summary" sheet\n');
await ok('one row per day of the month, sales by payment method (cash and M-Pesa first)', () => {
  assert.equal(P.summary.rows.length, 30);
  assert.deepEqual(P.methods, ['cash', 'mpesa', 'glovo']);
  assert.deepEqual(day('2026-06-01').byMethod, { cash: 60106, mpesa: 17765, glovo: 2765 });
  assert.equal(day('2026-06-01').total, 80636);   // the June sheet's first day: 80,636
});
await ok('a refund comes off its day; a failed payment does not count', () => {
  assert.deepEqual(day('2026-06-02').byMethod, { cash: 28000 });
});
await ok('only confirmed shifts are counted (Expected, Counted, Variance) — the sheet\'s "System" column, filled in', () => {
  assert.equal(day('2026-06-01').expected, 80871); assert.equal(day('2026-06-01').counted, 80765); assert.equal(day('2026-06-01').variance, -106);
  assert.equal(day('2026-06-02').counted, null, 'Brian\'s shift is not confirmed yet');
});
await ok('remarks: the manager\'s reason, and what is not final yet', () => {
  assert.deepEqual(day('2026-06-01').remarks, ['Amina, Cash: short 106 — change']);
  assert.deepEqual(day('2026-06-02').remarks, ['1 shift not confirmed', '1 shift still open']);
  assert.deepEqual(day('2026-06-02').cashiers, ['Brian', 'Amina']);
});

console.log('\nExpenses — the daily book and the month\n');
await ok('the daily book: each day\'s items and total, days without expenses left out', () => {
  assert.deepEqual(P.expenses.days.map((d) => [d.day, d.total, d.lines.length]), [['2026-06-01', 17750, 2], ['2026-06-02', 100, 1]]);
  assert.equal(P.expenses.total, 17850);
});
await ok('by type (largest first; untyped named) and by how they were paid', () => {
  assert.deepEqual(P.expenses.byType, [{ type: 'Ingredients', amount: 13750 }, { type: 'Utilities', amount: 4000 }, { type: 'Uncategorised', amount: 100 }]);
  assert.deepEqual(P.expenses.byMethod, [{ method: 'cash', amount: 4100 }, { method: 'mpesa', amount: 13750 }]);
});

console.log('\nThe books — "Cash Usage", "Mpesa Usage"\n');
await ok('the cash book runs: opening + sales + pay-ins − expenses − pay-outs − personal − bank deposits', () => {
  const cash = P.books.find((b) => b.method === 'cash');
  assert.equal(cash.opening, 10000);
  const d1 = cash.rows[0], d2 = cash.rows[1];
  assert.deepEqual([d1.sales, d1.expenses, d1.paidOut, d1.balance], [60106, 4000, 200, 65906]);
  assert.deepEqual([d2.sales, d2.otherIn, d2.expenses, d2.drawings, d2.deposits, d2.balance], [28000, 500, 100, 1000, 50000, 43306]);
  assert.equal(cash.closing, 43306);
  assert.equal(cash.rows[29].balance, 43306, 'carried to the month end');
});
await ok('the M-Pesa book: sales, other income (used oil sold), expenses paid by M-Pesa, charges', () => {
  const mp = P.books.find((b) => b.method === 'mpesa');
  assert.deepEqual([mp.rows[0].sales, mp.rows[0].otherIn, mp.rows[0].expenses, mp.rows[0].balance], [17765, 1500, 13750, 5515]);
  assert.equal(mp.rows[1].charges, 120); assert.equal(mp.closing, 5395);
});
await ok('a method with money gets its book (Glovo); next month\'s movements stay out', () => {
  assert.ok(P.books.some((b) => b.method === 'glovo'));
  assert.ok(!P.movements.some((m) => m.day.startsWith('2026-07')));
});
await ok('months: 30 / 31 / February; the 1st sends the month before', () => {
  assert.equal(monthDays('2026-02').length, 28); assert.equal(monthDays('2026-07').length, 31); assert.deepEqual(monthDays('2026-13'), []);
  assert.equal(previousMonth('2026-11-01'), '2026-10'); assert.equal(previousMonth('2027-01-01'), '2026-12');
});

console.log('\nRecording for the books\n');
await ok('a manager\'s entry is checked: kind, book, amount, a note where it says what it was', () => {
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '2026-06-02', method: 'Cash', kind: 'bank_deposit', amount: '50000' }).ok, true);
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '2026-06-02', method: 'cash', kind: 'drawing', amount: 1000 }).ok, false, 'personal needs a note');
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '2026-06-02', method: 'cash', kind: 'refund', amount: 1 }).ok, false);
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '2026-06-02', method: 'cash', kind: 'charges', amount: 0 }).ok, false);
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '2026-06-01', method: 'cash', kind: 'opening', amount: 0 }).ok, true, 'an opening balance of 0 is real');
  assert.equal(cleanMovement({ branch_id: 'b', movement_date: '02/06/2026', method: 'cash', kind: 'charges', amount: 5 }).ok, false);
});

console.log('\nThe email on the 1st\n');
await ok('only when switched on, only on the 1st from 07:00 EAT, once a month', () => {
  assert.equal(decideMonthlySend(false, '2026-11-01', 9, null), null);
  assert.equal(decideMonthlySend(true, '2026-11-02', 9, null), null);
  assert.equal(decideMonthlySend(true, '2026-11-01', 6, null), null);
  assert.equal(decideMonthlySend(true, '2026-11-01', 7, null), '2026-10');
  assert.equal(decideMonthlySend(true, '2026-11-01', 9, '2026-10'), null, 'already sent');
  assert.equal(decideMonthlySend(true, '2026-11-01', 9, '2026-09'), '2026-10');
});
await ok('the mailer carries the attachments on every provider (Resend, SendGrid, SMTP)', () => {
  const m = read('apps/server/src/lib/mailer.ts');
  assert.match(m, /export interface MailAttachment \{ filename: string; content: Buffer; contentType: string \}/);
  assert.match(m, /attachments: opts\.attachments\.map\(\(a\) => \(\{ filename: a\.filename, content: a\.content \}\)\)/);
  assert.match(m, /content: a\.content\.toString\('base64'\), filename: a\.filename, type: a\.contentType, disposition: 'attachment',/);
  assert.match(m, /sendViaSendGrid\(\{ from, to: opts\.to, subject: opts\.subject, html: opts\.html, attachments: opts\.attachments \}\)/);
  assert.match(m, /attachments: opts\.attachments\.map\(\(a\) => \(\{ filename: a\.filename, content: a\.content, contentType: a\.contentType \}\)\)/);
  const j = read('apps/server/src/jobs/monthlyPack.ts');
  assert.match(j, /schedule\.monthly_pack === true/);
  assert.match(j, /await writeLastSent\(biz\.id, month\);   \/\/ after a successful send/);
  assert.match(read('apps/server/src/index.ts'), /startMonthlyPackJob\(\);/);
});

// ── the real routes ───────────────────────────────────────────────────────────
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const MGR = '44444444-4444-4444-8444-444444444444', CASH = '55555555-5555-4555-8555-555555555555';
let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, name: 'Your Business', currency: 'KES' }],
    branches: [{ id: BR, business_id: BZ, name: 'Main Branch' }, { id: BR2, business_id: BZ, name: 'Second Branch' }],
    users: [{ id: MGR, name: 'Joshua' }, { id: CASH, name: 'Amina' }],
    business_settings: [], branch_settings: [],
    orders: [
      // 2026-06-01 22:30 UTC = 01:30 on 2 June in Nairobi → 2 June (midnight cut-off)
      { id: 'o1', business_id: BZ, branch_id: BR, status: 'completed', created_at: '2026-06-01T22:30:00.000Z', payments: [{ method: 'cash', amount: 500, status: 'completed' }] },
      { id: 'o2', business_id: BZ, branch_id: BR, status: 'completed', created_at: '2026-06-01T08:00:00.000Z', payments: [{ method: 'mpesa', amount: 700, status: 'completed' }] },
      { id: 'o3', business_id: BZ, branch_id: BR2, status: 'completed', created_at: '2026-06-01T08:00:00.000Z', payments: [{ method: 'cash', amount: 9999, status: 'completed' }] },
    ],
    shifts: [{ id: 's1', business_id: BZ, branch_id: BR, business_date: '2026-06-01', opened_at: '2026-06-01T05:00:00Z', status: 'closed', cashier_id: CASH,
      expected_methods: { mpesa: 700 }, confirmed_methods: { mpesa: 700 }, confirm_reasons: null, confirmed_at: '2026-06-01T20:00:00Z' }],
    expenses: [{ id: 'e1', business_id: BZ, branch_id: BR, expense_date: '2026-06-01', description: 'TOKEN', amount: 4000, payment_method: 'cash', recorded_by: MGR, expense_categories: { name: 'Utilities' } }],
    float_transactions: [], money_movements: [],
  };
};
let nextId = 1;
const MISSING = new Set();   // A467: a table the database does not have yet
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let del = false; let rng = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    const all = rows(); return rng ? all.slice(rng[0], rng[1] + 1) : all;
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'gte') return (k, v) => { f.push([k, (x) => String(x) >= String(v)]); return q; };
      if (prop === 'lte') return (k, v) => { f.push([k, (x) => String(x) <= String(v)]); return q; };
      if (prop === 'range') return (a, b) => { rng = [a, b]; return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert') return (r) => { const list = (db[table] ??= []); inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, ...x })); list.push(...inserted); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(MISSING.has(table)
        ? { data: null, error: { message: `relation "public.${table}" does not exist` } } : { data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/reports/monthly', require(path.join(DIST, 'routes/reports-monthly.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const token = (userId, keys, extra = {}) => jwt.sign({ userId, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: keys,
  permissionsVersion: 1, sessionId: 's-' + userId, surface: 'web', tokenType: 'access', ...extra }, process.env.JWT_SECRET, { expiresIn: '15m' });
const MANAGER = token(MGR, ['reports.financial', 'expenses.manage', 'expenses.view']);
const CASHIER = token(CASH, ['orders.create']);
const call = async (t, method, p, body) => {
  const r = await fetch(`${baseUrl}/api/reports/monthly${p}`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
  const isX = (r.headers.get('content-type') ?? '').includes('spreadsheet');
  return { status: r.status, body: isX ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) };
};

try {
  console.log('\nThe routes\n');
  await ok('the manager\'s branch, June: a 01:30 sale is the next day\'s (the business day), the other branch stays out', async () => {
    reset();
    const r = await call(MANAGER, 'GET', `?month=2026-06&branch_id=${BR}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d1 = r.body.summary.rows.find((x) => x.day === '2026-06-01'), d2 = r.body.summary.rows.find((x) => x.day === '2026-06-02');
    assert.deepEqual(d1.byMethod, { mpesa: 700 }); assert.deepEqual(d2.byMethod, { cash: 500 });
    assert.equal(d1.counted, 700); assert.deepEqual(d1.cashiers, ['Amina']);
    assert.equal(r.body.expenses.days[0].lines[0].by, 'Joshua');
    assert.equal(r.body.summary.total, 1200, 'the other branch\'s 9,999 is not in this pack');
  });
  await ok('a manager cannot read another branch; a cashier cannot read the pack; a month is required', async () => {
    reset();
    assert.equal((await call(MANAGER, 'GET', `?month=2026-06&branch_id=${BR2}`)).status, 403);
    assert.equal((await call(CASHIER, 'GET', `?month=2026-06&branch_id=${BR}`)).status, 403);
    assert.equal((await call(MANAGER, 'GET', `?month=June&branch_id=${BR}`)).status, 400);
  });
  await ok('the owner must pick a branch (one workbook per branch, as the clients keep them)', async () => {
    reset();
    const owner = token(MGR, ['*'], { isOwner: true });
    assert.equal((await call(owner, 'GET', '?month=2026-06')).status, 400);
    assert.equal((await call(owner, 'GET', `?month=2026-06&branch_id=${BR2}`)).status, 200);
  });
  await ok('A467: without migration 130 (no money_movements) the pack still builds, and the books list is empty', async () => {
    reset(); MISSING.add('money_movements');
    try {
      const r = await call(MANAGER, 'GET', `?month=2026-06&branch_id=${BR}`);
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.summary.total, 1200);
      const m = await call(MANAGER, 'GET', `/movements?month=2026-06&branch_id=${BR}`);
      assert.equal(m.status, 200); assert.deepEqual(m.body, []);
      MISSING.add('shifts');
      const bad = await call(MANAGER, 'GET', `?month=2026-06&branch_id=${BR}`);
      assert.equal(bad.status, 500, 'any other missing read still fails (it is not hidden)');
    } finally { MISSING.clear(); }
  });
  await ok('a manager records a bank deposit; it is in the cash book; a cashier cannot record', async () => {
    reset();
    const a = await call(MANAGER, 'POST', '/movements', { branch_id: BR, movement_date: '2026-06-02', method: 'cash', kind: 'bank_deposit', amount: 300 });
    assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.recorded_by_name, 'Joshua');
    assert.equal((await call(CASHIER, 'POST', '/movements', { branch_id: BR, movement_date: '2026-06-02', method: 'cash', kind: 'bank_deposit', amount: 300 })).status, 403);
    assert.equal((await call(MANAGER, 'POST', '/movements', { branch_id: BR2, movement_date: '2026-06-02', method: 'cash', kind: 'bank_deposit', amount: 300 })).status, 403);
    const p = (await call(MANAGER, 'GET', `?month=2026-06&branch_id=${BR}`)).body;
    assert.equal(p.books.find((b) => b.method === 'cash').rows[1].deposits, 300);
    const del = await call(MANAGER, 'DELETE', `/movements/${a.body.id}`);
    assert.equal(del.status, 200); assert.equal(db.money_movements.length, 0);
  });
  await ok('A466: a manager signed in on a till with their PIN reads the pack and records for the books; the till\'s own token cannot', async () => {
    reset();
    db.user_devices = [{ business_id: BZ, device_id: 'dev-T1', status: 'active', retired_at: null }];
    const TILL_MGR = token(MGR, ['reports.financial', 'expenses.manage'], { surface: 'desktop', pinSignIn: true });
    const TILL_CASHIER = token(CASH, ['orders.create'], { surface: 'desktop', pinSignIn: true });
    const DEVICE = token(null, ['*'], { surface: 'desktop', till: true, deviceId: 'dev-T1' });
    const g = await call(TILL_MGR, 'GET', `?month=2026-06&branch_id=${BR}`);
    assert.equal(g.status, 200, JSON.stringify(g.body)); assert.equal(g.body.summary.total, 1200);
    assert.equal((await call(TILL_MGR, 'GET', `/export?month=2026-06&branch_id=${BR}`)).status, 200);
    const a = await call(TILL_MGR, 'POST', '/movements', { branch_id: BR, movement_date: '2026-06-02', method: 'cash', kind: 'bank_deposit', amount: 300 });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal((await call(TILL_MGR, 'DELETE', `/movements/${a.body.id}`)).status, 200);
    assert.equal((await call(TILL_MGR, 'GET', `?month=2026-06&branch_id=${BR2}`)).status, 403, 'own branch only, on the till too');
    assert.equal((await call(TILL_CASHIER, 'GET', `?month=2026-06&branch_id=${BR}`)).status, 403, 'their own permissions apply');
    const d = await call(DEVICE, 'GET', `?month=2026-06&branch_id=${BR}`);
    assert.equal(d.status, 403, JSON.stringify(d.body)); assert.equal(d.body.code, 'WEB_SURFACE_REQUIRED');
  });
  await ok('the Excel download has the client\'s sheets, with the figures in them', async () => {
    reset();
    const r = await call(MANAGER, 'GET', `/export?month=2026-06&branch_id=${BR}`);
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Expenses', 'Expenses by type', 'Cash Usage', 'M-Pesa Usage', 'Movements']);
    const s = wb.getWorksheet('Summary');
    const values = []; s.eachRow((row) => values.push(row.values.slice(1)));
    assert.ok(values.some((v) => v[0] === 'Total' && v.includes(1200)), JSON.stringify(values.slice(-1)));
    const e = []; wb.getWorksheet('Expenses').eachRow((row) => e.push(row.values.slice(1)));
    assert.ok(e.some((v) => v.includes('TOKEN') && v.includes(4000)));
  });
  await ok('wired: mounted before /reports; the tab and the scheduler switch exist', () => {
    const idx = read('apps/server/src/routes/index.ts');
    assert.ok(idx.indexOf("router.use('/reports/monthly', reportsMonthlyRoutes)") < idx.indexOf("router.use('/reports',        reportsRoutes)"));
    assert.match(read('apps/dashboard/src/pages/ReportsPage.tsx'), /\{ id: 'monthly',    label: 'Monthly pack' \}/);
    assert.match(read('apps/dashboard/src/pages/settings/ReportSchedulerTab.tsx'), /monthly_pack: !s\.monthly_pack/);
    assert.match(read('migrations/130_money_movements.sql'), /CHECK \(kind IN \('opening', 'other_income', 'drawing', 'bank_deposit', 'charges'\)\)/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
