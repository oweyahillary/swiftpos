// A476 — the owner's emails beyond the daily report: what the daily email includes, the branch managers' always-on
// "tills not closed" email, alerts as they happen (a till not syncing, a big void / refund, a big cash difference at
// confirm), the weekly summary.
// Owner, 2026-10-14: "tills not confirmed or closed by manager, and any other important email but the owner can turn
// them off. Branch manager should always get an email about tills which are not closed."
//
//   cd apps/server && npm run build && cd ../.. && node tests/owner-alerts.test.mjs
//
// The REAL compiled decisions (jobs/ownerAlertsDecision.js) and email builders (jobs/ownerEmails.js); the REAL job entry
// points (jobs/ownerAlerts.js, jobs/dailySummary.js) against an in-memory database (supabase.from stubbed) with every
// email captured (mailer.sendEmail stubbed); the REAL settings route (routes/business.js) behind the REAL requireAuth.
//
// MUTATIONS TO CONFIRM BITE (each was made and seen to fail, then reverted):
//   - decideBranchSlot ignoring lastSent (no dedup)                        → "once per branch per slot" fails
//   - selectOpenTills keeping today's shifts in the 09:00 slot             → "the 09:00 repeat lists only the earlier days'" fails
//   - branchOpenTillsForBusiness returning early when the daily report is off → "always on" fails
//   - decideNotSyncing alerting whenever stale (no incident memory)        → "once per incident" fails
//   - bigReversals using > instead of >=                                    → "at the amount counts" fails
//   - esc() not escaping <                                                  → "every typed name is escaped" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'jobs/ownerAlerts.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const D = require(path.join(DIST, 'jobs/ownerAlertsDecision.js'));
const E = require(path.join(DIST, 'jobs/ownerEmails.js'));

// ── an in-memory database ─────────────────────────────────────────────────────
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
let db; let nextId = 1;
/** (table, eq-filters) → an error message to fail that read with (one business failing must not stop the others). */
let FAIL = () => null;
const cmp = (x, v, op) => {
  if (x === null || x === undefined) return false;
  if (typeof v === 'number') { const n = Number(x); return op === 'gte' ? n >= v : op === 'lte' ? n <= v : op === 'gt' ? n > v : n < v; }
  const a = String(x), b = String(v);
  return op === 'gte' ? a >= b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a < b;
};
supabase.from = (table) => {
  const f = []; const eqs = {}; let patch = null; let inserted = null; let del = false; let rng = null; let lim = null; let ord = null; let countHead = false;
  const rows = () => (db[table] ?? []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    const err = FAIL(table, eqs);
    if (err) return { error: { message: err } };
    if (inserted) return { data: inserted };
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return { data: hit }; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return { data: hit }; }
    let all = rows();
    if (ord) all = [...all].sort((a, b) => (String(a[ord[0]] ?? '') < String(b[ord[0]] ?? '') ? -1 : String(a[ord[0]] ?? '') > String(b[ord[0]] ?? '') ? 1 : 0) * (ord[1] ? 1 : -1));
    if (rng) all = all.slice(rng[0], rng[1] + 1);
    if (lim !== null) all = all.slice(0, lim);
    if (countHead) return { data: null, count: all.length };
    return { data: all.map((r) => ({ ...r })) };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'select') return (_c, opts) => { if (opts?.head) countHead = true; return q; };
      if (prop === 'eq') return (k, v) => { eqs[k] = v; f.push((r) => r[k] === v); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; };
      if (prop === 'not') return (k, op, v) => { f.push((r) => (op === 'is' && v === null ? r[k] != null : r[k] !== v)); return q; };
      if (['gte', 'lte', 'gt', 'lt'].includes(prop)) return (k, v) => { f.push((r) => cmp(r[k], v, prop)); return q; };
      if (prop === 'ilike') return (k, v) => { f.push((r) => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase()); return q; };
      if (prop === 'order') return (k, o) => { ord = [k, o?.ascending !== false]; return q; };
      if (prop === 'range') return (a, b) => { rng = [a, b]; return q; };
      if (prop === 'limit') return (n) => { lim = n; return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert') return (r) => { const list = (db[table] ??= []); inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, ...x })); list.push(...inserted); return q; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve(r.error ? { data: null, error: r.error } : { data: r.data?.[0] ?? null, error: null }); };
      if (prop === 'single') return () => { const r = run(); const x = r.data?.[0]; return Promise.resolve(x ? { data: x, error: null } : { data: null, error: r.error ?? { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => { const r = run(); return Promise.resolve(r.error ? { data: null, error: r.error } : { data: r.data, count: r.count, error: null }).then(res, rej); };
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });
const OWNER_EMAILS = {};
supabase.auth.admin.getUserById = async (id) => (OWNER_EMAILS[id] ? { data: { user: { email: OWNER_EMAILS[id] } }, error: null } : { data: null, error: { message: 'no user' } });

// ── captured email ────────────────────────────────────────────────────────────
const mailer = require(path.join(DIST, 'lib/mailer.js'));
let SENT = []; let MAIL_FAILS = false;
mailer.sendEmail = async (m) => { if (MAIL_FAILS) throw new Error('provider refused'); SENT.push(m); };
const to = (m) => m.to.split(',').map((s) => s.trim()).sort();

const J = require(path.join(DIST, 'jobs/ownerAlerts.js'));
const DS = require(path.join(DIST, 'jobs/dailySummary.js'));

// ── a business ────────────────────────────────────────────────────────────────
const BZ = '11111111-1111-4111-8111-111111111111', BZ2 = '99999999-9999-4999-8999-999999999999';
const OWNER = '00000000-0000-4000-8000-000000000001', OWNER2 = '00000000-0000-4000-8000-000000000002';
const BR1 = 'br-1', BR2 = 'br-2';
OWNER_EMAILS[OWNER] = 'owner@biz.test';
OWNER_EMAILS[OWNER2] = 'owner2@biz.test';
const biz = { id: BZ, name: 'Mama Ngina Foods', owner_id: OWNER, currency: 'KES' };
const at = (s) => new Date(s);
// 14 Oct 2026: 21:05 EAT = 18:05 UTC
const EVENING = at('2026-10-14T18:05:00Z');
const schedule = (o = {}) => ({ enabled: false, send_time: '21:00', recipients: ['books@biz.test'], ...o });

const reset = () => {
  SENT = []; MAIL_FAILS = false; FAIL = () => null;
  db = {
    businesses: [{ ...biz }],
    branches: [{ id: BR1, business_id: BZ, name: 'Mama Ngina' }, { id: BR2, business_id: BZ, name: 'Kilimani' }],
    users: [
      // A490: report e-mails go to staff whose role holds reports.overview (the role names decide nothing).
      { id: 'u-own', business_id: BZ, name: 'Owner', email: 'owner@biz.test', status: 'active', roles: { name: 'Owner' }, user_branches: [] },
      { id: 'u-m1', business_id: BZ, name: 'Joshua', email: 'joshua@biz.test', status: 'active', roles: { name: 'Manager', role_permissions: [{ permissions: { key: 'reports.overview' } }] }, user_branches: [{ branch_id: BR1 }] },
      { id: 'u-m2', business_id: BZ, name: 'Wanjiru', email: 'wanjiru@biz.test', status: 'active', roles: { name: 'Branch Manager', role_permissions: [{ permissions: { key: 'reports.overview' } }] }, user_branches: [{ branch_id: BR2 }] },
      { id: 'u-m3', business_id: BZ, name: 'Gone', email: 'gone@biz.test', status: 'inactive', roles: { name: 'Manager', role_permissions: [{ permissions: { key: 'reports.overview' } }] }, user_branches: [{ branch_id: BR1 }] },
      { id: 'u-c1', business_id: BZ, name: 'Amina <b>', email: 'amina@biz.test', status: 'active', roles: { name: 'Cashier' }, user_branches: [{ branch_id: BR1 }] },
    ],
    business_settings: [], branch_settings: [],
    shifts: [], orders: [], payments: [], float_transactions: [], expenses: [], user_devices: [],
    stock_levels: [], products: [], notifications: [], order_items: [],
  };
};
const openShift = (o) => ({ id: `s-${nextId++}`, business_id: BZ, branch_id: BR1, cashier_id: 'u-c1', device_id: 'dev-1', terminal_code: null,
  opened_at: '2026-10-14T05:00:00Z', closed_at: null, status: 'open', business_date: '2026-10-14', declared_methods: null, confirmed_at: null,
  opening_float: 2000, expected_cash: null, expected_methods: null, ...o });
const setting = (key) => db.business_settings.find((r) => r.business_id === BZ && r.key === key)?.value;

// ══ the pure rules ════════════════════════════════════════════════════════════
console.log('\nSettings — defaults when a key is missing\n');
await ok('defaults: every section and alert on, the weekly summary off, 4 h / 5,000 / 1,000', () => {
  const a = D.readAlerts({});
  assert.deepEqual(a, { open_tills: true, variances: true, voids_refunds: true, tills_not_syncing: true, expenses: true, low_stock: true,
    top_products: true, alert_not_syncing: true, not_syncing_hours: 4, alert_big_void: true, big_void_amount: 5000,
    alert_variance: true, variance_amount: 1000, weekly_summary: false });
  assert.deepEqual(D.readAlerts(null), a); assert.deepEqual(D.readAlerts('not json'), a);
  assert.deepEqual(D.readAlerts(JSON.stringify(JSON.stringify({}))), a, 'stored double-encoded');
});
await ok('switched off, amounts set; nonsense amounts fall back; the older include_low_stock still counts', () => {
  const a = D.readAlerts(JSON.stringify({ open_tills: false, alert_big_void: 'false', weekly_summary: true, big_void_amount: '7,500', variance_amount: -5, not_syncing_hours: 500 }));
  assert.equal(a.open_tills, false); assert.equal(a.alert_big_void, false); assert.equal(a.weekly_summary, true);
  assert.equal(a.big_void_amount, 7500); assert.equal(a.variance_amount, 1000); assert.equal(a.not_syncing_hours, 4);
  assert.equal(D.readAlerts({ include_low_stock: false }).low_stock, false);
  assert.equal(D.readAlerts({ include_low_stock: false, low_stock: true }).low_stock, true, 'the new key wins');
});
await ok('what the route stores: known keys only, a bad time is 21:00, real addresses only, amounts cleaned', () => {
  const c = D.cleanReportSchedule(JSON.stringify({ enabled: true, send_time: '25:99', recipients: ['A@B.co', 'nope', 'a@b.co', '<x>@y.z'],
    monthly_pack: true, big_void_amount: 'lots', alert_variance: false, evil: '<script>' }));
  assert.equal(c.send_time, '21:00'); assert.deepEqual(c.recipients, ['a@b.co']);
  assert.equal(c.big_void_amount, 5000); assert.equal(c.alert_variance, false); assert.equal(c.monthly_pack, true);
  assert.ok(!('evil' in c));
  assert.equal(D.cleanReportSchedule('[1,2]'), null); assert.equal(D.cleanReportSchedule(5), null);
});

console.log('\nWhich tills are "not done"\n');
await ok('open and closed-but-not-confirmed count; confirmed, forced and pre-110 closes do not; older ones are flagged', () => {
  const rows = [
    { id: 'a', branch_id: BR1, status: 'open', opened_at: '2026-10-14T05:00:00Z', business_date: '2026-10-14' },
    { id: 'b', branch_id: BR1, status: 'closed', opened_at: '2026-10-14T04:00:00Z', business_date: '2026-10-14', declared_methods: { cash: 1 }, confirmed_at: null },
    { id: 'c', branch_id: BR1, status: 'closed', opened_at: '2026-10-14T04:00:00Z', declared_methods: { cash: 1 }, confirmed_at: '2026-10-14T10:00:00Z' },
    { id: 'd', branch_id: BR1, status: 'closed_unreconciled', opened_at: '2026-10-14T04:00:00Z', declared_methods: null },
    { id: 'e', branch_id: BR1, status: 'closed', opened_at: '2026-10-14T04:00:00Z', declared_methods: null },
    { id: 'f', branch_id: BR1, status: 'open', opened_at: '2026-10-12T05:00:00Z', business_date: null },
  ];
  const sel = D.selectOpenTills(rows, '2026-10-14');
  assert.deepEqual(sel.map((r) => [r.shift.id, r.state, r.older]), [['f', 'open', true], ['b', 'awaiting_confirm', false], ['a', 'open', false]]);
});
await ok('the 09:00 repeat lists only the earlier days\' — a till opened this morning is trading, not forgotten', () => {
  const rows = [
    { id: 'today', branch_id: BR1, status: 'open', opened_at: '2026-10-15T05:00:00Z', business_date: '2026-10-15' },
    { id: 'night', branch_id: BR1, status: 'open', opened_at: '2026-10-14T15:00:00Z', business_date: '2026-10-14' },
  ];
  assert.deepEqual(D.selectOpenTills(rows, '2026-10-15', 0, 'morning').map((r) => r.shift.id), ['night']);
  assert.deepEqual(D.selectOpenTills(rows, '2026-10-15', 0, 'evening').map((r) => r.shift.id).sort(), ['night', 'today']);
  // a shift opened at 01:30 EAT with the day ending at 04:00 belongs to the night before
  assert.equal(D.shiftBusinessDate({ id: 'x', branch_id: BR1, status: 'open', opened_at: '2026-10-14T22:30:00Z' }, 240), '2026-10-14');
});

console.log('\nThe branch managers\' slots\n');
await ok('at send_time, again at 09:00; once per branch per slot', () => {
  assert.equal(D.decideBranchSlot('2026-10-14', '08:59', '21:00', null), null);
  assert.deepEqual(D.decideBranchSlot('2026-10-14', '09:00', '21:00', null), { slot: 'morning', stamp: '2026-10-14:morning' });
  assert.equal(D.decideBranchSlot('2026-10-14', '12:00', '21:00', '2026-10-14:morning'), null);
  assert.deepEqual(D.decideBranchSlot('2026-10-14', '21:05', '21:00', '2026-10-14:morning'), { slot: 'evening', stamp: '2026-10-14:evening' });
  assert.equal(D.decideBranchSlot('2026-10-14', '23:45', '21:00', '2026-10-14:evening'), null);
  assert.deepEqual(D.decideBranchSlot('2026-10-15', '09:10', '21:00', '2026-10-14:evening'), { slot: 'morning', stamp: '2026-10-15:morning' });
  assert.deepEqual(D.decideBranchSlot('2026-10-14', '21:00', 'garbage', null), { slot: 'evening', stamp: '2026-10-14:evening' }, 'a bad time is 21:00');
});
await ok('a send_time before 09:00: that slot first, then 09:00, never the earlier one again', () => {
  assert.deepEqual(D.decideBranchSlot('2026-10-14', '08:30', '08:00', null), { slot: 'evening', stamp: '2026-10-14:evening' });
  assert.deepEqual(D.decideBranchSlot('2026-10-14', '09:15', '08:00', '2026-10-14:evening'), { slot: 'morning', stamp: '2026-10-14:morning' });
  assert.equal(D.decideBranchSlot('2026-10-14', '15:00', '08:00', '2026-10-14:morning'), null);
});

console.log('\nAlert rules\n');
const NOW = at('2026-10-14T12:00:00Z');
const dev = (o = {}) => ({ id: 'd1', device_id: 'dev-1', branch_id: BR1, status: 'approved', retired_at: null,
  last_seen_at: '2026-10-14T11:55:00Z', last_sync_at: '2026-10-14T07:00:00Z', session_lost_at: null, ...o });
await ok('not syncing: alerts once per incident, only while trading; again only after it recovered', () => {
  const a = D.decideNotSyncing(dev(), NOW, 4, true, undefined);
  assert.deepEqual([a.send, a.kind, Math.round(a.hours), a.next], [true, 'stale', 5, 'stale:2026-10-14T07:00:00Z']);
  assert.equal(D.decideNotSyncing(dev(), NOW, 4, true, a.next).send, false, 'same incident');
  assert.deepEqual(D.decideNotSyncing(dev(), NOW, 6, true, undefined), { send: false, kind: null, hours: 5, next: null }, 'under the threshold');
  const closed = D.decideNotSyncing(dev(), NOW, 4, false, a.next);
  assert.equal(closed.send, false); assert.equal(closed.next, a.next, 'closed for the night: remembered, not cleared');
  const rec = D.decideNotSyncing(dev({ last_sync_at: '2026-10-14T11:50:00Z' }), NOW, 4, true, a.next);
  assert.equal(rec.next, null, 'recovered');
  const again = D.decideNotSyncing(dev({ last_sync_at: '2026-10-14T07:30:00Z' }), at('2026-10-14T13:00:00Z'), 4, true, rec.next);
  assert.equal(again.send, true, 'a new incident after recovering');
});
await ok('signed out (refused, needs rejoin): once, whatever the time; retired, blocked or never synced: nothing', () => {
  const r = D.decideNotSyncing(dev({ session_lost_at: '2026-10-14T10:00:00Z', last_sync_at: '2026-10-14T11:59:00Z' }), NOW, 4, false, undefined);
  assert.deepEqual([r.send, r.kind, r.next], [true, 'refused', 'refused:2026-10-14T10:00:00Z']);
  assert.equal(D.decideNotSyncing(dev({ session_lost_at: '2026-10-14T10:00:00Z' }), NOW, 4, false, r.next).send, false);
  assert.equal(D.decideNotSyncing(dev({ retired_at: '2026-10-01T00:00:00Z' }), NOW, 4, true, undefined).send, false);
  assert.equal(D.decideNotSyncing(dev({ status: 'blocked' }), NOW, 4, true, undefined).send, false);
  assert.equal(D.decideNotSyncing(dev({ last_sync_at: null }), NOW, 4, true, undefined).send, false);
});
await ok('trading: a drawer open on the branch, or the till on and talking after its last sync', () => {
  assert.equal(D.tillTrading(dev(), new Set([BR1]), NOW), true);
  assert.equal(D.tillTrading(dev({ app_version: '1.0.20' }), new Set(), NOW), true, 'seen 5 min ago, after its last sync (a heartbeat till)');
  assert.equal(D.tillTrading(dev({ app_version: '1.0.20', last_seen_at: '2026-10-14T06:00:00Z' }), new Set(), NOW), false, 'off since the morning');
  // A579: a till before 1.0.20 pushes only when it has drawer rows — on and quiet is no sign of trade.
  assert.equal(D.tillTrading(dev({ app_version: '1.0.5' }), new Set(), NOW), false, 'an old idle till is not "trading"');
  assert.equal(D.tillTrading(dev(), new Set(), NOW), false, 'no version: treated as old');
  assert.equal(D.tillTrading(dev({ app_version: '1.0.5' }), new Set([BR1]), NOW), true, 'a drawer open on its branch still counts');
});
await ok('a big void / refund: at the amount counts, under it does not; once per void', () => {
  const rows = [{ id: 'o1', kind: 'void', amount: 5000 }, { id: 'o2', kind: 'void', amount: 4999.99 }, { id: 'o1', kind: 'refund', amount: 9000 }];
  assert.deepEqual(D.bigReversals(rows, 5000, {}).map((r) => `${r.kind}:${r.id}`), ['void:o1', 'refund:o1']);
  assert.deepEqual(D.bigReversals(rows, 5000, { 'void:o1': 'x' }).map((r) => `${r.kind}:${r.id}`), ['refund:o1']);
});
await ok('a big cash difference at confirm: counted − expected, short or over; once per shift', () => {
  const s = [
    { id: 's1', confirmed_at: 'x', expected_methods: { cash: 10000 }, confirmed_methods: { cash: 8800 } },
    { id: 's2', confirmed_at: 'x', expected_methods: '{"cash":5000}', confirmed_methods: '{"cash":6000}' },
    { id: 's3', confirmed_at: 'x', expected_methods: { cash: 5000 }, confirmed_methods: { cash: 4500 } },
    { id: 's4', confirmed_at: null, expected_methods: { cash: 5000 }, confirmed_methods: { cash: 0 } },
    { id: 's5', confirmed_at: 'x', cash_variance: '-1500.00' },
  ];
  assert.deepEqual(D.bigVariances(s, 1000, {}).map((x) => [x.id, x.difference]), [['s1', -1200], ['s2', 1000], ['s5', -1500]]);
  assert.deepEqual(D.bigVariances(s, 1000, { 'shift:s1': 'x' }).map((x) => x.id), ['s2', 's5']);
});
await ok('the state forgets alerted voids after a week', () => {
  const p = D.pruneSent({ a: '2026-10-01T00:00:00Z', b: '2026-10-13T00:00:00Z', c: 'junk' }, NOW);
  assert.deepEqual(Object.keys(p), ['b']);
  assert.deepEqual(D.readAlertState('{"sent":{"x":"y","n":1},"not_syncing":[1],"seeded":true}'), { not_syncing: {}, sent: { x: 'y' }, seeded: true });
});
await ok('the weekly summary: Monday from 08:00 EAT, once a week, last week against the week before', () => {
  assert.equal(D.decideWeeklySend(false, '2026-10-19', '09:00', null), null, 'off');
  assert.equal(D.decideWeeklySend(true, '2026-10-20', '09:00', null), null, 'Tuesday');
  assert.equal(D.decideWeeklySend(true, '2026-10-19', '07:59', null), null);
  assert.deepEqual(D.decideWeeklySend(true, '2026-10-19', '08:00', '2026-10-12'),
    { stamp: '2026-10-19', thisFrom: '2026-10-12', thisTo: '2026-10-18', prevFrom: '2026-10-05', prevTo: '2026-10-11' });
  assert.equal(D.decideWeeklySend(true, '2026-10-19', '10:00', '2026-10-19'), null, 'already sent');
});

console.log('\nThe emails — every typed name escaped, short specific subjects\n');
await ok('every typed name is escaped (till, cashier, branch, business, reason)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = E.branchOpenTillsEmail({ businessName: `Biz ${evil}`, branchName: `Br ${evil}`, slot: 'evening', currency: 'KES',
    lines: [{ branch: evil, till: evil, cashier: evil, openedAt: '2026-10-14T05:00:00Z', state: 'open', older: true, expectedCash: 10 }] });
  assert.ok(!m.html.includes('<img'), 'raw tag in the HTML'); assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const v = E.bigReversalAlertEmail({ businessName: evil, currency: 'KES', threshold: 5000,
    lines: [{ kind: 'void', orderNumber: evil, branch: evil, cashier: evil, approvedBy: evil, amount: 6000, reason: evil, at: null }] });
  assert.ok(!v.html.includes('<img'));
  const d = E.variancesSection([{ branch: evil, till: evil, cashier: evil, expected: 1, counted: 0, difference: -1, reason: evil }], 'KES')
    + E.voidsRefundsSection([{ kind: 'refund', orderNumber: evil, branch: evil, cashier: evil, amount: 1, reason: evil, at: null }], { voids: 0, voidValue: 0, refunds: 1, refundValue: 1 }, 'KES')
    + E.notSyncingSection([{ branch: evil, till: evil, lastSyncAt: null, hours: 5, refused: false }])
    + E.expensesSection([{ branch: evil, description: evil, category: evil, method: evil, amount: 1 }], 1, 1, 'KES');
  assert.ok(!d.includes('<img'));
  assert.equal(E.subjectSafe('a\r\nBcc: x@y.z'), 'a Bcc: x@y.z', 'a subject cannot be split into headers');
});
await ok('subjects: "⚠ Till \'Front Counter\' has not synced for 5 h — Mama Ngina"', () => {
  assert.equal(E.notSyncingAlertEmail({ businessName: 'Biz', branchName: 'Mama Ngina', till: 'Front Counter', kind: 'stale', hours: 5.4, lastSyncAt: null }).subject,
    '⚠ Till \'Front Counter\' has not synced for 5 h — Mama Ngina');
  assert.equal(E.notSyncingAlertEmail({ businessName: 'Biz', branchName: 'Mama Ngina', till: 'Front Counter', kind: 'refused', hours: null, lastSyncAt: null }).subject,
    '⚠ Till \'Front Counter\' is signed out and cannot sync — Mama Ngina');
  assert.equal(E.hoursLabel(30), '1 d 6 h');
});
await ok('nothing open → "All tills closed and confirmed ✓"; something open → the list, per branch', () => {
  assert.match(E.openTillsSection([], 'KES'), /All tills closed and confirmed/);
  const h = E.openTillsSection([{ branch: 'Kilimani', till: 'T1', cashier: 'Amina', openedAt: '2026-10-12T05:00:00Z', state: 'open', older: true, expectedCash: 3500 }], 'KES');
  assert.match(h, /Tills not closed or confirmed \(1\)/); assert.match(h, /Open since 12 Oct 08:00/); assert.match(h, /KES 3,500\.00/);
});

// ══ the job entry points against the in-memory database ═══════════════════════
console.log('\nBranch managers — always, even with the owner\'s daily report off\n');
await ok('21:05: each branch\'s managers get their branch\'s open / unconfirmed tills (not the owner, not other branches)', async () => {
  reset();
  const s1 = openShift({});
  db.shifts.push(s1, openShift({ id: 's-wait', status: 'closed', closed_at: '2026-10-14T15:00:00Z', declared_methods: { cash: 3000 }, expected_methods: { cash: 3100 }, device_id: null }));
  db.orders.push({ id: 'o-1', business_id: BZ, shift_id: s1.id, status: 'completed' });
  db.payments.push({ id: 'p-1', order_id: 'o-1', method: 'cash', status: 'completed', amount: 1500 });
  db.user_devices.push({ id: 'd1', business_id: BZ, device_id: 'dev-1', terminal_code: 'Front Counter', device_label: 'x', status: 'approved', retired_at: null });
  const n = await J.branchOpenTillsForBusiness(biz, schedule({ enabled: false }), EVENING);
  assert.equal(n, 1); assert.equal(SENT.length, 1);
  assert.deepEqual(to(SENT[0]), ['joshua@biz.test'], 'Mama Ngina\'s manager only: not the owner, not Kilimani\'s, not an inactive one');
  assert.equal(SENT[0].subject, '2 tills not closed or confirmed — Mama Ngina');
  assert.match(SENT[0].html, /Front Counter/); assert.match(SENT[0].html, /Mama Ngina Web Till/);
  assert.match(SENT[0].html, /KES 3,500\.00/, 'open drawer: the live expected cash (2,000 float + 1,500 cash sales)');
  assert.match(SENT[0].html, /KES 3,100\.00/, 'closed, not confirmed: the expected cash recorded');
  assert.match(SENT[0].html, /Amina &lt;b&gt;/);
  assert.equal(setting(`branch_open_tills_last_sent:${BR1}`), '2026-10-14:evening');
  assert.equal(setting(`branch_open_tills_last_sent:${BR2}`), '2026-10-14:evening', 'nothing to send at Kilimani: stamped, no email');
});
await ok('once per branch per slot: the next run at 21:20 sends nothing', async () => {
  SENT = [];
  assert.equal(await J.branchOpenTillsForBusiness(biz, schedule(), at('2026-10-14T18:20:00Z')), 0);
  assert.equal(SENT.length, 0);
});
await ok('09:00 next morning: again, for the drawer still open from last night (not the one confirmed overnight)', async () => {
  SENT = [];
  db.shifts.find((s) => s.id === 's-wait').confirmed_at = '2026-10-14T19:00:00Z';
  db.shifts.push(openShift({ id: 's-morning', opened_at: '2026-10-15T04:30:00Z', business_date: '2026-10-15' }));
  await J.branchOpenTillsForBusiness(biz, schedule(), at('2026-10-15T06:05:00Z'));
  assert.equal(SENT.length, 1);
  assert.equal(SENT[0].subject, 'Still not closed this morning: 1 till — Mama Ngina');
  assert.match(SENT[0].html, /Open since 14 Oct 08:00/);
});
await ok('09:00 with everything closed: nothing is sent', async () => {
  reset();
  db.shifts.push(openShift({ id: 's-morning', opened_at: '2026-10-15T04:30:00Z', business_date: '2026-10-15' }));
  await J.branchOpenTillsForBusiness(biz, schedule(), at('2026-10-15T06:05:00Z'));
  assert.equal(SENT.length, 0, 'a till opened this morning is not reported at 09:00');
});
await ok('a failed send is not stamped: the next run tries again', async () => {
  reset(); db.shifts.push(openShift({}));
  MAIL_FAILS = true;
  await J.branchOpenTillsForBusiness(biz, schedule(), EVENING);
  assert.equal(setting(`branch_open_tills_last_sent:${BR1}`), undefined);
  MAIL_FAILS = false;
  await J.branchOpenTillsForBusiness(biz, schedule(), at('2026-10-14T18:20:00Z'));
  assert.equal(SENT.length, 1);
});
await ok('before any slot (08:00 with send_time 21:00): no reads at all', async () => {
  reset(); db.shifts.push(openShift({}));
  FAIL = (t) => (t === 'branches' ? 'should not be read' : null);
  assert.equal(await J.branchOpenTillsForBusiness(biz, schedule(), at('2026-10-14T05:00:00Z')), 0);
});

console.log('\nAlerts as they happen\n');
const voidOrder = (o) => ({ id: `o-${nextId++}`, business_id: BZ, branch_id: BR1, order_number: '1042', status: 'voided', total: 7500,
  void_reason: 'Wrong table <x>', cashier_id: 'u-c1', voided_by: 'u-c1', authorized_by: 'u-m1', voided_at: '2026-10-14T11:00:00Z', created_at: '2026-10-14T10:00:00Z', ...o });
await ok('the first run records what is already there and emails none of it (no flood when A476 arrives)', async () => {
  reset(); db.orders.push(voidOrder({ id: 'old-void' }));
  await J.alertsForBusiness(biz, schedule(), NOW);
  assert.equal(SENT.length, 0);
  const st = D.readAlertState(setting('owner_alerts_state'));
  assert.equal(st.seeded, true); assert.ok(st.sent['void:old-void']);
});
await ok('a big void: one email to the owner and the scheduler\'s addresses, specific subject; once per void', async () => {
  SENT = [];
  db.orders.push(voidOrder({ id: 'v-new' }), voidOrder({ id: 'v-small', total: 4999 }));
  await J.alertsForBusiness(biz, schedule(), NOW);
  assert.equal(SENT.length, 1);
  assert.deepEqual(to(SENT[0]), ['books@biz.test', 'owner@biz.test']);
  assert.equal(SENT[0].subject, '⚠ Void of KES 7,500 on order #1042 — Mama Ngina');
  assert.match(SENT[0].html, /approved by Joshua/); assert.match(SENT[0].html, /Wrong table &lt;x&gt;/);
  SENT = [];
  await J.alertsForBusiness(biz, schedule(), at('2026-10-14T12:15:00Z'));
  assert.equal(SENT.length, 0, 'already alerted');
});
await ok('a big refund (by the amount refunded); switched off → nothing', async () => {
  SENT = [];
  db.orders.push({ id: 'r-1', business_id: BZ, branch_id: BR2, order_number: '77', status: 'completed', total: 9000, refunded_amount: '6000.00',
    refunded_at: '2026-10-14T11:30:00Z', refund_reason: 'cold', refunded_by: 'u-m2', cashier_id: 'u-c1' });
  await J.alertsForBusiness(biz, schedule({ alert_big_void: false }), NOW);
  assert.equal(SENT.length, 0, 'off means off');
  await J.alertsForBusiness(biz, schedule(), NOW);
  assert.equal(SENT.length, 1); assert.equal(SENT[0].subject, '⚠ Refund of KES 6,000 on order #77 — Kilimani');
});
await ok('a till not syncing: the owner, the addresses and that branch\'s managers; once per incident; again after recovering', async () => {
  reset();
  db.business_settings.push({ id: 'st', business_id: BZ, key: 'owner_alerts_state', value: { seeded: true, sent: {}, not_syncing: {} } });
  db.shifts.push(openShift({}));
  db.user_devices.push({ id: 'd1', business_id: BZ, device_id: 'dev-1', branch_id: BR1, terminal_code: 'Front Counter', device_label: null,
    status: 'approved', retired_at: null, last_seen_at: '2026-10-14T06:00:00Z', last_sync_at: '2026-10-14T07:00:00Z', session_lost_at: null });
  await J.alertsForBusiness(biz, schedule(), NOW);
  assert.equal(SENT.length, 1);
  assert.equal(SENT[0].subject, '⚠ Till \'Front Counter\' has not synced for 5 h — Mama Ngina');
  assert.deepEqual(to(SENT[0]), ['books@biz.test', 'joshua@biz.test', 'owner@biz.test']);
  SENT = [];
  await J.alertsForBusiness(biz, schedule(), at('2026-10-14T13:00:00Z'));
  assert.equal(SENT.length, 0, 'the same incident');
  db.user_devices[0].last_sync_at = '2026-10-14T13:10:00Z';
  await J.alertsForBusiness(biz, schedule(), at('2026-10-14T13:15:00Z'));
  assert.equal(D.readAlertState(setting('owner_alerts_state')).not_syncing.d1, undefined, 'recovered: forgotten');
  await J.alertsForBusiness(biz, schedule(), at('2026-10-14T18:00:00Z'));
  assert.equal(SENT.length, 1, 'a new incident after recovering');
});
await ok('the threshold is the owner\'s: 6 h → not yet at 5 h; switched off → nothing', async () => {
  reset();
  db.business_settings.push({ id: 'st', business_id: BZ, key: 'owner_alerts_state', value: { seeded: true, sent: {}, not_syncing: {} } });
  db.shifts.push(openShift({}));
  db.user_devices.push({ id: 'd1', business_id: BZ, device_id: 'dev-1', branch_id: BR1, terminal_code: 'Front Counter', status: 'approved',
    retired_at: null, last_seen_at: '2026-10-14T06:00:00Z', last_sync_at: '2026-10-14T07:00:00Z', session_lost_at: null });
  await J.alertsForBusiness(biz, schedule({ not_syncing_hours: 6 }), NOW);
  await J.alertsForBusiness(biz, schedule({ alert_not_syncing: false }), NOW);
  assert.equal(SENT.length, 0);
});
await ok('a big cash difference at confirm: once per shift, specific subject', async () => {
  reset();
  db.business_settings.push({ id: 'st', business_id: BZ, key: 'owner_alerts_state', value: { seeded: true, sent: {}, not_syncing: {} } });
  db.shifts.push(openShift({ id: 'sv', status: 'closed', confirmed_at: '2026-10-14T11:00:00Z', confirmed_by: 'u-m1', declared_methods: { cash: 8800 },
    expected_methods: { cash: 10000 }, confirmed_methods: { cash: 8800 }, confirm_reasons: { cash: 'short <change>' } }),
  openShift({ id: 'sv2', status: 'closed', confirmed_at: '2026-10-14T11:00:00Z', declared_methods: { cash: 1 }, expected_methods: { cash: 1000 }, confirmed_methods: { cash: 500 } }));
  await J.alertsForBusiness(biz, schedule(), NOW);
  assert.equal(SENT.length, 1);
  assert.equal(SENT[0].subject, '⚠ Cash short KES 1,200 on Amina <b>\'s shift — Mama Ngina');
  assert.match(SENT[0].html, /short &lt;change&gt;/); assert.match(SENT[0].html, /Confirmed by Joshua/);
  SENT = [];
  await J.alertsForBusiness(biz, schedule(), at('2026-10-14T12:15:00Z'));
  assert.equal(SENT.length, 0);
});

console.log('\nThe weekly summary\n');
await ok('Monday 08:05 EAT with it on: last week against the week before, once; off → nothing', async () => {
  reset();
  const MON = at('2026-10-19T05:05:00Z');
  db.orders.push(
    { id: 'w1', business_id: BZ, status: 'completed', total: '1000.00', created_at: '2026-10-13T09:00:00Z' },
    { id: 'w2', business_id: BZ, status: 'completed', total: '3000.00', created_at: '2026-10-17T09:00:00Z' },
    { id: 'w0', business_id: BZ, status: 'completed', total: '2000.00', created_at: '2026-10-07T09:00:00Z' },
    { id: 'wv', business_id: BZ, status: 'voided', total: '500.00', created_at: '2026-10-15T09:00:00Z' });
  db.order_items.push({ order_id: 'w1', product_name: 'Chips <large>', quantity: '2.00', subtotal: '1000.00' }, { order_id: 'w2', product_name: 'Chai', quantity: '10.00', subtotal: '3000.00' });
  db.expenses.push({ id: 'e1', business_id: BZ, expense_date: '2026-10-14', amount: '400.00' });
  assert.equal(await J.weeklyForBusiness(biz, schedule(), MON), false, 'off by default');
  assert.equal(await J.weeklyForBusiness(biz, schedule({ weekly_summary: true }), MON), true);
  assert.equal(SENT.length, 1);
  assert.equal(SENT[0].subject, '📈 Weekly summary — Mama Ngina Foods · 2026-10-12 to 2026-10-18');
  assert.match(SENT[0].html, /KES 4,000\.00/); assert.match(SENT[0].html, /\+100%/); assert.match(SENT[0].html, /Chips &lt;large&gt;/);
  assert.equal(await J.weeklyForBusiness(biz, schedule({ weekly_summary: true }), at('2026-10-19T09:00:00Z')), false, 'once a week');
  assert.equal(SENT.length, 1);
});

console.log('\nThe daily email\'s new sections\n');
await ok('open tills, cash differences, voids and refunds, tills not syncing, expenses — and the switches turn them off', async () => {
  reset();
  const now = new Date();
  const today = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  db.business_settings.push({ id: 'rs', business_id: BZ, key: 'report_schedule', value: JSON.stringify(schedule({ enabled: true, send_time: '00:00' })) });
  db.shifts.push(openShift({ id: 'dopen', opened_at: '2026-10-01T05:00:00Z', business_date: '2026-10-01' }),
    openShift({ id: 'dconf', status: 'closed', confirmed_at: iso(60_000), declared_methods: { cash: 1 }, expected_methods: { cash: 5000 }, confirmed_methods: { cash: 4700 } }));
  db.orders.push({ id: 'dv', business_id: BZ, branch_id: BR1, order_number: 'V9', status: 'voided', total: 800, void_reason: 'spilt', cashier_id: 'u-c1', created_at: iso(60_000), voided_at: iso(60_000) });
  db.user_devices.push({ id: 'd1', business_id: BZ, device_id: 'dev-1', branch_id: BR1, terminal_code: 'Back Bar', status: 'approved', retired_at: null,
    last_seen_at: iso(60_000), last_sync_at: iso(30 * 3_600_000), session_lost_at: null });
  db.expenses.push({ id: 'ex', business_id: BZ, branch_id: BR1, expense_date: today, description: 'Gas <refill>', amount: '2500.00', payment_method: 'cash', expense_categories: { name: 'Fuel' } });
  await DS.runDailySummary(now);
  assert.equal(SENT.length, 1); const h = SENT[0].html;
  assert.match(h, /Tills not closed or confirmed \(1\)/); assert.match(h, /Open since 1 Oct 08:00/);
  assert.match(h, /Cash differences at confirm/); assert.match(h, /-300\.00/);
  assert.match(h, /Voids and refunds/); assert.match(h, /spilt/);
  assert.match(h, /Tills not syncing \(1\)/); assert.match(h, /Back Bar/);
  assert.match(h, /Expenses — 1 · KES 2,500\.00/); assert.match(h, /Gas &lt;refill&gt;/);
  assert.match(h, /Mama Ngina Foods · Daily Report/);

  reset();
  db.business_settings.push({ id: 'rs', business_id: BZ, key: 'report_schedule', value: JSON.stringify(schedule({ enabled: true, send_time: '00:00',
    open_tills: false, variances: false, voids_refunds: false, tills_not_syncing: false, expenses: false, low_stock: false })) });
  db.shifts.push(openShift({ id: 'dopen', opened_at: '2026-10-01T05:00:00Z', business_date: '2026-10-01' }));
  db.expenses.push({ id: 'ex', business_id: BZ, branch_id: BR1, expense_date: today, description: 'Gas', amount: '2500.00' });
  await DS.runDailySummary(now);
  assert.equal(SENT.length, 1);
  assert.ok(!/Tills not closed|Expenses —|Inventory Alert|Low Stock/.test(SENT[0].html), 'switched off: not in the email');

  reset();
  db.business_settings.push({ id: 'rs', business_id: BZ, key: 'report_schedule', value: JSON.stringify(schedule({ enabled: true, send_time: '00:00' })) });
  await DS.runDailySummary(now);
  assert.match(SENT[0].html, /All tills closed and confirmed/);
  assert.ok(!/Cash differences|Voids and refunds|Tills not syncing|Expenses —/.test(SENT[0].html), 'a section with nothing to say is left out');
});

console.log('\nOne business failing never stops the others\n');
await ok('the tick: business A\'s reads fail, business B still gets its email', async () => {
  reset();
  db.businesses = [{ ...biz }, { id: BZ2, name: 'Second', owner_id: OWNER2, currency: 'KES' }];
  db.branches.push({ id: 'br-x', business_id: BZ2, name: 'Second Main' });
  db.users.push({ id: 'u-x', business_id: BZ2, name: 'Xavier', email: 'x@second.test', status: 'active', roles: { name: 'manager', role_permissions: [{ permissions: { key: 'reports.overview' } }] }, user_branches: [] });
  db.shifts.push(openShift({}), openShift({ business_id: BZ2, branch_id: 'br-x' }));
  FAIL = (t, eqs) => (eqs.business_id === BZ && (t === 'branches' || t === 'shifts') ? 'boom' : null);
  await J.runOwnerAlertsTick(EVENING);
  const branchMails = SENT.filter((m) => /not closed/.test(m.subject));
  assert.equal(branchMails.length, 1); assert.deepEqual(to(branchMails[0]), ['x@second.test'], 'a manager with no branch assignment works every branch');
});

console.log('\nWho may change it — the settings route\n');
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const token = (userId, keys, extra = {}) => jwt.sign({ userId, businessId: BZ, branchId: BR1, isOwner: false, permissionKeys: keys,
  permissionsVersion: 1, sessionId: 's-' + userId, surface: 'web', tokenType: 'access', ...extra }, process.env.JWT_SECRET, { expiresIn: '15m' });
const call = async (t, method, p, body) => {
  const r = await fetch(`${baseUrl}/api/business${p}`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
try {
  await ok('settings.manage saves it cleaned; receipt.manage alone may not; the job\'s own keys are never written', async () => {
    reset();
    db.users.push({ id: 'u-mgr', business_id: BZ, status: 'active', permissions_version: 1 }, { id: 'u-rcpt', business_id: BZ, status: 'active', permissions_version: 1 });
    const mgr = token('u-mgr', ['settings.manage']);
    const r = await call(mgr, 'POST', '/settings', { key: 'report_schedule', value: JSON.stringify({ enabled: true, send_time: '20:30', recipients: ['a@b.co'], big_void_amount: '2500', alert_variance: false, junk: 1 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = JSON.parse(setting('report_schedule'));
    assert.equal(stored.big_void_amount, 2500); assert.equal(stored.alert_variance, false); assert.equal(stored.open_tills, true); assert.ok(!('junk' in stored));
    const g = await call(mgr, 'GET', '/settings/report-schedule');
    assert.equal(g.body.send_time, '20:30'); assert.equal(g.body.weekly_summary, false); assert.equal(g.body.variance_amount, 1000);
    assert.equal((await call(token('u-rcpt', ['receipt.manage']), 'POST', '/settings', { key: 'report_schedule', value: '{}' })).status, 403);
    assert.equal((await call(mgr, 'POST', '/settings', { key: 'owner_alerts_state', value: '{}' })).status, 403);
    assert.equal((await call(mgr, 'POST', '/settings', { key: `branch_open_tills_last_sent:${BR1}`, value: '"x"' })).status, 403);
  });
  await ok('a schedule saved before A476 reads back with every default', async () => {
    reset();
    db.users.push({ id: 'u-mgr', business_id: BZ, status: 'active', permissions_version: 1 });
    db.business_settings.push({ id: 'rs', business_id: BZ, key: 'report_schedule', value: '{"enabled":true,"send_time":"21:00","recipients":[],"include_low_stock":false}' });
    const g = await call(token('u-mgr', ['settings.manage']), 'GET', '/settings/report-schedule');
    assert.equal(g.body.enabled, true); assert.equal(g.body.low_stock, false); assert.equal(g.body.alert_big_void, true); assert.equal(g.body.big_void_amount, 5000);
  });
} finally { server.closeAllConnections?.(); server.close(); }

console.log('\nWired in\n');
await ok('the job runs every 15 min from the server; the page has the three sections in teal', () => {
  assert.match(read('apps/server/src/index.ts'), /startOwnerAlertsJob\(\);/);
  const page = read('apps/dashboard/src/pages/settings/ReportSchedulerTab.tsx');
  for (const t of ['What the daily email includes', 'Alerts as they happen', 'Weekly summary', 'Branch managers always hear about tills not closed']) assert.ok(page.includes(t), t);
  assert.match(page, /bg-swift-strong/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;   // not process.exit(): on Windows it can abort while the test server's handles close
