/**
 * branch-cloud-a612.test.mjs — A612 phase 1: the cloud billed per branch; an unpaid branch cut off completely.
 *
 * Owner, 2026-10-30: "monthly subscription should be per branch for premium services or web — if a branch does not pay it
 * should not view its data and the owner should not see it too, it cuts across all users" · "if a branch has not paid
 * it's cut off completely, nothing syncs" · "even price change online should not sync". (docs/A612-per-branch-cloud.md)
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/branch-cloud-a612.test.mjs
 *
 * RUNS the COMPILED server: lib/cloudPlan.ts branchPause (pure) and its gates (accessRefusal, enrolRefusal) on the
 * in-memory database (tests/lib-memdb.mjs); lib/branchPauseScope.ts scopeForPause (pure); middleware/rbac.ts branchScope /
 * assertBranchAccess with a fake request. Pins the wiring in middleware/auth.ts, routes/branches.ts and the dashboard.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - branchFactsFor without the row's paid_until (the business's date)   → "a lapsed branch is paused" fails
 *   - accessRefusal's A612 block only for writes (lapseGateApplies)       → "a paused branch's POS reads nothing" fails
 *   - branchScope without the pausedBranches guard                        → "?branch_id= naming a paused branch" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/branchPauseScope.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.A591_MEMO;
delete process.env.DESKTOP_ONLY_CUTOFF_AT;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const PS = require(path.join(DIST, 'lib/branchPauseScope.js'));
const RB = require(path.join(DIST, 'middleware/rbac.js'));
const WA = require(path.join(DIST, 'lib/writeActivity.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
console.warn = () => {};

let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const B = '11111111-1111-4111-8111-111111111111';
const PAID = 'aaaaaaaa-0000-4000-8000-000000000001', LAPSED = 'aaaaaaaa-0000-4000-8000-000000000002',
  OFF = 'aaaaaaaa-0000-4000-8000-000000000003', NOROW = 'aaaaaaaa-0000-4000-8000-000000000004';
const row = (branch_id, paid_until, extra = {}) => ({ branch_id, business_id: B, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null,
  paid_until, billing_from: null, web_off: false, created_at: iso(NOW - 120 * DAY), ...extra });
const facts = (over = {}) => ({
  onPlan: true, planCreatedAt: iso(NOW - 120 * DAY), billingFrom: null, trial: null, expiresAt: iso(NOW + 20 * DAY), webHosting: true,
  branchIds: [PAID, LAPSED], branchPlans: [row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))], ...over,
});

console.log('A612 — the cloud per branch\n\nA. where each branch stands (pure)\n');

await ok('no branch with its own plan: billed as one business (null — nothing below applies)', () => {
  assert.equal(CP.branchPause(facts({ branchPlans: [] }), NOW), null);
  assert.equal(CP.branchPause(facts({ branchIds: [] }), NOW), null);
});
await ok('a lapsed branch is paused (its own paid-until, past its 7 unpaid days); a paid one is open', () => {
  const p = CP.branchPause(facts(), NOW);
  assert.deepEqual([...p.paused], [LAPSED]);
  assert.deepEqual(p.open, [PAID]);
  assert.equal(p.allPaused, false);
  assert.equal(p.standings.get(LAPSED).state, 'locked');
  assert.equal(p.standings.get(PAID).state, 'active');
});
await ok('within its 7 unpaid days a branch is still open (the ladder is A584\'s, per branch)', () => {
  const p = CP.branchPause(facts({ branchPlans: [row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW - 3 * DAY))] }), NOW);
  assert.equal(p.paused.size, 0);
  assert.equal(p.standings.get(LAPSED).state, 'unpaid');
});
await ok('"Disable" for one branch (web_off): paused at once, whatever its date', () => {
  const p = CP.branchPause(facts({ branchIds: [PAID, OFF], branchPlans: [row(PAID, iso(NOW + 20 * DAY)), row(OFF, iso(NOW + 300 * DAY), { web_off: true })] }), NOW);
  assert.deepEqual([...p.paused], [OFF]);
});
await ok('a branch with no row follows its business (paid business: open; locked business: paused)', () => {
  const ids = [PAID, NOROW];
  assert.equal(CP.branchPause(facts({ branchIds: ids }), NOW).paused.has(NOROW), false);
  assert.equal(CP.branchPause(facts({ branchIds: ids, expiresAt: iso(NOW - 40 * DAY) }), NOW).paused.has(NOROW), true);
});
await ok('every branch paused: allPaused (the whole web paused)', () => {
  const p = CP.branchPause(facts({ branchPlans: [row(PAID, iso(NOW - 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))] }), NOW);
  assert.equal(p.allPaused, true);
  assert.deepEqual(p.open, []);
});

console.log('\nB. who sees what (pure)\n');
const NB = RB.NO_BRANCH;
const pause = { paused: new Set([LAPSED]), open: [PAID, NOROW] };
const base = { isOwner: false, isTill: false, webPartner: false, allBranches: false, partnerBranches: [], branchSet: null, branchId: null, picked: null, method: 'GET' };
await ok('nothing paused: no change', () => assert.deepEqual(PS.scopeForPause({ ...base, isOwner: true }, { paused: new Set(), open: [PAID] }), {}));
await ok('the owner, no branch picked, a read: the open branches as a set (two or more), the one open branch pinned', () => {
  assert.deepEqual(PS.scopeForPause({ ...base, isOwner: true }, pause), { branchSet: [PAID, NOROW], branchId: NB });
  assert.deepEqual(PS.scopeForPause({ ...base, isOwner: true }, { paused: new Set([LAPSED]), open: [PAID] }), { pinnedBranch: PAID, branchId: PAID });
});
await ok('the owner\'s write with no branch picked stays business-wide (a product, a setting)', () => {
  assert.deepEqual(PS.scopeForPause({ ...base, isOwner: true, method: 'POST' }, pause), {});
});
await ok('the owner picks a paused branch: "picked" (the dashboard drops it); every branch paused: refused', () => {
  assert.equal(PS.scopeForPause({ ...base, isOwner: true, picked: LAPSED }, pause), 'picked');
  assert.equal(PS.scopeForPause({ ...base, isOwner: true, picked: LAPSED }, { paused: new Set([LAPSED]), open: [] }), 'refuse');
  assert.deepEqual(PS.scopeForPause({ ...base, isOwner: true, picked: PAID }, pause), {});
  // the owner's "Open POS" session carries its branch: a paused one is refused, its writes (a sale) too
  assert.equal(PS.scopeForPause({ ...base, isOwner: true, branchId: LAPSED, method: 'POST' }, pause), 'picked');
});
await ok('a manager or cashier of a paused branch: refused; of an open one: as before', () => {
  assert.equal(PS.scopeForPause({ ...base, branchId: LAPSED }, pause), 'refuse');
  assert.deepEqual(PS.scopeForPause({ ...base, branchId: PAID }, pause), {});
});
await ok('a partner of some branches: theirs less the paused; a set of theirs narrowed; nothing left: refused', () => {
  const p = { ...base, webPartner: true, partnerBranches: [PAID, LAPSED, NOROW] };
  assert.deepEqual(PS.scopeForPause({ ...p, branchId: PAID }, pause), { partnerBranches: [PAID, NOROW] });
  assert.equal(PS.scopeForPause({ ...p, branchId: LAPSED }, pause), 'picked');
  assert.deepEqual(PS.scopeForPause({ ...p, branchSet: [PAID, LAPSED, NOROW], branchId: NB }, pause), { partnerBranches: [PAID, NOROW], branchSet: [PAID, NOROW] });
  assert.deepEqual(PS.scopeForPause({ ...p, branchSet: [PAID, LAPSED], branchId: NB }, pause), { partnerBranches: [PAID, NOROW], branchSet: null, branchId: PAID });
  assert.equal(PS.scopeForPause({ ...base, webPartner: true, partnerBranches: [LAPSED], branchId: LAPSED }, pause), 'refuse');
});
await ok('a partner of every branch is narrowed as the owner is', () => {
  const p = { ...base, webPartner: true, allBranches: true, partnerBranches: [PAID, LAPSED, NOROW] };
  assert.deepEqual(PS.scopeForPause(p, pause), { partnerBranches: [PAID, NOROW], branchSet: [PAID, NOROW], branchId: NB });
  assert.equal(PS.scopeForPause({ ...p, branchId: LAPSED }, pause), 'picked');
});

console.log('\nC. the branch rules on a request (rbac)\n');
const req = (over) => ({ isOwner: false, allBranches: false, partnerBranches: [], branchSet: null, branchId: null, headers: {}, query: {}, pausedBranches: null, pinnedBranch: null, ...over });
await ok('the owner narrowed to a set: a read finds the open branches; ?branch_id= one of them: it', () => {
  const r = req({ isOwner: true, branchSet: [PAID, NOROW], branchId: NB, pausedBranches: new Set([LAPSED]) });
  assert.deepEqual(RB.branchFilter(r), { kind: 'set', ids: [PAID, NOROW] });
  assert.equal(RB.branchScope(req({ ...r, query: { branch_id: PAID } })), PAID);
});
await ok('?branch_id= naming a paused branch: nothing (NO_BRANCH), the owner\'s too', () => {
  assert.equal(RB.branchScope(req({ isOwner: true, query: { branch_id: LAPSED }, pausedBranches: new Set([LAPSED]) })), NB);
  assert.equal(RB.branchScope(req({ isOwner: true, query: { branch_id: PAID }, pausedBranches: new Set([LAPSED]) })), PAID);
});
await ok('pinned to the one open branch: every read is that branch', () => {
  const r = req({ isOwner: true, pinnedBranch: PAID, pausedBranches: new Set([LAPSED]) });
  assert.equal(RB.branchScope(r), PAID);
  assert.deepEqual(RB.branchFilter(r), { kind: 'one', id: PAID });
});
await ok('assertBranchAccess: a paused branch is nobody\'s (the owner\'s too); an open one as before', () => {
  const r = req({ isOwner: true, pausedBranches: new Set([LAPSED]) });
  assert.equal(RB.assertBranchAccess(r, LAPSED), false);
  assert.equal(RB.assertBranchAccess(r, PAID), true);
  assert.equal(RB.assertBranchAccess(req({ isOwner: true }), LAPSED), true, 'nothing paused: as before');
});

console.log('\nD. the gates (in-memory database)\n');
const mem = installMemDb(supabase);
const seed = (plans) => {
  WA._resetWrites(); WA._setTracking(true); CP._resetStanding(); CP._setStandingClock(() => NOW);
  mem.db = {
    businesses: [{ id: B, name: 'Krunch & Co', owner_id: 'o1', email: null, status: 'active', web_access_expires_at: iso(NOW + 20 * DAY) }],
    cloud_plans: [{ business_id: B, period: 'monthly', amount: 6000, currency: 'KES', custom_until: null, notes: null, updated_by: null, created_at: iso(NOW - 120 * DAY), billing_from: null }],
    business_settings: [], feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }],
    branches: [{ id: PAID, business_id: B }, { id: LAPSED, business_id: B }],
    branch_cloud_plans: plans,
  };
};
await ok('a paused branch\'s POS reads nothing: a price or menu pull refused (503 CLOUD_SUBSCRIPTION_ENDED), a write too', async () => {
  seed([row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))]);
  for (const [m, p] of [['GET', '/api/pos/init'], ['GET', '/api/changes?since=1'], ['POST', '/api/orders'], ['POST', '/api/sync/push']]) {
    const r = await CP.accessRefusal(B, 'desktop', m, p, LAPSED);
    assert.equal(r?.status, 503, `${m} ${p}`);
    assert.equal(r.body.code, 'CLOUD_SUBSCRIPTION_ENDED');
  }
});
await ok('…but sign-in, the technician, support logs and the update state stay open', async () => {
  for (const p of ['/api/auth/refresh', '/api/tech/status', '/api/support/logs', '/api/desktop-update/state']) {
    assert.equal(await CP.accessRefusal(B, 'desktop', 'POST', p, LAPSED), null, p);
  }
});
await ok('an open branch\'s POS: as before (nothing refused)', async () => {
  assert.equal(await CP.accessRefusal(B, 'desktop', 'GET', '/api/pos/init', PAID), null);
  assert.equal(await CP.accessRefusal(B, 'desktop', 'POST', '/api/orders', PAID), null);
});
await ok('billed per branch: the business\'s own date no longer stops an open branch\'s POS', async () => {
  seed([row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW + 20 * DAY))]);
  mem.db.businesses[0].web_access_expires_at = iso(NOW - 40 * DAY);
  assert.equal(await CP.accessRefusal(B, 'desktop', 'POST', '/api/orders', PAID), null);
});
await ok('the web: open while one branch is (that branch hidden by middleware/auth.ts); every branch paused: 403 paused', async () => {
  seed([row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))]);
  assert.equal(await CP.accessRefusal(B, 'web', 'GET', '/api/orders', null), null);
  seed([row(PAID, iso(NOW - 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))]);
  const r = await CP.accessRefusal(B, 'web', 'GET', '/api/orders', null);
  assert.equal(r?.status, 403);
  assert.equal(r.body.code, 'CLOUD_ACCESS_PAUSED');
});
await ok('a POS joins an open branch only', async () => {
  seed([row(PAID, iso(NOW + 20 * DAY)), row(LAPSED, iso(NOW - 20 * DAY))]);
  assert.equal(await CP.enrolRefusal(B, PAID), null);
  assert.equal((await CP.enrolRefusal(B, LAPSED))?.code, 'CLOUD_SUBSCRIPTION_ENDED');
});
await ok('no branch plans (migration 182 not run, or none yet): every gate as before', async () => {
  seed([]);
  delete mem.db.branch_cloud_plans;
  assert.equal(await CP.branchPauseFor(B), null);
  assert.equal(await CP.accessRefusal(B, 'desktop', 'GET', '/api/pos/init', LAPSED), null);
});
await ok('the branch plans ride the same read set (one query for all the businesses asked, not one each)', async () => {
  seed([row(PAID, iso(NOW + 20 * DAY))]);
  mem.calls.length = 0;
  await CP.branchPauseFor(B);
  await CP.standingFor(B);
  await CP.accessRefusal(B, 'desktop', 'GET', '/api/pos/init', PAID);
  const tables = mem.calls.map((c) => c.table ?? c[0]).filter(Boolean);
  assert.equal(tables.filter((t) => t === 'branch_cloud_plans').length, 1, tables.join(' '));
});

console.log('\nE. wiring\n');
await ok('middleware/auth.ts: the POS\'s own branch to accessRefusal; the web narrowed by branchPauseBlocked; the branch list answers', () => {
  const a = read('apps/server/src/middleware/auth.ts');
  assert.match(a, /accessRefusal\(req\.businessId, req\.surface, req\.method, req\.originalUrl \|\| req\.url \|\| '', ownBranch\)/);
  assert.match(a, /if \(!refusal\) return branchPauseBlocked\(req, res\);/);
  assert.match(a, /const listing = req\.method === 'GET' && /);
  assert.match(a, /res\.status\(403\)\.json\(out === 'refuse' \? BRANCH_PAUSED_BODY : BRANCH_PICKED_PAUSED_BODY\)/);
});
await ok('routes/branches.ts marks a paused branch; the admin\'s enrol code asks for its branch', () => {
  assert.match(read('apps/server/src/routes/branches.ts'), /req\.pausedBranches\?\.has\(b\.id\) \? \{ \.\.\.b, cloud_paused: true \}/);
  assert.match(read('apps/server/src/routes/admin.ts'), /enrolRefusal\(String\(businessId\), String\(branchId\)\)/);
});
await ok('the dashboard: a paused branch never offered; a remembered one replaced; BRANCH_PAUSED the paused screen', () => {
  const bc = read('apps/dashboard/src/context/BranchContext.tsx');
  assert.match(bc, /const data = listed\.filter\(\(b\) => !b\.cloud_paused\);/);
  assert.match(bc, /listed\.some\(\(b\) => b\.id === saved && b\.cloud_paused\)/);
  assert.match(bc, /'zaptill:branch-picked-paused'/);
  const api = read('apps/dashboard/src/lib/api.ts');
  assert.match(api, /json\?\.code === 'BRANCH_PAUSED'\)\) \{\s*window\.dispatchEvent\(new CustomEvent\('zaptill:cloud-paused'/);
  assert.match(api, /json\?\.code === 'BRANCH_PICKED_PAUSED'/);
  assert.match(read('apps/dashboard/src/lib/cloudPaused.ts'), /if \(code === 'BRANCH_PAUSED'\) return \{ title: BRANCH_PAUSED_TITLE/);
});

console.log('\nF. the invoice: one per business, items with unit prices, the branches in the note (phase 3 builds on it)\n');
const EM = require(path.join(DIST, 'lib/cloudPlanEmail.js'));
const BILLS = [
  { branch: 'Westlands', cloud: 3000, premium: [{ name: 'Themes', price: 1000 }, { name: 'Analytics', price: 10000 }] },
  { branch: 'CBD', cloud: 3000 },
  { branch: 'Thika Road', cloud: 3000, premium: [{ name: 'Themes', price: 1000 }] },
];
const inv = (seller = EM.SAMPLE_SELLER) => EM.branchInvoiceEmailHtml({ invoiceNumber: 'ZT-CLD-0042', issuedAt: '2026-11-01T06:00:00Z', currency: 'KES',
  business: { name: 'Krunch & Co', ownerName: 'Jane', phone: '0712 345 678', email: null, code: 'KRUNCH' },
  periodStart: '2026-11-01T00:00:00+03:00', periodEnd: '2026-12-01T00:00:00+03:00', period: 'monthly', branches: BILLS, seller });
await ok('items: the cloud × branches, each premium feature × the branches that have it; another price is its own line', () => {
  const items = EM.invoiceItems(BILLS);
  assert.deepEqual(items.map((i) => [i.description, i.qty, i.unitPrice, i.amount]), [
    ['Cloud', 3, 3000, 9000], ['Themes', 2, 1000, 2000], ['Analytics', 1, 10000, 10000]]);
  assert.equal(items[0].detail, 'Web dashboard · Backup · Remote POS management');
  assert.equal(items[2].detail, EM.PREMIUM_ITEMS.Analytics);
  const odd = EM.invoiceItems([{ branch: 'A', cloud: 3000 }, { branch: 'B', cloud: 2500 }]);
  assert.deepEqual(odd.map((i) => [i.qty, i.unitPrice]), [[1, 3000], [1, 2500]]);
});
await ok('the total of the items, the period once in the header, the owner billed, the branches in the note', () => {
  const m = inv();
  assert.equal(m.total, 21000);
  assert.match(m.subject, /ZT-CLD-0042 — Krunch & Co — KES 21,000/);
  assert.match(m.html, /Period <b style="color:#0f172a;">1 Nov 2026 – 1 Dec 2026<\/b> \(Monthly/);
  assert.doesNotMatch(m.html, />Period<\/th>/, 'no period column');
  assert.match(m.html, />Qty<\/th>[\s\S]*>Unit price<\/th>/);
  assert.match(m.html, /Billed to[\s\S]*Krunch &amp; Co[\s\S]*Jane/);
  assert.match(m.html, /Note — branches billed[\s\S]*<b>Westlands<\/b> — Cloud, Themes, Analytics<br><b>CBD<\/b> — Cloud<br><b>Thika Road<\/b> — Cloud, Themes/);
});
await ok('sample details say so; real ones do not; the Paybill and its account (the invoice, or the business code)', () => {
  assert.match(inv().html, /Sample details/);
  const real = { ...EM.SAMPLE_SELLER, sample: false, mpesaPaybill: '247247', accountRef: 'business' };
  assert.doesNotMatch(inv(real).html, /Sample details/);
  assert.match(inv(real).html, /M-Pesa Paybill<\/b> 247247 &nbsp;·&nbsp; <b>Account<\/b> KRUNCH/);
  assert.match(inv().html, /<b>Account<\/b> ZT-CLD-0042/);
});
await ok('never a word of a lock, a pause or a deadline (A584)', () => {
  assert.doesNotMatch(inv().html, /lock|paus|revok|suspend|deadline|cut off/i);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
