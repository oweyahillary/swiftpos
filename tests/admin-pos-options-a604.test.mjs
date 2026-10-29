/**
 * admin-pos-options-a604.test.mjs — A604: the admin portal's per-business Features tab, "POS switches" / "Other flags".
 *
 * Owner, 2026-10-28 (screenshots of the Features tab): "why cant we move this switches to the owners side, why did you let
 * them remain in admin while we were doing rights". They WERE the owner's (A490/A594: Settings › Business › POS options);
 * the portal only showed them — as ON/OFF pills, three cashier switches retired into role permissions with an orange
 * "stored value no longer applies" note each, and the three STANDARD keys (always on since 0.6.29 / A461, a stored value
 * ignored) as raw toggles under "Other flags" (blind_shift_close showing OFF while cashiers always close blind).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/admin-pos-options-a604.test.mjs
 *
 * RUNS apps/admin/src/ownerSettings.ts and apps/admin/src/lib/posFeatures.ts (type-stripped), pins the Features tab of
 * apps/admin/src/AdminPortal.tsx (React is not run), and RUNS the COMPILED admin router over HTTP (the real requireAdmin,
 * an in-memory database) for the cloud's refusal of the STANDARD keys (409 ALWAYS_ON, nothing written).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — A604 report):
 *   - the "Other flags" filter without the STANDARD_POS_FEATURES exclusion    → "no toggle for a STANDARD key" fails
 *   - ownerValue drawn as a toggle again (toggle(on, …) in the POS options)    → "labels, not switches" fails
 *   - admin.ts without the alwaysOnFeature refusal                             → "PATCH … blind_shift_close → 409" fails
 *   - the per-role skip (`if (PER_ROLE_SWITCHES[pf.key]) return null;`) gone   → "the three superseded rows are gone" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A604_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A604_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
if (!fs.existsSync(path.join(DIST, 'routes/admin.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
const O = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/ownerSettings.ts')).href);
const F = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/lib/posFeatures.ts')).href);
const ap = read('apps/admin/src/AdminPortal.tsx');
const features = (() => {
  const i = ap.indexOf('{tab === "features" && (');
  assert.ok(i > 0, 'the features tab');
  return ap.slice(i, ap.indexOf('{tab === "', i + 10));
})();
// The owner's block: from its heading to "Receipt options" (ZapTill's own receipt switches follow).
const ownerBlock = features.slice(features.indexOf('{OWNER_POS_OPTIONS_HEADING}'), features.indexOf('>Receipt options</div>'));
const otherBlock = features.slice(features.indexOf('A538: a retired switch'));

let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('A604 — the admin portal\'s POS options: the owner\'s, shown plainly\n');

await ok('the section: "POS options (set by the owner)" and the one line on where the owner changes them', () => {
  assert.equal(O.OWNER_POS_OPTIONS_HEADING, 'POS options (set by the owner)');
  assert.equal(O.OWNER_POS_OPTIONS_NOTE, 'The business owner changes these in their dashboard: Settings › Business › POS options.');
  assert.ok(ownerBlock.length > 200, 'the owner block found');
  assert.match(features, /data-testid="pos-options-heading"[^>]*>\{OWNER_POS_OPTIONS_HEADING\}<\/div>/);
  assert.match(features, /data-testid="pos-options-owner-note"[^>]*>\{OWNER_POS_OPTIONS_NOTE\}<\/div>/);
  assert.doesNotMatch(features, />POS switches</);
});

await ok('the owner\'s options are labels ("On" / "Off"), not switches', () => {
  assert.equal(O.ownerValueText(true), 'On'); assert.equal(O.ownerValueText(false), 'Off');
  const helper = /const ownerValue = \(on, label\) => \(([\s\S]*?)\n  \);/.exec(ap);
  assert.ok(helper, 'the ownerValue helper');
  assert.match(helper[1], /^\s*<span data-testid="owner-set-value"/);
  assert.match(helper[1], /\{ownerValueText\(on\)\}/);
  assert.doesNotMatch(helper[1], /<button|aria-pressed|onClick|borderRadius/, 'nothing to press, no pill');
  assert.doesNotMatch(ap, /statePill/);
  assert.match(ownerBlock, /\{ownerValue\(on, pf\.label\)\}/);
  assert.match(ownerBlock, /\{ownerValue\(on, OWNER_LOYALTY\.label\)\}/);
  assert.doesNotMatch(ownerBlock, /toggle\(|toggleFeature\(/, 'no switch in the owner\'s block');
});

await ok('every row listed in the owner\'s block is an owner option (no live admin toggle hides there)', () => {
  const listed = F.POS_FEATURES.map((f) => f.key).filter((k) => !F.RECEIPT_OPTION_KEYS.includes(k) && !F.KITCHEN_OPTION_KEYS.includes(k)
    && !O.PER_ROLE_SWITCHES[k]);
  assert.deepEqual([...listed, O.OWNER_LOYALTY.key].sort(), [...O.OWNER_POS_OPTIONS].sort());
  for (const k of listed) assert.equal(O.adminSwitches(k), false, k);
  assert.match(ownerBlock, /if \(\(RECEIPT_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
  assert.match(ownerBlock, /if \(\(KITCHEN_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;/);
});

await ok('the three superseded rows are gone; one line says the cashier rights are set per role', () => {
  assert.deepEqual(Object.keys(O.PER_ROLE_SWITCHES).sort(), ['cashier_no_money_out', 'cashier_no_reprint', 'cashier_own_history']);
  assert.match(ownerBlock, /if \(PER_ROLE_SWITCHES\[pf\.key\]\) return null;/);
  assert.doesNotMatch(features, /The stored value shown no longer applies/);
  assert.doesNotMatch(features, /#f59e0b/, 'no orange per-row note');
  assert.equal(O.PER_ROLE_NOTE, 'Cashier rights (own sales only, reprints, cash in/out and expenses) are set per role by the owner: Settings › Users and access › Roles and permissions.');
  assert.match(ownerBlock, /data-testid="per-role-note"[^>]*>\{PER_ROLE_NOTE\}<\/div>/);
});

await ok('no toggle for a STANDARD key: kept out of "Other flags", one "always on" line instead', () => {
  assert.deepEqual([...F.STANDARD_POS_FEATURES], ['blind_shift_close', 'confirm_shows_cashier_figures', 'kitchen_void_approval']);
  for (const k of F.STANDARD_POS_FEATURES) assert.ok(!ap.includes(k), `${k} is not named in the portal`);
  // Both the guard and the list skip them (the same filter twice).
  assert.equal((otherBlock.match(/!\(STANDARD_POS_FEATURES as readonly string\[\]\)\.includes\(f\.key\)/g) ?? []).length, 2);
  assert.equal((otherBlock.match(/f\.key !== OWNER_LOYALTY\.key/g) ?? []).length, 2, 'loyalty is listed with the owner\'s options');
  assert.equal(O.ALWAYS_ON_NOTE, 'Always on for every business: blind shift close, cashier figures at confirm, manager approval of kitchen voids.');
  assert.match(ownerBlock, /data-testid="always-on-note"[^>]*>\{ALWAYS_ON_NOTE\}<\/div>/);
  assert.match(ap, /if \(\(STANDARD_POS_FEATURES as readonly string\[\]\)\.includes\(key\)\) \{ setError\(ALWAYS_ON_NOTE\); return; \}/);
});

await ok('what is left under "Other flags" is a real switch under a plain name (etims_enabled named), never the raw key', () => {
  assert.equal(O.OTHER_FLAG_LABELS.etims_enabled.label, 'eTIMS (KRA) invoices');
  assert.equal(O.adminSwitches('etims_enabled'), true);
  assert.match(otherBlock, /\{OTHER_FLAG_LABELS\[f\.key\]\?\.label \?\? f\.key\}/);
  assert.doesNotMatch(otherBlock, /fontFamily: "monospace", color: C\.accent \}\}>\{f\.key\}/, 'the raw monospace key is gone');
  assert.match(otherBlock, /toggle\(f\.enabled, \(\) => toggleFeature\(f\.key, !f\.enabled\), OTHER_FLAG_LABELS\[f\.key\]\?\.label \?\? f\.key\)/);
});

await ok('the real admin switches stay: themes, analytics, attendance, the A601 cut-off, receipt and kitchen options', () => {
  assert.match(features, /toggle\(hasThemes, \(\) => toggleThemes\(!hasThemes\), "App themes and brand colours"\)/);
  assert.match(features, /toggle\(hasAnalytics, \(\) => toggleAnalytics\(!hasAnalytics\), "Analytics"\), "feature-analytics"\)/);
  assert.match(features, /toggle\(hasAttendance, \(\) => toggleAttendance\(!hasAttendance\), "Attendance"\), "feature-attendance"\)/);
  assert.match(features, /superOnly\(toggle\(hasCloudBackup, \(\) => toggleCutoffFlag\('cloud_backup', !hasCloudBackup\), "Keep cloud backup"\)\), "feature-cloud-backup"\)/);
  assert.match(features, /superOnly\(toggle\(hasDesktopUpdates, \(\) => toggleCutoffFlag\('desktop_updates', !hasDesktopUpdates\), "Release desktop updates"\)\), "feature-desktop-updates"\)/);
  assert.match(features, /toggle\(on, \(\) => toggleFeature\(key, !on\), rf\?\.label \?\? key\)/);
  assert.match(features, /toggle\(on, \(\) => toggleFeature\(key, !on\), kf\?\.label \?\? key\)/);
  // …and they stay out of "Other flags".
  for (const k of ['themes', 'analytics', 'attendance', 'web_hosting', 'cloud_backup', 'desktop_updates'])
    assert.equal((otherBlock.match(new RegExp(`f\\.key !== "${k}"`, 'g')) ?? []).length, 2, k);
});

// ── the cloud: the admin portal's write of a STANDARD key is refused ───────────
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const BZ = randomUUID(), ADMIN = randomUUID();
let db, nextId = 1;
const reset = () => {
  db = {
    businesses: [{ id: BZ, name: 'Pollo' }], feature_flags: [], admin_audit_log: [],
    admin_users: [{ id: ADMIN, email: 'a@zaptill.test', role: 'super_admin', is_active: true }],
  };
};
reset();
supabase.from = (table) => {
  const f = []; let inserted = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => inserted ?? rows();
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: x.id ?? `row-${nextId++}`, ...x }));
        (db[table] ??= []).push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const adminT = jwt.sign({ adminId: ADMIN, email: 'a@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const patch = async (key, enabled) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/clients/${BZ}/features/${key}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminT}` }, body: JSON.stringify({ enabled }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\nthe cloud\n');
const C = require(path.join(DIST, 'routes/controls.js'));
await ok('alwaysOnFeature names the three STANDARD keys only', () => {
  for (const k of F.STANDARD_POS_FEATURES) assert.equal(C.alwaysOnFeature(k), C.ALWAYS_ON_REFUSAL, k);
  for (const k of ['etims_enabled', 'themes', 'delivery_fee', 'cashier_own_history', 'receipt_full_logo']) assert.equal(C.alwaysOnFeature(k), null, k);
  assert.match(C.ALWAYS_ON_REFUSAL, /always on for every business/);
});
for (const key of F.STANDARD_POS_FEATURES) {
  for (const enabled of [false, true]) {
    await ok(`PATCH /api/admin/clients/:id/features/${key} {enabled: ${enabled}} → 409 ALWAYS_ON, nothing written`, async () => {
      reset();
      const r = await patch(key, enabled);
      assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'ALWAYS_ON');
      assert.equal(r.body.error, C.ALWAYS_ON_REFUSAL);
      assert.ok(!db.feature_flags.some((f) => f.key === key), 'no flag written');
    });
  }
}
await ok('the superseded cashier switches are still refused as before (403 OWNER_SETS, per role)', async () => {
  for (const key of Object.keys(O.PER_ROLE_SWITCHES)) {
    reset();
    const r = await patch(key, true);
    assert.equal(r.status, 403, key); assert.equal(r.body.code, 'OWNER_SETS', key); assert.match(r.body.error, /per role/);
    assert.ok(!db.feature_flags.length, key);
  }
});
await ok('a flag that stays ZapTill\'s is still switched (etims_enabled, receipt_full_logo, themes)', async () => {
  for (const key of ['etims_enabled', 'receipt_full_logo', 'themes']) {
    reset();
    const r = await patch(key, true);
    assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    assert.ok(db.feature_flags.some((f) => f.key === key && f.enabled === true), key);
  }
});

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
