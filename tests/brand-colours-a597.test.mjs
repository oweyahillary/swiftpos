// A597 — brand colours across the web portal and both POS apps: the business OWNER picks a primary and a secondary colour
// (any colour) on Settings › Branding; premium (the business's `themes` flag). The cloud's half, the shared rule, the
// dashboard's theme layer and the web POS.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/brand-colours-a597.test.mjs
//
// Owner, 2026-10-27: "ANY colour — never refuse a colour for legibility. Instead derive readable text (black/white by
// contrast) and lighter/darker shades from any colour, so it works on buttons, links, chips in light AND dark mode." The
// flag off → "everything looks exactly as today (pixel for pixel)". Precedence: a branch's own theme (A544) → the brand
// colours → the curated theme → the ZapTill default.
//
// RUNS the shared rule (shared/themes.ts brandTokens, shared/branchBranding.ts — as the cloud compiled them), the REAL
// dashboard lib/themeVars.ts (bundled with esbuild), and the COMPILED server (routes behind the real requireAuth) over
// HTTP with the database in memory (tests/lib-memdb.mjs). Migration 179 runs for real in scripts/test-migration-179.mjs;
// the till's half in apps/desktop/test/brand-colours-a597.test.mjs.
//
//   S  the shades: white, black, yellow, mid-grey, navy, red — every job reads (4.5 text and labels, 3 fills and charts,
//      fills stand out from the page), the colour itself kept where it already reads; never refused; status advice only.
//   P  precedence: themes off → no colours; a branch's own theme → no colours; otherwise the colours win over the theme.
//   D  the dashboard: themes off → no variables (today's look); no colours → the theme exactly as before; a primary → its
//      shades on action-* AND the back office's swift-* (index.css data-brand); the chrome (logo, band, chart accent).
//   R  the cloud: the owner (themes on) sets any #rrggbb, lower-cased; null clears; a manager, a partner, a POS session
//      403; themes off 403 (a clear still allowed); a bad value 400; a save without the fields leaves them; GET says who
//      may edit; /pos/init serves them only with themes on; a database before migration 179 keeps working.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-28):
//   - themes.ts brandTokens: fill = the colour as chosen (no shadeFor)          → S "dark labels on the fill" fails (black, navy)
//   - themes.ts brandTokens without the BRAND_EDGE step                          → S "a white fill stands out on white" fails
//   - branchBranding.ts resolver without the business-theme gate on the colours  → P "themes off → no colours" fails
//   - branchBranding.ts resolver keeping the colours under a branch theme        → P "a branch's own theme wins" fails
//   - themeVars.ts withBranchTheme keeping primary_hex                           → D "the web POS's branch theme wins" fails
//   - themeVars.ts applyDashboardThemeVars never setting data-brand              → D "data-brand marker" fails
//   - business.ts brand colours without the owner check                          → R "a manager … 403" fails
//   - themeRules.ts brandColourWriteError without the flag                        → R "themes off → 403" fails
//   - pos.ts serving the stored colours with the flag ignored                     → R "/pos/init … themes off → null" fails
//   - themeAccess.ts selectBusinessBranding without the retry                     → R "before migration 179" fails
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/themeRules.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

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
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SC = require(path.join(DIST, 'lib/syncChanges.js'));
// The shared rules as the cloud compiled them (byte-identical to shared/, the POS's and the web's copies).
const T = require(path.join(DIST, 'lib/themes.js'));
const S = require(path.join(DIST, 'lib/branchBranding.js'));
const R = require(path.join(DIST, 'lib/themeRules.js'));
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};

// The REAL dashboard theme layer, bundled.
const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a597-'));
await esbuild.build({ entryPoints: [path.join(ROOT, 'apps/dashboard/src/lib/themeVars.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'themeVars.cjs'), logLevel: 'silent' });
const TV = createRequire(import.meta.url)(path.join(tmp, 'themeVars.cjs'));

const B = '11111111-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MANAGER = 'aaaaaaaa-0000-4000-8000-000000000002', PARTNER = 'aaaaaaaa-0000-4000-8000-000000000004';
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
let missingColumns = false;
const reset = (themes = true, branding = {}) => {
  mem.fail = (table, op, _f, _p, cols) => (missingColumns && table === 'business_branding' && /primary_hex|secondary_hex/.test(String(cols ?? ''))
    ? { message: 'column business_branding.primary_hex does not exist', code: '42703' } : null);
  mem.calls = [];
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); SC._resetSyncChanges();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Test Shop', type: 'retail', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true },
      { id: BR2, business_id: B, name: 'Kilimani', is_main: false, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 0, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      { id: MANAGER, name: 'Njeri', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-m', roles: perms('Manager', 'receipt.manage', 'settings.business'), user_branches: [{ branch_id: BR }], user_permissions: [] },
      { id: PARTNER, name: 'Pam', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-p', roles: perms('Partner', 'settings.business'), user_branches: [], user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER }],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }],
    feature_flags: themes ? [{ business_id: B, key: 'themes', enabled: true }] : [],
    business_branding: [{ business_id: B, accent_hex: null, logo_png: null, logo_receipt: null, receipt_logo_enabled: false, theme_id: 'violet',
      primary_hex: null, secondary_hex: null, ...branding }],
    branch_branding: [],
    categories: [], products: [], branch_prices: [], tables: [], business_settings: [], branch_settings: [], payment_methods: [], offers: [],
    promotions: [], stock_takes: [], variant_groups: [], modifier_groups: [], combo_items: [], menus: [], sync_changes: [],
    sync_change_floor: [{ id: 1, floor_seq: 0 }], change_requests: [], refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TK = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  manager: sign({ userId: MANAGER, permissionKeys: ['receipt.manage', 'settings.business'], surface: 'dashboard' }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const row = () => mem.db.business_branding.find((r) => r.business_id === B);
const EXTREMES = { white: '#ffffff', black: '#000000', yellow: '#ffff00', grey: '#808080', navy: '#000080', red: '#e11d48', teal: '#0d9488' };
const minC = (fg, bgs) => Math.min(...bgs.map((b) => T.contrast(fg, b)));

try {
  state._setPermissionsMigrated(true);

  console.log('\nS. the shades of ANY colour\n');
  await ok('every colour gets tokens — nothing refused (white, black, yellow, mid-grey, navy, red, teal)', async () => {
    for (const [name, hex] of Object.entries(EXTREMES)) assert.ok(T.brandTokens(hex), name);
    assert.equal(T.brandTokens('#FFFF00').base, '#ffff00', 'upper case is the same colour');
    for (const bad of [null, '', 'red', '#fff', '#12345g', 7]) assert.equal(T.brandTokens(bad), null, String(bad));
  });
  await ok('dark labels on the fill and its hover ≥ 4.5 (black, gray-950 and the light-mode slate)', async () => {
    for (const [name, hex] of Object.entries(EXTREMES)) {
      const k = T.brandTokens(hex);
      assert.ok(minC(k.fill, T.BRAND_SURFACES.darkLabels) >= 4.5, `${name} fill ${k.fill}`);
      assert.ok(minC(k.fillHover, T.BRAND_SURFACES.darkLabels) >= 4.5, `${name} hover ${k.fillHover}`);
    }
  });
  await ok('white labels on the strong fill and its hover ≥ 4.5', async () => {
    for (const [name, hex] of Object.entries(EXTREMES)) {
      const k = T.brandTokens(hex);
      assert.ok(T.contrast('#ffffff', k.strong) >= 4.5 && T.contrast('#ffffff', k.strongHover) >= 4.5, `${name} ${k.strong} ${k.strongHover}`);
    }
  });
  await ok('links ≥ 4.5 on the dark screens AND on the light dashboard (and their hovers)', async () => {
    for (const [name, hex] of Object.entries(EXTREMES)) {
      const k = T.brandTokens(hex);
      assert.ok(minC(k.textDark, T.BRAND_SURFACES.darkText) >= 4.5 && minC(k.textDarkHover, T.BRAND_SURFACES.darkText) >= 4.5, `${name} dark`);
      assert.ok(minC(k.textLight, T.BRAND_SURFACES.lightText) >= 4.5 && minC(k.textLightHover, T.BRAND_SURFACES.lightText) >= 4.5, `${name} light`);
    }
  });
  await ok('a fill stands out from the page under it: a white fill on white, a black one on the dark screens (BRAND_EDGE)', async () => {
    const w = T.brandTokens('#ffffff'), k = T.brandTokens('#000000');
    assert.ok(T.contrast(w.fill, '#ffffff') >= T.BRAND_EDGE, `white fill ${w.fill}`);
    assert.ok(minC(k.strong, T.BRAND_SURFACES.darkText) >= T.BRAND_EDGE, `black strong ${k.strong}`);
  });
  await ok('the POS layer (strip, lock screen) is seen on the dark panels (3:1) with its own readable label; charts 3:1 on the card', async () => {
    for (const [name, hex] of Object.entries(EXTREMES)) {
      const k = T.brandTokens(hex);
      assert.ok(minC(k.layer, T.SURFACES.darkPanels) >= 3, `${name} layer ${k.layer}`);
      assert.ok(T.contrast(k.onLayer, k.layer) >= 4.5, `${name} on-layer`);
      assert.ok(T.contrast(k.chartDark, '#111827') >= 3 && T.contrast(k.chartLight, '#ffffff') >= 3, `${name} chart`);
      assert.ok(T.contrast(T.SURFACES.sidebarText, k.tint) >= 7, `${name} tint`);
      assert.ok(T.contrast(k.on, k.base) >= 4.5, `${name} label on the colour itself`);
    }
  });
  await ok('the colour itself is kept wherever it already reads (yellow on the dark screens, navy text on white, red under white labels)', async () => {
    const y = T.brandTokens('#ffff00'), n = T.brandTokens('#000080'), t = T.brandTokens('#0d9488'), r = T.brandTokens('#e11d48');
    assert.equal(y.textDark, '#ffff00'); assert.equal(y.layer, '#ffff00');
    assert.equal(n.textLight, '#000080'); assert.equal(r.strong, '#e11d48');
    assert.equal(t.fill, '#0d9488');
    assert.notEqual(n.strong, '#000080', 'navy is lifted just enough to stand out on the dark screens (BRAND_EDGE)');
  });
  await ok('close to a status colour → advice only (never a refusal)', async () => {
    assert.equal(T.brandNearStatus('#22c55e'), 'paid'); assert.equal(T.brandNearStatus('#e11d48'), 'void');
    assert.equal(T.brandNearStatus('#3b82f6'), null); assert.equal(T.brandNearStatus('nope'), null);
    assert.ok(T.brandTokens('#22c55e'));
  });

  console.log('\nP. precedence\n');
  await ok('themes off (no business theme) → no brand colours, whatever is stored (today\'s look)', async () => {
    const r = S.resolveBranchBranding({ themeId: null, primaryHex: '#e11d48', secondaryHex: '#ffff00' }, null);
    assert.deepEqual([r.primaryHex, r.secondaryHex], [null, null]);
  });
  await ok('themes on → the business\'s colours (cleaned); a branch overriding only its colour or footer keeps them', async () => {
    const r = S.resolveBranchBranding({ themeId: 'violet', primaryHex: '#E11D48', secondaryHex: 'junk' }, null);
    assert.deepEqual([r.themeId, r.primaryHex, r.secondaryHex], ['violet', '#e11d48', null]);
    const c = S.resolveBranchBranding({ themeId: 'violet', primaryHex: '#e11d48' }, { branchId: BR, themeId: null, accentHex: '#f5b800', receiptFooter: 'Karibu' });
    assert.deepEqual([c.primaryHex, c.accentHex], ['#e11d48', '#f5b800']);
  });
  await ok('a branch\'s own theme wins over the business\'s brand colours (A544 overrides still win)', async () => {
    const r = S.resolveBranchBranding({ themeId: 'violet', primaryHex: '#e11d48', secondaryHex: '#ffff00' }, { branchId: BR, themeId: 'teal', accentHex: null, receiptFooter: null });
    assert.deepEqual([r.themeId, r.primaryHex, r.secondaryHex], ['teal', null, null]);
  });

  console.log('\nD. the dashboard (lib/themeVars.ts, index.css)\n');
  await ok('themes off → no variables at all, even with colours stored (pixel for pixel today\'s look)', async () => {
    assert.equal(TV.computeDashboardThemeVars({ themes_enabled: false, theme_id: 'violet', primary_hex: '#e11d48' }), null);
    assert.equal(TV.computeDashboardThemeVars(null), null);
    assert.equal(TV.brandLookFor({ themes_enabled: false, primary_hex: '#e11d48', logo_png: 'data:image/png;base64,AAAA' }), null);
    assert.equal(TV.posBrandStripColours(null, null, '#e11d48', '#ffff00'), null);
  });
  await ok('no brand colours → the curated theme exactly as before (four action variables, no back-office ones)', async () => {
    const v = TV.computeDashboardThemeVars({ themes_enabled: true, theme_id: 'violet' });
    const k = T.themeTokens(T.resolveTheme('violet'));
    const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
    assert.deepEqual(v, { 'action-t-500': ch(k.fillDark), 'action-t-600': ch(k.pressedLight), 'action-d-400': ch(k.textDark), 'action-l-400': ch(k.textLight) });
  });
  await ok('a primary → it wins over the theme: action-* AND the back office\'s bp-* from its shades', async () => {
    const v = TV.computeDashboardThemeVars({ themes_enabled: true, theme_id: 'violet', primary_hex: '#ffff00' });
    const k = T.brandTokens('#ffff00');
    const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
    assert.equal(v['action-t-500'], ch(k.fill)); assert.equal(v['action-t-600'], ch(k.strong));
    assert.equal(v['action-d-400'], ch(k.textDark)); assert.equal(v['action-l-400'], ch(k.textLight));
    assert.equal(v['bp-strong'], ch(k.strong)); assert.equal(v['bp-text-l-hover'], ch(k.textLightHover));
    assert.deepEqual(Object.keys(v).sort(), [...TV.DASHBOARD_THEME_VARS].sort(), 'every variable the layer clears');
  });
  await ok('the web POS\'s branch theme wins over the business\'s colours (withBranchTheme)', async () => {
    const b = { themes_enabled: true, theme_id: 'violet', primary_hex: '#e11d48', secondary_hex: '#ffff00' };
    const v = TV.computeDashboardThemeVars(TV.withBranchTheme(b, 'teal'));
    assert.equal(v['bp-fill'], undefined);
    assert.equal(v['action-t-500'], TV.computeDashboardThemeVars({ themes_enabled: true, theme_id: 'teal' })['action-t-500']);
    assert.equal(TV.withBranchTheme(b, null), b, 'no branch theme → the business as is');
  });
  await ok('data-brand marker: set with the brand shades, removed with a theme or themes off (index.css keys swift-* on it)', async () => {
    const attrs = new Map(), props = new Map();
    const root = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
      setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
    TV.applyDashboardThemeVars(TV.computeDashboardThemeVars({ themes_enabled: true, primary_hex: '#000000' }), root);
    assert.ok(attrs.has('data-brand') && props.get('--bp-fill'));
    TV.applyDashboardThemeVars(TV.computeDashboardThemeVars({ themes_enabled: true, theme_id: 'ocean' }), root);
    assert.ok(!attrs.has('data-brand') && !props.has('--bp-fill') && props.has('--action-t-500'));
    TV.applyDashboardThemeVars(null, root);
    assert.equal(props.size + attrs.size, 0);
  });
  await ok('index.css: swift-* follow the brand only under :root[data-brand] (teal untouched otherwise); the wordmark stays', async () => {
    const css = read('apps/dashboard/src/index.css');
    const block = css.match(/:root\[data-brand\] \{([^}]*)\}/)?.[1] ?? '';
    for (const [tok, v] of [['swift', 'bp-fill'], ['swift-light', 'bp-fill-hover'], ['swift-strong', 'bp-strong'], ['swift-deep', 'bp-strong-hover'], ['swift-text', 'bp-text-d']]) {
      assert.match(block, new RegExp(`--${tok}: var\\(--${v}\\);`), tok);
    }
    assert.ok(!/swift-logo/.test(block));
    assert.match(css, /:root\[data-brand\]:not\(\.dark\) \{ --swift-text: var\(--bp-text-l\); --swift-text-hover: var\(--bp-text-l-hover\); \}/);
    assert.match(css, /:root \{\n  --swift: 20 184 166;/, 'the teal defaults stay as they were');
  });
  await ok('the chrome: logo + colour band + chart accent with themes on; nothing chosen → null (the header as before)', async () => {
    const look = TV.brandLookFor({ themes_enabled: true, primary_hex: '#E11D48', secondary_hex: '#ffff00', logo_png: 'data:image/png;base64,AAAA' });
    assert.deepEqual(look, { logo: 'data:image/png;base64,AAAA', primary: '#e11d48', secondary: '#ffff00' });
    assert.match(TV.brandBand(look), /#e11d48 50%, #ffff00 50%/);
    assert.equal(TV.brandBand({ logo: null, primary: '#e11d48', secondary: null }), '#e11d48');
    assert.equal(TV.brandChartAccent(look, 'light'), T.brandTokens('#ffff00').chartLight, 'the secondary on charts');
    assert.equal(TV.brandChartAccent({ logo: null, primary: '#000000', secondary: null }, 'dark'), T.brandTokens('#000000').chartDark, 'else the primary');
    assert.equal(TV.brandLookFor({ themes_enabled: true }), null);
    assert.equal(TV.brandLookFor({ themes_enabled: true, logo_png: 'data:image/svg+xml;base64,AAAA' }), null, 'only the PNG / JPEG logo');
    const layout = read('apps/dashboard/src/components/DashboardLayout.tsx');
    assert.match(layout, /\{band && <div aria-hidden className="h-1 flex-shrink-0" style=\{\{ background: band \}\} data-testid="dashboard-brand-band" \/>\}/);
    assert.match(layout, /\{look\?\.logo && \(\s*<img src=\{look\.logo\}/);
    assert.match(read('apps/dashboard/src/pages/analytics/AnalyticsPage.tsx'), /brandAccent \? \{ \.\.\.base, accent: brandAccent/);
  });
  await ok('the web POS: its strip shows the accent (else the primary) and the secondary; the POS applies the colours itself', async () => {
    assert.equal(TV.posBrandStripColours('violet', null, '#000080', null), T.brandTokens('#000080').layer, 'navy at its shade seen on the dark screens');
    assert.match(TV.posBrandStripColours('violet', '#f5b800', '#000080', '#ffff00'), /#F5B800 50%, #ffff00 50%/);
    const pos = read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts');
    assert.match(pos, /primaryHex: init\.branding\?\.primaryHex \?\? null/);
    assert.match(pos, /if \(branchThemeId \|\| !posColours\?\.primary\) return;/);
  });

  console.log('\nR. the cloud\n');
  await ok('the owner (themes on) sets any colour — white and black too — stored lower case; GET says the owner may edit', async () => {
    reset();
    let r = await call('PUT', '/api/business/branding', TK.owner, { primary_hex: '#FFFFFF', secondary_hex: '#000000' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([row().primary_hex, row().secondary_hex], ['#ffffff', '#000000']);
    r = await call('GET', '/api/business/branding', TK.owner);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.primary_hex, r.body.secondary_hex, r.body.themes_enabled, r.body.brand_colours_editable], ['#ffffff', '#000000', true, true]);
  });
  await ok('null clears one colour, the other kept', async () => {
    reset(true, { primary_hex: '#e11d48', secondary_hex: '#ffff00' });
    const r = await call('PUT', '/api/business/branding', TK.owner, { secondary_hex: null });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([row().primary_hex, row().secondary_hex], ['#e11d48', null]);
  });
  await ok('a bad value is refused 400 — a name, #rgb, junk (the page widens #rgb itself)', async () => {
    reset();
    for (const bad of ['red', '#fff', '#12345g', 12]) {
      const r = await call('PUT', '/api/business/branding', TK.owner, { primary_hex: bad });
      assert.equal(r.status, 400, `${bad}: ${r.text}`); assert.equal(r.body.code, 'BAD_COLOUR');
    }
    assert.equal(row().primary_hex, null);
  });
  await ok('a manager with the Branding rights → 403 OWNER_ONLY (a clear too); GET says they may not edit', async () => {
    reset(true, { primary_hex: '#e11d48' });
    let r = await call('PUT', '/api/business/branding', TK.manager, { primary_hex: '#000000' });
    assert.equal(r.status, 403, r.text); assert.equal(r.body.code, 'OWNER_ONLY');
    r = await call('PUT', '/api/business/branding', TK.manager, { primary_hex: null });
    assert.equal(r.status, 403, r.text);
    assert.equal(row().primary_hex, '#e11d48');
    r = await call('GET', '/api/business/branding', TK.manager);
    assert.equal(r.body.brand_colours_editable, false);
  });
  await ok('…but their branding save without the colour fields still works and leaves the colours', async () => {
    reset(true, { primary_hex: '#e11d48', secondary_hex: '#ffff00' });
    const r = await call('PUT', '/api/business/branding', TK.manager, { accent_hex: '#0d9488' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([row().accent_hex, row().primary_hex, row().secondary_hex], ['#0d9488', '#e11d48', '#ffff00']);
  });
  await ok('a POS\'s own session → 403 (its logo upload never touches the colours)', async () => {
    reset();
    const r = await call('PUT', '/api/business/branding', TK.till, { primary_hex: '#000000' });
    assert.equal(r.status, 403, r.text);
    assert.equal(row().primary_hex, null);
  });
  await ok('a partner (web dashboard access, not the owner) → refused by the rule', async () => {
    const who = { owner: false, enabled: true };
    assert.equal(R.brandColourWriteError('primary_hex', '#000000', who)?.status, 403);
  });
  await ok('themes off → 403 THEMES_OFF with a clear message; the owner may still clear (null)', async () => {
    reset(false, { primary_hex: '#e11d48' });
    let r = await call('PUT', '/api/business/branding', TK.owner, { primary_hex: '#000000' });
    assert.equal(r.status, 403, r.text); assert.equal(r.body.code, 'THEMES_OFF'); assert.match(r.body.error, /part of Themes/);
    r = await call('PUT', '/api/business/branding', TK.owner, { primary_hex: null });
    assert.equal(r.status, 200, r.text); assert.equal(row().primary_hex, null);
  });
  await ok('/pos/init serves the colours inside branding with themes on, null with themes off (stored, not applied)', async () => {
    reset(true, { primary_hex: '#e11d48', secondary_hex: '#ffff00' });
    let r = await call('GET', `/api/pos/init?branch_id=${BR}`, TK.till);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.branding.primaryHex, r.body.branding.secondaryHex, r.body.themeId], ['#e11d48', '#ffff00', 'violet']);
    reset(false, { primary_hex: '#e11d48', secondary_hex: '#ffff00' });
    r = await call('GET', `/api/pos/init?branch_id=${BR}`, TK.till);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.branding.primaryHex, r.body.branding.secondaryHex, r.body.themeId], [null, null, null]);
  });
  await ok('a database before migration 179: the branding read, the save and /pos/init keep working (no colours)', async () => {
    reset(true, { accent_hex: '#0d9488' });
    missingColumns = true;
    try {
      let r = await call('GET', '/api/business/branding', TK.owner);
      assert.equal(r.status, 200, r.text); assert.equal(r.body.accent_hex, '#0d9488');
      r = await call('PUT', '/api/business/branding', TK.owner, { accent_hex: '#f5b800' });
      assert.equal(r.status, 200, r.text);
      r = await call('GET', `/api/pos/init?branch_id=${BR}`, TK.till);
      assert.equal(r.status, 200, r.text); assert.equal(r.body.branding.accentHex, '#f5b800'); assert.equal(r.body.branding.primaryHex, null);
    } finally { missingColumns = false; }
  });
  await ok('the admin switch says it covers brand colours; no "till" in the new words', async () => {
    assert.match(read('apps/admin/src/AdminPortal.tsx'), /settingRow\("App themes and brand colours",/);
    const tab = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
    const block = tab.slice(tab.indexOf('function BrandColoursField'), tab.indexOf('// A small, honest mock'));
    assert.ok(block.length > 500 && !/\btill/i.test(block.replace(/TillPreview/g, '')));
    assert.match(tab, /\.\.\.\(sendColours \? \{ primary_hex: primaryHex, secondary_hex: secondaryHex \} : \{\}\)/);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
