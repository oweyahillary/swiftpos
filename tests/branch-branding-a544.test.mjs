// A544 — per-branch branding: a branch can override the business's action theme, brand colour and receipt footer
// (client branding Phase 2, the per-branch slice of A323). The cloud's half, the shared rule, and the web's wiring.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/branch-branding-a544.test.mjs
//
// Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding; the
// design approved in docs/SCOPE-A295-branding.md §14–15).
//
// RUNS the COMPILED server (routes/index.js behind the real requireAuth and requireAnyPermission) over HTTP; the database
// in memory (tests/lib-memdb.mjs) — migration 156's SQL (table, FK, RLS, triggers) runs for real in
// scripts/test-migration-156.mjs. The shared rule (shared/branchBranding.ts) is run directly.
//
//   S  the rule: per field branch → business → default; themes off (no business theme) → the override ignored; the
//      write checks (a curated theme, a colour seen on the dark till, a plain-text footer whose lines fit the paper).
//   R  /api/business/branding/branches: the owner lists and changes every branch; a manager (receipt.manage) only their
//      own (another branch 403, not listed); a cashier 403; another business's branch 404; a till's own session 403;
//      bad theme / low-contrast colour / too-wide footer / markup 400; themes off → a change refused (THEMES_OFF), a clear
//      allowed; a row emptied is removed; each change in the audit log.
//   I  /api/pos/init: `branchBranding` is the till's own branch's row only; null with themes off (stored, not applied).
//   C  /api/pos/changes: a branch_branding entry answered with THIS branch's override; another branch's entry never
//      answered (even when the log hands it over); the themes switch's `branding` entry carries the override too.
//   W  the web: Settings › Branding's Per branch section (premium note with themes off, the picker / colour / footer
//      controls, the shared checks, PATCH / DELETE) and the manager portal's Branch branding; the web POS resolves its
//      branch's footer and theme with the shared rule.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
//   - business.ts PATCH without assertBranchAccess                       → R "a manager: another branch 403" fails
//   - business.ts PATCH without the themes check                         → R "themes off → refused" fails
//   - business.ts accent check by HEX only (no accentWriteError)          → R "a colour too dark … 400" fails
//   - branchBranding.ts footerWriteError without the line width check     → S "a line wider than 48" + R "too wide" fail
//   - branchBranding.ts resolve without the business-theme gate           → S "themes off → ignored" fails
//   - pos.ts servedBranchBranding(…, true) (ignoring the flag)            → I "null with themes off" fails
//   - syncChanges.ts branch_branding entries without the row_id === branch → C "another branch's entry never" fails
//
// A547 (owner, 2026-10-21: "you can also finish the leftovers"): A544's "not done" (a) and (b). The web reprint
// (lib/reprintReceipt.ts, the REAL module bundled with the API / print server / renderer stubbed) prints the order's
// branch footer from GET /api/business/branding/branches/:id/served (what pos/init serves a till of that branch) through
// the shared resolver; the web POS draws the till's brand strip (themeVars.posBrandStrip) only with themes on.
// MUTATIONS (A547, each red on its own):
//   - the served route without assertBranchAccess                         → A547 "served … another branch 403" fails
//   - the served route serving with the flag ignored (servedBranchBranding(…, true)) → A547 "themes off → nothing" fails
//   - reprintReceipt footerText back to map['receipt_footer']              → A547 "the order's BRANCH footer" fails
//   - posBrandStrip without the themeId gate                              → A547 "themes off → no strip" fails
//   - posBrandStrip without resolveBrandLayer (any hex)                   → A547 "too dark … no strip" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/branchBrandingStore.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

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
// The shared rule as the cloud compiled it (lib/branchBranding.ts — byte-identical to shared/, the till's and the web's
// copies: scripts/check-shared-sync.mjs).
const S = require(path.join(DIST, 'lib/branchBranding.js'));
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MANAGER = 'aaaaaaaa-0000-4000-8000-000000000002', CASHIER = 'aaaaaaaa-0000-4000-8000-000000000003';
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });

let seq = 10;
let rpcFiltersBranch = true;
mem.rpc = async (name, a) => {
  if (name === 'sync_changes_since') {
    return { data: (mem.db.sync_changes ?? []).filter((c) => c.business_id === a.p_business && c.seq > a.p_since
      && (!rpcFiltersBranch || c.branch_id == null || a.p_branch == null || c.branch_id === a.p_branch)).slice(0, a.p_limit), error: null };
  }
  return { data: null, error: null };
};
const logChange = (biz, branch, table_name, row_id, topic = 'look') =>
  mem.db.sync_changes.push({ seq: ++seq, business_id: biz, branch_id: branch, topic, table_name, row_id, op: 'upsert', changed_at: new Date(Date.now() - 10_000).toISOString() });

const reset = (themes = true) => {
  mem.fail = () => null; mem.calls = []; seq = 10; rpcFiltersBranch = true;
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); SC._resetSyncChanges();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Test Grill', type: 'restaurant', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'restaurant', currency: 'KES', vat_rate: 16, status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true },
      { id: BR2, business_id: B, name: 'Kilimani', is_main: false, desktop_licensed: true },
      { id: BRX, business_id: B2, name: 'Theirs', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 0, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      { id: MANAGER, name: 'Njeri', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-m', roles: perms('Manager', 'receipt.manage'), user_branches: [{ branch_id: BR }], user_permissions: [] },
      { id: CASHIER, name: 'Wanjiru', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-c', roles: perms('Cashier', 'orders.create'), user_branches: [{ branch_id: BR }], user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR2, user_id: OWNER }],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }, { business_id: B2, topic: 'catalogue', version: 3 }],
    feature_flags: themes ? [{ business_id: B, key: 'themes', enabled: true }, { business_id: B2, key: 'themes', enabled: true }] : [],
    business_branding: [{ business_id: B, accent_hex: '#0d9488', logo_png: null, logo_receipt: null, receipt_logo_enabled: false, theme_id: 'ocean' }],
    branch_branding: [
      { branch_id: BR, theme_id: 'violet', accent_hex: null, receipt_footer: 'Karibu Westlands', updated_at: '2026-10-21T08:00:00Z' },
      { branch_id: BR2, theme_id: null, accent_hex: '#f5b800', receipt_footer: null, updated_at: '2026-10-21T08:00:00Z' },
      { branch_id: BRX, theme_id: 'orchid', accent_hex: null, receipt_footer: 'Their footer', updated_at: '2026-10-21T08:00:00Z' },
    ],
    categories: [], products: [], branch_prices: [], tables: [], business_settings: [{ business_id: B, key: 'receipt_footer', value: 'Asante sana' }],
    branch_settings: [], payment_methods: [], offers: [], promotions: [], stock_takes: [], variant_groups: [], modifier_groups: [],
    combo_items: [], menus: [], sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }], change_requests: [],
    refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  manager: sign({ userId: MANAGER, permissionKeys: ['receipt.manage'], surface: 'dashboard' }),
  cashier: sign({ userId: CASHIER, permissionKeys: ['orders.create'], surface: 'dashboard' }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, branchId: BR2, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const bb = (id) => mem.db.branch_branding.find((r) => r.branch_id === id);

try {
  state._setPermissionsMigrated(true);

  console.log('\nS. the shared rule\n');
  await ok('per field: a branch overriding only its theme keeps the business colour and footer; only its colour; only its footer', async () => {
    const biz = { themeId: 'ocean', accentHex: '#0d9488', receiptFooter: 'Asante sana' };
    const t = S.resolveBranchBranding(biz, { branchId: BR, themeId: 'violet', accentHex: null, receiptFooter: null });
    assert.deepEqual([t.themeId, t.accentHex, t.receiptFooter], ['violet', '#0d9488', 'Asante sana']);
    assert.deepEqual(t.fromBranch, { theme: true, accent: false, footer: false });
    const c = S.resolveBranchBranding(biz, { branchId: BR, themeId: null, accentHex: '#f5b800', receiptFooter: null });
    assert.deepEqual([c.themeId, c.accentHex, c.receiptFooter], ['ocean', '#f5b800', 'Asante sana']);
    const f = S.resolveBranchBranding(biz, { branchId: BR, themeId: null, accentHex: null, receiptFooter: 'Karibu\nWestlands' });
    assert.deepEqual([f.themeId, f.accentHex, f.receiptFooter], ['ocean', '#0d9488', 'Karibu\nWestlands']);
    const none = S.resolveBranchBranding({ themeId: 'ocean' }, null);
    assert.deepEqual([none.themeId, none.accentHex, none.receiptFooter], ['ocean', null, ''], 'no override, no business colour → the defaults');
  });
  await ok('themes off (the business theme null) → an override is ignored (stored, never applied)', async () => {
    const r = S.resolveBranchBranding({ themeId: null, accentHex: '#0d9488', receiptFooter: 'Asante' },
      { branchId: BR, themeId: 'violet', accentHex: '#f5b800', receiptFooter: 'Karibu' });
    assert.deepEqual([r.themeId, r.accentHex, r.receiptFooter], [null, '#0d9488', 'Asante']);
  });
  await ok('the write checks: a curated theme; a colour seen on the dark till (3:1); a plain-text footer that fits', async () => {
    assert.equal(S.themeOverrideError('violet'), null); assert.equal(S.themeOverrideError(null), null);
    assert.match(S.themeOverrideError('emerald'), /curated/);
    assert.equal(S.accentWriteError('#f5b800'), null); assert.equal(S.accentWriteError('#FFF'), null);
    assert.match(S.accentWriteError('#1e293b'), /cannot be seen/, 'a navy too dark for the till');
    assert.match(S.accentWriteError('red'), /hex/);
    assert.equal(S.footerWriteError('Karibu Westlands\nFollow us @westlands'), null);
    assert.match(S.footerWriteError('x'.repeat(49)), /48/, 'a line wider than 48');
    assert.equal(S.footerWriteError('x'.repeat(48)), null);
    assert.match(S.footerWriteError('<b>Karibu</b>'), /plain text/);
    assert.match(S.footerWriteError('Karibu\u001b@'), /control/, 'a printer command');
    assert.match(S.footerWriteError('a\nb\nc\nd\ne\nf\ng'), /6 lines/);
    assert.equal(S.cleanFooter('\n  Karibu  \r\n Westlands \n\n'), '  Karibu\n Westlands', 'own line breaks kept (P-15), ends trimmed');
    assert.equal(S.cleanFooter('   \n '), null);
  });

  console.log('\nR. /api/business/branding/branches\n');
  await ok('the owner lists every branch of the business (never another business\'s), with themes on and the paper limits', async () => {
    reset();
    const r = await call('GET', '/api/business/branding/branches', T.owner);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.themes_enabled, true);
    assert.deepEqual(r.body.branches.map((b) => b.name).sort(), ['Kilimani', 'Westlands']);
    assert.equal(r.body.branches.find((b) => b.branch_id === BR).theme_id, 'violet');
    assert.equal(r.body.limits.line_max, 48); assert.equal(r.body.limits.line_narrow, 32);
    assert.ok(!r.text.includes('Their footer'));
  });
  await ok('the owner changes any branch: one field at a time (the others kept), cleaned and audited', async () => {
    reset();
    const r = await call('PATCH', `/api/business/branding/branches/${BR2}`, T.owner, { theme_id: 'teal', receipt_footer: ' Karibu Kilimani \n' });
    assert.equal(r.status, 200, r.text);
    assert.equal(bb(BR2).theme_id, 'teal'); assert.equal(bb(BR2).accent_hex, '#f5b800'); assert.equal(bb(BR2).receipt_footer, ' Karibu Kilimani');
    const a = mem.db.audit_log.at(-1);
    assert.equal(a.action, 'branch_branding.update'); assert.equal(a.business_id, B); assert.equal(a.record_id, BR2);
    assert.equal(a.before_data.accent_hex, '#f5b800'); assert.equal(a.after_data.theme_id, 'teal'); assert.equal(a.user_name, 'Owner');
    const c = await call('PATCH', `/api/business/branding/branches/${BR2}`, T.owner, { accent_hex: '#FC0' });
    assert.equal(c.status, 200); assert.equal(bb(BR2).accent_hex, '#ffcc00', '#RGB stored as #rrggbb');
  });
  await ok('a manager (receipt.manage) sees and changes only their own branch; another branch 403, unchanged', async () => {
    reset();
    const l = await call('GET', '/api/business/branding/branches', T.manager);
    assert.equal(l.status, 200, l.text);
    assert.deepEqual(l.body.branches.map((b) => b.branch_id), [BR]);
    assert.equal((await call('PATCH', `/api/business/branding/branches/${BR}`, T.manager, { theme_id: 'sky' })).status, 200);
    assert.equal(bb(BR).theme_id, 'sky');
    const other = await call('PATCH', `/api/business/branding/branches/${BR2}`, T.manager, { theme_id: 'sky' });
    assert.equal(other.status, 403); assert.equal(bb(BR2).theme_id, null);
    assert.equal((await call('DELETE', `/api/business/branding/branches/${BR2}`, T.manager)).status, 403);
    assert.ok(bb(BR2), 'not cleared');
  });
  await ok('a cashier is refused (403); a till\'s own session is refused; another business\'s branch 404', async () => {
    reset();
    assert.equal((await call('GET', '/api/business/branding/branches', T.cashier)).status, 403);
    assert.equal((await call('PATCH', `/api/business/branding/branches/${BR}`, T.cashier, { theme_id: 'sky' })).status, 403);
    assert.equal((await call('PATCH', `/api/business/branding/branches/${BR}`, T.till, { theme_id: 'sky' }, { 'x-device-id': 'dev-T1' })).status, 403);
    assert.equal(bb(BR).theme_id, 'violet');
    const x = await call('PATCH', `/api/business/branding/branches/${BRX}`, T.owner, { theme_id: 'sky' });
    assert.equal(x.status, 404); assert.equal(bb(BRX).theme_id, 'orchid');
    assert.equal((await call('DELETE', `/api/business/branding/branches/${BRX}`, T.owner)).status, 404);
    assert.ok(bb(BRX));
  });
  await ok('validation: a bad theme, a colour too dark to see on the till, a footer too wide, markup — 400, nothing stored', async () => {
    reset();
    for (const [body, field] of [[{ theme_id: 'emerald' }, 'theme_id'], [{ accent_hex: '#1e293b' }, 'accent_hex'], [{ accent_hex: 'blue' }, 'accent_hex'],
      [{ receipt_footer: 'x'.repeat(49) }, 'receipt_footer'], [{ receipt_footer: '<script>x</script>' }, 'receipt_footer'], [{}, undefined]]) {
      const r = await call('PATCH', `/api/business/branding/branches/${BR}`, T.owner, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
      if (field) assert.equal(r.body.field, field);
    }
    assert.equal(bb(BR).theme_id, 'violet'); assert.equal(bb(BR).receipt_footer, 'Karibu Westlands'); assert.equal(mem.db.audit_log.length, 0);
  });
  await ok('themes off: a change refused (THEMES_OFF, "part of Themes"), a clear allowed; the list says themes are off', async () => {
    reset(false);
    const r = await call('PATCH', `/api/business/branding/branches/${BR}`, T.owner, { theme_id: 'sky' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'THEMES_OFF'); assert.match(r.body.error, /part of Themes/);
    assert.equal(bb(BR).theme_id, 'violet');
    assert.equal((await call('GET', '/api/business/branding/branches', T.owner)).body.themes_enabled, false);
    assert.equal((await call('DELETE', `/api/business/branding/branches/${BR}`, T.owner)).status, 200);
    assert.equal(bb(BR), undefined); assert.equal(mem.db.audit_log.at(-1).action, 'branch_branding.clear');
  });
  await ok('every field set back to the business\'s: the row is removed (the branch follows the business again)', async () => {
    reset();
    const r = await call('PATCH', `/api/business/branding/branches/${BR2}`, T.owner, { accent_hex: null });
    assert.equal(r.status, 200, r.text); assert.equal(bb(BR2), undefined);
    assert.equal(mem.db.audit_log.at(-1).action, 'branch_branding.clear');
  });

  console.log('\nI. /api/pos/init\n');
  await ok('init carries the till\'s own branch\'s override only (Westlands\'), never another branch\'s', async () => {
    reset();
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.body.branchBranding, { branchId: BR, themeId: 'violet', accentHex: null, receiptFooter: 'Karibu Westlands' });
    assert.equal(r.body.themeId, 'ocean'); assert.equal(r.body.receiptFooter, 'Asante sana', 'the business footer is still sent as it was');
    assert.ok(!r.text.includes('#f5b800') && !r.text.includes('Their footer'));
    const k = await call('GET', `/api/pos/init?branch_id=${BR2}`, T.till2, undefined, { 'x-device-id': 'dev-T2' });
    assert.equal(k.status, 200, k.text.slice(0, 300));
    assert.equal(k.body.branchBranding.accentHex, '#f5b800'); assert.equal(k.body.branchBranding.branchId, BR2);
  });
  await ok('themes off: init carries no override (null) and no theme — stored, not applied', async () => {
    reset(false);
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.branchBranding, null); assert.equal(r.body.themeId, null);
    assert.ok(bb(BR), 'the row is kept');
  });
  await ok('before migration 156 (no table): init still answers, with no override', async () => {
    reset();
    mem.fail = (t) => (t === 'branch_branding' ? { code: '42P01', message: 'relation "public.branch_branding" does not exist' } : null);
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200); assert.equal(r.body.branchBranding, null);
  });

  console.log('\nC. /api/pos/changes\n');
  await ok('a branch_branding entry is answered with THIS branch\'s override (topic look)', async () => {
    reset();
    logChange(B, BR, 'branch_branding', BR);
    const r = await call('GET', `/api/pos/changes?since=10&branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.changes.length, 1);
    const e = r.body.changes[0];
    assert.equal(e.table, 'branch_branding'); assert.equal(e.topic, 'look'); assert.equal(e.id, BR);
    assert.deepEqual(e.row, { branchBranding: { branchId: BR, themeId: 'violet', accentHex: null, receiptFooter: 'Karibu Westlands' } });
  });
  await ok('another branch\'s entry is never answered — even when the log hands it over', async () => {
    reset(); rpcFiltersBranch = false;
    logChange(B, BR2, 'branch_branding', BR2);
    const r = await call('GET', `/api/pos/changes?since=10&branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.changes, []); assert.ok(!r.text.includes('#f5b800'));
  });
  await ok('the themes switch (a branding entry) carries the branch\'s override with the theme', async () => {
    reset();
    logChange(B, null, 'branding', 'branding');
    const r = await call('GET', `/api/pos/changes?since=10&branch_id=${BR2}`, T.till2, undefined, { 'x-device-id': 'dev-T2' });
    assert.equal(r.status, 200, r.text);
    const e = r.body.changes.find((c) => c.table === 'branding');
    assert.ok(e, r.text); assert.equal(e.row.themeId, 'ocean'); assert.equal(e.row.branchBranding.branchId, BR2);
  });

  console.log('\nW. the web\n');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const tab = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
  const mgr = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  const pos = read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts');
  const tv = read('apps/dashboard/src/lib/themeVars.ts');
  const layer = read('apps/dashboard/src/components/ThemeLayer.tsx');
  await ok('Settings › Branding: the Per branch section only with themes; otherwise the "part of Themes — ask ZapTill" note', async () => {
    assert.match(tab, /\{themesEnabled && <BranchBrandingSection client=\{api\} \/>\}/);
    assert.match(tab, /\{!themesEnabled && \(\s*<p[^>]*data-testid="branch-branding-premium-note">[^<]*part of Themes — ask ZapTill/);
    assert.match(tab, /if \(!list\.themes_enabled\) \{\s*return <p[^>]*>Per-branch branding is part of Themes — ask ZapTill\.<\/p>;/);
  });
  await ok('…each branch: the theme picker with "Use the business\'s", the colour control, the footer with its per-line width', async () => {
    assert.match(tab, /client\.get<BranchBrandingList>\('\/api\/business\/branding\/branches'\)/);
    assert.match(tab, /aria-checked=\{themeId === null\} onClick=\{\(\) => setThemeId\(null\)\}/);
    assert.match(tab, /\{THEMES\.map\(\(t\) => \{\s*const on = themeId === t\.id;/);
    assert.match(tab, /\{PALETTE\.map\(\(p\) => \(\s*<button key=\{p\.hex\} type="button"/);
    assert.match(tab, /const accentErr = accent\.trim\(\) \? accentWriteError\(accent\.trim\(\)\) : null;/);
    assert.match(tab, /const footerErr = footerWriteError\(footer\);/);
    assert.match(tab, /line \{i \+ 1\}: \{l\.length\}\/\{lineMax\}/);
    assert.match(tab, /<TillPreview theme=\{resolveTheme\(look\.themeId\)\} brandHex=\{look\.accentHex\}(?: primaryHex=\{look\.primaryHex\} secondaryHex=\{look\.secondaryHex\})? \/>/);
    assert.match(tab, /client\.patch<BranchBrandingRow>\(`\/api\/business\/branding\/branches\/\$\{row\.branch_id\}`/);
    assert.match(tab, /client\.delete\(`\/api\/business\/branding\/branches\/\$\{row\.branch_id\}`\)/);
    assert.match(tab, /disabled=\{busy \|\| !!accentErr \|\| !!footerErr\}/);
  });
  await ok('the manager portal: Branch branding (receipt.manage or settings.business) under the manager\'s own sign-in', async () => {
    assert.match(mgr, /key: 'branding',.*permission: \['receipt\.manage', 'settings\.business'\], group: 'Settings'/);
    assert.match(mgr, /case 'branding':[^\n]*\n\s*return <div[^>]*><BranchBrandingSection client=\{\{ get: posApi\.get, patch: posApi\.patch, delete: posApi\.delete \}\} \/><\/div>;/);
  });
  await ok('the web POS: its branch\'s footer and theme with the shared rule (themes off → the business\'s)', async () => {
    assert.match(pos, /const look = resolveBranchBranding\(\s*\{ themeId: init\.themeId \?\? null, accentHex: init\.branding\?\.accentHex \?\? null, receiptFooter: init\.receiptFooter \?\? '' \},\s*branchBrandingFromWire\(init\.branchBranding\)\);/);
    assert.match(pos, /setReceiptFooter\(look\.receiptFooter\);/);
    assert.match(pos, /setBranchThemeId\(look\.fromBranch\.theme \? look\.themeId : null\);/);
    assert.match(layer, /computeDashboardThemeVars\(withBranchTheme\(b, posBranchTheme\(\)\)\)/);
    assert.match(tv, /if \(!branchThemeId \|\| b\.themes_enabled !== true\) return b;/);
    // …and the web POS's resolver, run: the dashboard's copy is byte-identical to the cloud's compiled one.
    assert.equal(read('apps/dashboard/src/lib/branchBranding.ts'), read('shared/branchBranding.ts'));
    const W = S;
    const look = W.resolveBranchBranding({ themeId: 'ocean', receiptFooter: 'Asante' }, W.branchBrandingFromWire({ branchId: BR, themeId: 'violet', receiptFooter: 'Karibu' }));
    assert.deepEqual([look.themeId, look.receiptFooter], ['violet', 'Karibu']);
    const off = W.resolveBranchBranding({ themeId: null, receiptFooter: 'Asante' }, W.branchBrandingFromWire({ branchId: BR, themeId: 'violet', receiptFooter: 'Karibu' }));
    assert.deepEqual([off.themeId, off.receiptFooter], [null, 'Asante']);
    assert.equal(W.branchBrandingFromWire({ branchId: BR, receiptFooter: 'x'.repeat(60) }).receiptFooter, null, 'a footer that does not fit is not applied');
  });

  // ── A547: A544's "not done" (a) the web reprint's footer, (b) the web POS's brand layer ─────────────────────────────
  console.log('\nA547. the web reprint uses the branch footer; the web POS draws the brand strip\n');
  const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a547-'));
  const bundle = async (entryFile, stubs = {}) => {
    const out = path.join(tmp, `${path.basename(entryFile)}.${Object.keys(stubs).length}.cjs`);
    await esbuild.build({ entryPoints: [path.join(ROOT, entryFile)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
      plugins: [{ name: 'stubs', setup(b) {
        const names = Object.keys(stubs);
        if (!names.length) return;
        b.onResolve({ filter: new RegExp(`^\\./(${names.join('|')})$`) }, (a) => ({ path: a.path.slice(2), namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      } }] });
    return createRequire(import.meta.url)(out);
  };
  await ok('GET …/branches/:id/served: what a till of that branch is served — the effective theme and the override', async () => {
    reset();
    const o = await call('GET', `/api/business/branding/branches/${BR}/served`, T.owner);
    assert.equal(o.status, 200, o.text);
    assert.equal(o.body.themeId, 'ocean'); assert.equal(o.body.branchBranding.receiptFooter, 'Karibu Westlands');
    const c = await call('GET', `/api/business/branding/branches/${BR}/served`, T.cashier);
    assert.equal(c.status, 200, 'a cashier reprints at their own branch'); assert.equal(c.body.branchBranding.branchId, BR);
    assert.equal((await call('GET', `/api/business/branding/branches/${BR2}/served`, T.cashier)).status, 403, 'another branch');
    assert.equal((await call('GET', `/api/business/branding/branches/${BRX}/served`, T.owner)).status, 404, 'another business\'s branch');
    assert.equal((await call('GET', `/api/business/branding/branches/${BR}/served`)).status, 401);
    reset(false);
    const off = await call('GET', `/api/business/branding/branches/${BR}/served`, T.owner);
    assert.equal(off.status, 200); assert.equal(off.body.themeId, null); assert.equal(off.body.branchBranding, null, 'themes off → nothing served');
  });
  // The REAL reprint (lib/reprintReceipt.ts) bundled with the API, the print server and the renderer stubbed: what it hands
  // the renderer as the footer, given what each route answers.
  // One bundle (cached by require); the stubs read globalThis.__a547 at call time, so each case sets its answers.
  const reprintWith = async (answers) => {
    globalThis.__a547 = { answers, biz: null, calls: [] };
    return bundle('apps/dashboard/src/lib/reprintReceipt.ts', {
      api: `export const api = { get: async (p) => { globalThis.__a547.calls.push(p); const a = globalThis.__a547.answers(p); if (a instanceof Error) throw a; return a; } };`,
      localPrintServer: `export const getQZStatus = () => 'connected'; export const printBytesToServer = async () => {};`,
      escposRenderer: `export const monoRasterFromString = () => null; export const renderReceiptEscPos = (o, biz) => { globalThis.__a547.biz = biz; return new Uint8Array([1]); };`,
    });
  };
  const ORDER = { id: 'o1', branch_id: BR, order_number: 'W-7', order_items: [], payments: [], total: 100 };
  const answersFor = (served) => (p) => {
    if (p.startsWith('/api/orders/')) return ORDER;
    if (p === '/api/business') return { name: 'Test Grill', currency: 'KES', vat_rate: 16 };
    if (p === '/api/business/branding') return null;
    if (p === '/api/business/settings') return [{ key: 'receipt_footer', value: 'Asante sana' }];
    if (p.startsWith('/api/printers')) return [{ enabled: true, printer_name: 'EPSON', is_default_receipt: true, paper_width: 80 }];
    if (p === '/api/flags') return {};
    if (p.endsWith('/served')) return served;
    return null;
  };
  await ok('the web reprint prints the order\'s BRANCH footer (branch → business), from the served route', async () => {
    reset();
    const served = (await call('GET', `/api/business/branding/branches/${BR}/served`, T.owner)).body;
    const R = await reprintWith(answersFor(served));
    const r = await R.reprintOrderReceipt('o1');
    assert.ok(r.ok, r.message);
    assert.ok(globalThis.__a547.calls.includes(`/api/business/branding/branches/${BR}/served`), globalThis.__a547.calls.join(' '));
    assert.equal(globalThis.__a547.biz.thankYouMessage, 'Karibu Westlands');
  });
  await ok('…no branch footer, themes off, an older cloud (the route refused) → the business footer, as before A547', async () => {
    for (const served of [{ themeId: 'ocean', branchBranding: { branchId: BR, themeId: 'violet', accentHex: null, receiptFooter: null } },
      { themeId: null, branchBranding: { branchId: BR, themeId: null, accentHex: null, receiptFooter: 'Karibu Westlands' } },
      new Error('404 Not found'), null]) {
      const R = await reprintWith(answersFor(served));
      assert.ok((await R.reprintOrderReceipt('o1')).ok);
      assert.equal(globalThis.__a547.biz.thankYouMessage, 'Asante sana', JSON.stringify(served));
    }
    const R = await reprintWith(answersFor(null));
    assert.equal(R.effectiveFooter('Asante', { themeId: 'ocean', branchBranding: { branchId: BR, receiptFooter: 'Karibu' } }), 'Karibu');
  });
  const TV = await bundle('apps/dashboard/src/lib/themeVars.ts');
  await ok('the web POS brand strip: the resolved colour (branch → business) only with themes on and only when it can be seen', async () => {
    assert.equal(TV.posBrandStrip('ocean', '#f5b800'), '#F5B800', 'the till\'s strip colour (resolveBrandLayer)');
    assert.equal(TV.posBrandStrip(null, '#f5b800'), null, 'themes off → no strip');
    assert.equal(TV.posBrandStrip('ocean', null), null, 'no colour → no strip');
    assert.equal(TV.posBrandStrip('ocean', '#1e293b'), null, 'too dark to be seen on the dark screens → no strip (as the till)');
    assert.equal(TV.posBrandStrip('ocean', 'red'), null);
    // The web POS resolves the colour with the shared rule: Kilimani's own colour, else the business's.
    const kil = S.resolveBranchBranding({ themeId: 'ocean', accentHex: '#0d9488' }, S.branchBrandingFromWire({ branchId: BR2, accentHex: '#f5b800' }));
    assert.equal(TV.posBrandStrip(kil.themeId, kil.accentHex), '#F5B800');
    const wl = S.resolveBranchBranding({ themeId: 'ocean', accentHex: '#0d9488' }, S.branchBrandingFromWire({ branchId: BR, themeId: 'violet' }));
    assert.equal(TV.posBrandStrip(wl.themeId, wl.accentHex), '#0D9488');
    const off = S.resolveBranchBranding({ themeId: null, accentHex: '#0d9488' }, S.branchBrandingFromWire({ branchId: BR2, accentHex: '#f5b800' }));
    assert.equal(TV.posBrandStrip(off.themeId, off.accentHex), null);
  });
  await ok('…wired: usePOSData sets it from the resolved look; the cashier screen draws it across the top', async () => {
    const pos2 = read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts');
    assert.match(pos2, /setBrandStrip\(posBrandStrip\(look\.themeId, look\.accentHex\)\);/);
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(cs, /\{brandStrip && <div aria-hidden data-testid="pos-brand-strip"\s*style=\{\{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 60, pointerEvents: 'none', background: brandStrip \}\} \/>\}/);
    assert.match(cs, /brandStrip,\s+\/\/ A547/);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
