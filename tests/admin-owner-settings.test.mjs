/**
 * admin-owner-settings.test.mjs — A491: the admin portal after A490 moved the POS options, the cashier switches and till
 * updates to the owner (docs/PERMISSIONS-A490.md "Moved from the admin portal to the owner").
 *
 *   node tests/admin-owner-settings.test.mjs
 *
 * RUNS apps/admin/src/ownerSettings.ts (type-stripped); pins apps/admin/src/AdminPortal.tsx (React is not run).
 *
 * MUTATIONS TO CONFIRM BITE: a POS switch drawn with toggle() again → "read-only" fails; adminSwitches('themes') false →
 * "stay admin" fails; the Approve button or the desktop-version PATCH back → "Updates read-only" fails; the OWNER_SETS
 * message dropped from toggleFeature → "shows the cloud's message" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.ADMIN_OWNER_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, ADMIN_OWNER_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const O = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/ownerSettings.ts')).href);
const ap = read('apps/admin/src/AdminPortal.tsx');
const tab = (name) => {
  const i = ap.indexOf(`{tab === "${name}" && (`);
  assert.ok(i > 0, `the ${name} tab`);
  const j = ap.indexOf('{tab === "', i + 10);
  return ap.slice(i, j > 0 ? j : undefined);
};

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('A491 — the admin portal shows what the owner sets\n');

ok('the owner\'s keys are not switched from the portal; the admin-only ones still are', () => {
  for (const k of ['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes', 'loyalty_enabled',
    'cashier_own_history', 'cashier_no_money_out', 'cashier_no_reprint']) assert.equal(O.adminSwitches(k), false, k);
  for (const k of ['themes', 'web_hosting', 'some_other_flag']) assert.equal(O.adminSwitches(k), true, k);
  assert.match(O.PER_ROLE_SWITCHES.cashier_own_history, /sales\.history_all/);
  assert.match(O.PER_ROLE_SWITCHES.cashier_no_money_out, /shifts\.cash_movements/);
  assert.match(O.PER_ROLE_SWITCHES.cashier_no_reprint, /sales\.reprint/);
  assert.equal(O.OWNER_POS_OPTIONS_WHERE, 'Set by the owner — Settings › Business › POS options');
  assert.equal(O.PER_ROLE_WHERE, 'Now set per role by the owner — Settings › Users and access › Roles and permissions');
  assert.equal(O.OWNER_UPDATES_WHERE, 'The owner approves or holds updates — Settings › Business › Till updates');
});

ok('the cloud\'s OWNER_SETS refusal is shown with its own message', () => {
  assert.equal(O.ownerSetsMessage({ code: 'OWNER_SETS', message: 'The owner sets this.' }), 'The owner sets this.');
  assert.ok(O.ownerSetsMessage({ code: 'OWNER_SETS', message: '' }));
  assert.equal(O.ownerSetsMessage({ code: 'OTHER', message: 'x' }), null);
  assert.match(ap, /catch\(e\) \{ setError\(ownerSetsMessage\(e\) \?\? e\.message\); \}/);
  assert.match(ap, /async function toggleFeature\(key, enabled\) \{\s*if \(!adminSwitches\(key\)\)/);
});

ok('Features: the POS switches are read-only (a state pill, no switch), with where the owner sets them', () => {
  const f = tab('features');
  assert.match(f, /\{POS_FEATURES\.map\(pf => \{/);
  assert.match(f, /\{statePill\(on, pf\.label\)\}/);
  assert.doesNotMatch(f, /toggleFeature\(pf\.key/);
  assert.match(f, /\{OWNER_POS_OPTIONS_WHERE\}/);
  assert.match(f, /\{PER_ROLE_WHERE\}: “\{perRole\}”\. The stored value shown no longer applies once roles hold the permission\./);
});

ok('Features: other flags switch only when the portal holds them (loyalty_enabled read-only); themes still toggles', () => {
  const f = tab('features');
  assert.match(f, /\{adminSwitches\(f\.key\) \? toggle\(f\.enabled, \(\) => toggleFeature\(f\.key, !f\.enabled\), f\.key\) : statePill\(f\.enabled, f\.key\)\}/);
  assert.match(f, /toggle\(hasThemes, \(\) => toggleThemes\(!hasThemes\), "App themes"\)/);
  assert.match(ap, /req\("PATCH", `\/clients\/\$\{client\.id\}\/features\/themes`/);
  assert.match(ap, /req\("PATCH", `\/clients\/\$\{client\.id\}\/features\/web_hosting`/);
  assert.match(ap, /req\("PATCH", `\/clients\/\$\{client\.id\}\/web-access`/);
});

ok('Updates: the approved version, the releases and the tills shown; no picker, Approve or Hold', () => {
  const u = tab('updates');
  assert.match(u, /detail\?\.desktop_approved_version/);
  assert.match(u, /\{OWNER_UPDATES_WHERE\}/);
  assert.match(u, /visibleVersions\(desktopReleases, detail\?\.desktop_approved_version, showAllVersions\)\.map/);
  assert.match(u, />Tills now</);
  assert.doesNotMatch(u, /<select|>Hold<|"Approve"|setDesktopVersion/);
  assert.doesNotMatch(ap, /\/desktop-version`/, 'the portal no longer writes the approved version');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
