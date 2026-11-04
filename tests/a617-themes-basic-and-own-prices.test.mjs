/**
 * a617-themes-basic-and-own-prices.test.mjs — A617 (owner, 2026-11-01): current clients keep Themes, free; a branch's own
 * prices for an add-on or the package; ZapTill's default look and the Ocean, Teal and Sky themes free to everyone, the
 * rest premium. (docs/A617-themes-basic-and-own-prices.md; migration 185 has its own test, scripts/test-migration-185.mjs)
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/a617-themes-basic-and-own-prices.test.mjs
 *
 * RUNS the COMPILED cloud: lib/branchBilling.ts (own prices, the bill), the billing job (jobs/cloudPlanReminders.ts) and
 * routes/cloudPlanAdmin.ts (a branch's own prices saved, checked, and saved without them on a database before 185) on the
 * in-memory database (tests/lib-memdb.mjs); lib/themeRules.ts and @zaptill/core/customerScreen (the free-theme gates). Pins
 * the Branding page, the admin card and the POS's plumbing (themesPremium) from source.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - branchBill back to prices[k] (no own price)          → "a branch's bill at its own prices" fails
 *   - mergeOwnPrices accepting unknown keys                → "own prices checked" fails
 *   - gateDisplayContent ignoring themesPremium            → "the customer screen's logo and colours need Themes" fails
 *   - effectiveThemeId(false, …) back to null              → "a free theme is served without Themes" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/branchBilling.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.ADMIN_ALERT_EMAIL = 'billing@zaptill.test';
delete process.env.TELEGRAM_BOT_TOKEN;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const BB = require(path.join(DIST, 'lib/branchBilling.js'));
const EM = require(path.join(DIST, 'lib/cloudPlanEmail.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const JOB = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const TR = require(path.join(DIST, 'lib/themeRules.js'));
const CS = require('@zaptill/core/customerScreen');
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
console.warn = () => {}; console.error = () => {};
const mem = installMemDb(supabase);

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const u = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPER = u(1), AGENT = u(2), M = u(10), B1 = u(11), B2 = u(12);
const LONG_AGO = '2026-01-01T00:00:00Z';
const row = (branch_id, paid_until, extra = {}) => ({ branch_id, business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null,
  paid_until, billing_from: null, web_off: false, premium: [], package: false, notes: null, created_at: LONG_AGO, ...extra });
const reset = (now = Date.now()) => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [{ id: M, name: 'Duka Bora', owner_id: 'x', email: 'owner@duka.test', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now + 20 * DAY), created_at: LONG_AGO }],
    branches: [
      { id: B1, business_id: M, name: 'Westlands', is_main: true, status: 'active', created_at: '2026-01-01' },
      { id: B2, business_id: M, name: 'CBD', is_main: false, status: 'active', created_at: '2026-01-02' },
    ],
    cloud_plans: [{ business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: null, created_at: LONG_AGO, billing_from: null }],
    // Westlands: a current client's branch, grandfathered by migration 185 (Themes at its own price 0) and Analytics at 7,500;
    // CBD: the package at its own 12,000. Both due an hour ago.
    branch_cloud_plans: [
      row(B1, iso(now - 3600_000), { premium: ['analytics', 'themes'], own_prices: { themes: 0, analytics: 7500 } }),
      row(B2, iso(now - 3600_000), { package: true, own_prices: { package: 12000 } }),
    ],
    business_settings: [], feature_flags: [{ business_id: M, key: 'web_hosting', enabled: true }, { business_id: M, key: 'themes', enabled: true }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], admin_notifications: [], admin_settings: [], users: [],
  };
  adminAuth.forgetAdmin(); CP.forgetStanding(); BB.forgetBillingDetails();
};

console.log('A617 — basic themes for everyone, own prices per branch\n\nA. own prices (pure)\n');
const P = BB.DEFAULT_PRICES;
await ok('a branch\'s own prices as stored: only the four keys, numbers 0 or more; none on a row before migration 185', () => {
  assert.deepEqual(BB.ownPricesOf({ own_prices: { themes: 0, analytics: 7500, images: 5, attendance: -1, package: '9' } }), { themes: 0, analytics: 7500 });
  assert.deepEqual(BB.ownPricesOf({}), {}); assert.deepEqual(BB.ownPricesOf(null), {}); assert.deepEqual(BB.ownPricesOf({ own_prices: [1] }), {});
  assert.deepEqual(BB.OWN_PRICE_KEYS, ['analytics', 'attendance', 'themes', 'package']);
});
await ok('the price that applies: the branch\'s own when set (0 counts), else ZapTill\'s', () => {
  assert.equal(BB.priceFor({ own_prices: { themes: 0 } }, P, 'themes'), 0);
  assert.equal(BB.priceFor({ own_prices: { themes: 0 } }, P, 'analytics'), P.analytics);
  assert.equal(BB.priceFor(null, P, 'package'), P.package);
});
await ok('a branch\'s bill at its own prices: each add-on and the package, × the period\'s months', () => {
  const w = BB.branchBill({ amount: 9000, premium: ['analytics', 'attendance', 'themes'], package: false, period: '3_months', own_prices: { themes: 0, analytics: 7500 } }, 'W', P, 3);
  assert.equal(w.cloud, 9000);
  assert.deepEqual(w.premium, [{ name: 'Analytics', price: 22500 }, { name: 'Attendance', price: P.attendance * 3 }, { name: 'Themes', price: 0 }]);
  assert.deepEqual(BB.branchBill({ amount: 3000, premium: [], package: true, period: 'monthly', own_prices: { package: 12000 } }, 'C', P, 1),
    { branch: 'C', cloud: 0, package: 12000, period: 'monthly' });
});
await ok('the invoice shows the price that applied: an own price is its own line beside ZapTill\'s', () => {
  const own = BB.branchBill({ amount: 3000, premium: ['themes'], package: false, period: 'monthly', own_prices: { themes: 0 } }, 'A', P, 1);
  const std = BB.branchBill({ amount: 3000, premium: ['themes'], package: false, period: 'monthly' }, 'B', P, 1);
  const items = EM.invoiceItems([own, std]);
  assert.deepEqual(items.map((i) => [i.description, i.qty, i.unitPrice]), [['Cloud', 2, 3000], ['Themes', 1, 0], ['Themes', 1, P.themes]]);
});
await ok('own prices checked and merged: a key set, another cleared (null or blank), the rest kept; nothing left → null', () => {
  const m = BB.mergeOwnPrices({ analytics: '7,500', themes: null, package: '' }, { themes: 0, attendance: 1500, package: 12000 });
  assert.deepEqual(m, { ok: true, value: { attendance: 1500, analytics: 7500 } });
  assert.deepEqual(BB.mergeOwnPrices({ themes: 12.345 }, {}), { ok: true, value: { themes: 12.35 } });
  assert.deepEqual(BB.mergeOwnPrices({ themes: null }, { themes: 0 }), { ok: true, value: null });
  assert.deepEqual(BB.mergeOwnPrices(null, { themes: 0 }), { ok: true, value: null });
  for (const bad of [{ images: 1 }, { themes: -1 }, { themes: 'free' }, { themes: true }, { themes: 1e9 }, [1], 'x', 5]) {
    assert.equal(BB.mergeOwnPrices(bad, {}).ok, false, JSON.stringify(bad));
  }
});

console.log('\nB. the billing job and the admin portal\n');
reset();
await ok('the billing job bills each branch at its own prices (Westlands: Cloud 3,000 + Analytics 7,500 + Themes 0; CBD: package 12,000)', async () => {
  await JOB.runCloudBilling(new Date(), { force: true });
  const inv = mem.db.invoices;
  assert.equal(inv.length, 1);
  assert.equal(Number(inv[0].amount), 22500);
  assert.deepEqual(inv[0].lines.items.map((i) => [i.description, i.unitPrice]), [['Premium package', 12000], ['Cloud', 3000], ['Analytics', 7500], ['Themes', 0]]);
});

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const plan = (b) => mem.db.branch_cloud_plans.find((p) => p.branch_id === b);
const put = (b, body, token = ADMIN) => call('PUT', `/api/admin/clients/${M}/cloud-plan/branches/${b}`, token, body);

try {
  await ok('the Plan & billing view: each branch\'s own prices ({} = ZapTill\'s) and its period at them', async () => {
    reset();
    const r = await call('GET', `/api/admin/clients/${M}/cloud-plan`, AGENT_T);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.branches.map((b) => [b.name, b]));
    assert.deepEqual(by.Westlands.own_prices, { themes: 0, analytics: 7500 }); assert.equal(by.Westlands.period_total, 10500);
    assert.deepEqual(by.CBD.own_prices, { package: 12000 }); assert.equal(by.CBD.period_total, 12000);
  });
  await ok('own prices saved: merged onto the branch\'s (a key set, one cleared, the rest kept), audited', async () => {
    reset();
    const r = await put(B1, { own_prices: { attendance: 1500, analytics: null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plan(B1).own_prices, { themes: 0, attendance: 1500 });
    assert.deepEqual(r.body.branches.find((b) => b.branch_id === B1).own_prices, { themes: 0, attendance: 1500 });
    assert.deepEqual(mem.db.admin_audit_log.slice(-1)[0].after_data.own_prices, { themes: 0, attendance: 1500 });
    assert.equal((await put(B2, { own_prices: null })).status, 200); assert.equal(plan(B2).own_prices, null, 'null clears them all');
  });
  await ok('a save without own_prices never names the column (and keeps the branch\'s)', async () => {
    reset();
    mem.calls = [];
    assert.equal((await put(B1, { web_off: false })).status, 200);
    assert.deepEqual(plan(B1).own_prices, { themes: 0, analytics: 7500 });
    const upserts = mem.calls.filter((c) => c.table === 'branch_cloud_plans' && (c.op === 'upsert' || c.op === 'insert'));
    assert.ok(upserts.length > 0 && upserts.every((c) => !('own_prices' in (c.payload ?? {}))), JSON.stringify(upserts.map((c) => c.payload)));
  });
  await ok('own prices checked: an unknown key, a negative or a word → 400 BAD_OWN_PRICE, nothing saved; an agent may not', async () => {
    reset();
    for (const own_prices of [{ images: 1 }, { themes: -5 }, { package: 'free' }, [0]]) {
      const r = await put(B1, { own_prices });
      assert.deepEqual([r.status, r.body?.code], [400, 'BAD_OWN_PRICE'], JSON.stringify(own_prices));
    }
    assert.deepEqual(plan(B1).own_prices, { themes: 0, analytics: 7500 });
    assert.equal((await put(B1, { own_prices: { themes: 100 } }, AGENT_T)).status, 403);
  });
  await ok('a database before migration 185: the plan saved without the own prices, and the admin told', async () => {
    reset();
    mem.fail = (t, op, _f, payload) => (t === 'branch_cloud_plans' && op === 'upsert' && payload && 'own_prices' in payload
      ? { code: 'PGRST204', message: "Could not find the 'own_prices' column of 'branch_cloud_plans' in the schema cache" } : null);
    const r = await put(B2, { web_off: true, own_prices: { package: 10000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(plan(B2).web_off, true); assert.deepEqual(plan(B2).own_prices, { package: 12000 }, 'unchanged');
    assert.match(r.body.notice, /migration 185/);
  });

  // The free-Themes deal for a current client's NEW branches (owner, 2026-11-01: they "do not pay for now").
  const B3 = u(13);
  const addBranch = () => mem.db.branches.push({ id: B3, business_id: M, name: 'Kilimani', is_main: false, status: 'active', created_at: '2026-11-01' });
  const dealOn = () => mem.db.feature_flags.push({ business_id: M, key: 'themes_free', enabled: true });
  await ok('the deal (pure): Themes at an own price of 0 when on; nothing when off', () => {
    assert.deepEqual(BB.newBranchPremium(true), { premium: ['themes'], own_prices: { themes: 0 } });
    assert.deepEqual(BB.newBranchPremium(false), { premium: [], own_prices: null });
  });
  await ok('a new branch of a client on the deal starts with Themes at 0; the view says the client is on it', async () => {
    reset(); addBranch(); dealOn();
    const r = await put(B3, { period: 'monthly', amount: 3000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([plan(B3).premium, plan(B3).own_prices], [['themes'], { themes: 0 }]);
    assert.equal(r.body.themes_free, true);
  });
  await ok('…a client not on it: no Themes, and the save never names own_prices', async () => {
    reset(); addBranch(); mem.calls = [];
    assert.equal((await put(B3, { period: 'monthly', amount: 3000 })).status, 200);
    assert.deepEqual(plan(B3).premium, []);
    assert.ok(!('own_prices' in plan(B3)) || plan(B3).own_prices == null);
    const r = await call('GET', `/api/admin/clients/${M}/cloud-plan`, ADMIN);
    assert.equal(r.body.themes_free, false);
  });
  await ok('…the admin\'s first save wins over the deal (premium and own prices sent)', async () => {
    reset(); addBranch(); dealOn();
    assert.equal((await put(B3, { period: 'monthly', amount: 3000, premium: ['analytics'], own_prices: { analytics: 5000 } })).status, 200);
    assert.deepEqual([plan(B3).premium, plan(B3).own_prices], [['analytics'], { themes: 0, analytics: 5000 }]);
  });
  await ok('…an existing branch is never changed by the deal (only rows the server makes)', async () => {
    reset(); dealOn();
    mem.db.branch_cloud_plans[0].premium = ['analytics']; mem.db.branch_cloud_plans[0].own_prices = null;
    assert.equal((await put(B1, { web_off: false })).status, 200);
    assert.deepEqual([plan(B1).premium, plan(B1).own_prices], [['analytics'], null]);
  });
  await ok('"Bill per branch" later: every branch of a client on the deal starts with Themes at 0', async () => {
    reset(); dealOn(); mem.db.branch_cloud_plans = [];
    const r = await call('POST', `/api/admin/clients/${M}/cloud-plan/branches/start`, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const b of [B1, B2]) assert.deepEqual([plan(b).premium, plan(b).own_prices], [['themes'], { themes: 0 }], b);
  });
  await ok('a branch added by ZapTill (admin) to a client billed per branch takes the deal too; ending it is a super admin\'s', () => {
    const admin = read('apps/server/src/routes/admin.ts');
    assert.match(admin, /const start = newBranchPremium\(await themesFreeFor\(businessId\)\);[^\n]*\n\s*const bp = await supabase\.from\('branch_cloud_plans'\)\.insert\(\{[\s\S]{0,500}premium: start\.premium, \.\.\.\(start\.own_prices \? \{ own_prices: start\.own_prices \} : \{\}\),/);
    assert.match(admin, /const PAID_FEATURES = new Set\(\['web_hosting', CLOUD_BACKUP_FLAG, DESKTOP_UPDATES_FLAG, THEMES_FREE_FLAG\]\);/);
    const card = read('apps/admin/src/BranchBillingCard.tsx');
    assert.match(card, /req\("PATCH", `\/clients\/\$\{clientId\}\/features\/themes_free`, \{ enabled: false/);
    assert.match(card, /\{isSuper && <button data-testid="themes-free-end"/);
  });
} finally { server.close(); }

console.log('\nC. basic themes for everyone, the rest premium\n');
await ok('one list: Ocean, Teal and Sky free — in the shared registry, used by the cloud\'s rules', () => {
  assert.deepEqual([...TR.FREE_THEME_IDS], ['ocean', 'teal', 'sky']);
  assert.match(read('packages/core/src/themes.ts'), /export const FREE_THEME_IDS: readonly ThemeId\[\] = \['ocean', 'teal', 'sky'\];/);
  assert.match(read('apps/server/src/lib/themeRules.ts'), /import \{ isThemeId, isFreeThemeId,/);
});
await ok('a free theme is served without Themes, a premium one never; with Themes, any (nothing chosen → Ocean)', () => {
  for (const t of ['ocean', 'teal', 'sky']) assert.equal(TR.effectiveThemeId(false, t), t);
  for (const t of ['violet', 'lagoon', 'orchid', 'blossom', null, 'emerald']) assert.equal(TR.effectiveThemeId(false, t), null, String(t));
  assert.equal(TR.effectiveThemeId(true, 'violet'), 'violet'); assert.equal(TR.effectiveThemeId(true, null), 'ocean');
});
await ok('choosing: a free theme without Themes; a premium one refused without it', () => {
  for (const t of ['ocean', 'teal', 'sky']) assert.equal(TR.themeWriteError(t, false), null);
  for (const t of ['violet', 'lagoon', 'orchid', 'blossom']) assert.match(TR.themeWriteError(t, false), /part of Themes/);
  assert.equal(TR.themeWriteError('blossom', true), null);
});
await ok('the customer screen\'s logo and colours need Themes (themesPremium); a free theme alone gives none; an older cloud as before', () => {
  const base = { businessName: 'Duka', logo: null, primaryHex: '#e11d48', secondaryHex: null, accentHex: '#0d9488', licensed: false, slides: null, mpesa: null };
  assert.equal(CS.gateDisplayContent({ ...base, themeId: 'teal', themesPremium: false }).brand, null);
  assert.equal(CS.gateDisplayContent({ ...base, themeId: 'teal', themesPremium: true }).brand.themeId, 'teal');
  assert.equal(CS.gateDisplayContent({ ...base, themeId: 'violet' }).brand.themeId, 'violet', 'not told (an older cloud): the theme id decides');
  assert.equal(CS.gateDisplayContent({ ...base, themeId: 'violet', themesPremium: null }).brand.themeId, 'violet');
  assert.equal(CS.gateDisplayContent({ ...base, themeId: null, themesPremium: true }).brand, null);
});
await ok('the POS is told themesPremium: pulled and kept on the desktop (and relayed by a branch server), the web POS too', () => {
  const se = read('apps/desktop/src/main/syncEngine.ts');
  assert.match(se, /setThemesPremium\(c\.themesPremium\);/);
  assert.match(se, /themesPremium: typeof _j\.themesPremium === 'boolean' \? _j\.themesPremium : undefined,/);
  assert.match(read('apps/desktop/src/main/deviceConfig.ts'), /export function getThemesPremium\(\): boolean \| null \{/);
  assert.match(read('apps/desktop/src/main/customerDisplayWire.ts'), /themesPremium: getThemesPremium\(\),/);
  const rb = read('apps/desktop/src/main/referenceBundle.ts');
  assert.match(rb, /themesPremium: rows\.config\.themesPremium \?\? null,/);
  assert.match(rb, /themesPremium: typeof pi\.themesPremium === 'boolean' \? pi\.themesPremium : undefined,/);
  assert.match(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts'), /themesPremium: init\.themesPremium,/);
});
await ok('the dashboard wears a free theme without Themes (never the brand colours); the Branding page locks the rest "Premium"', () => {
  assert.match(read('apps/dashboard/src/lib/themeVars.ts'), /if \(b\.themes_enabled !== true\) return isFreeThemeId\(b\.theme_id\) \? themeVars\(b\.theme_id\) : null;/);
  const tab = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
  assert.match(tab, /const locked = !themesEnabled && !isFreeThemeId\(t\.id\);/);
  assert.match(tab, /\{locked && <span[^>]*>Premium<\/span>\}/);
});
await ok('the admin card: an own price per add-on and the package (blank = ZapTill\'s, the placeholder); "own price" in the table', () => {
  const card = read('apps/admin/src/BranchBillingCard.tsx');
  assert.match(card, /const OWN_PRICES: Array<\[OwnKey, string\]> = \[\["analytics", "Analytics"\], \["attendance", "Attendance"\], \["themes", "Themes"\], \["package", "Premium package"\]\];/);
  assert.match(card, /placeholder=\{String\(view\.prices\[k\]\)\}/);
  assert.match(card, /own_prices: ownToSend\(edit\.own,/);
  assert.match(card, />own price<\/span>\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
