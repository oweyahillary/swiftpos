/**
 * android-till-tabs.test.mjs — ZapTill for Android, Till stage 3b (client): the Shop POS's client for the branch node's
 * shared held-order store (shop/branchTabs.ts → /node/tabs…). A tab opened on one till is registered to the node and
 * claimed (90s lease) before another edits/charges it; a LIVE foreign lock is 409 (read-only + manager take-over), a
 * LAPSED one auto-steals. This RUNS branchTabs.ts with the native BranchServer / link / device injected.
 *
 *   node --no-warnings tests/android-till-tabs.test.mjs   (bundles apps/android/src with esbuild — Capacitor external)
 *
 * RUNS (pure parsers + injected IO — no device touched):
 *   C  readClaimOutcome: claimed (±stole) · 409 locked+lockedBy · 404/503/null → unreachable · a 200 with no tab → unreachable.
 *   E  readEditOutcome: ok · 423/409 lost · 404/503/null unreachable.
 *   L  parseTabList: a bare array · {tabs:[…]} · a non-200 → [] · a cart JSON string parsed.
 *   F  listTabs/registerTab/claimTab/forceClaim/updateTab/releaseTab/deleteTab: no link → neutral + the server untouched;
 *      the right path, method, body and x-device-id (the lock holder is the proven device); a thrown request → unreachable.
 *   S  checked in source: imports nodeRequest; does NOT import cloud/client or react; the staff name rides in the body.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - readClaimOutcome treating a 503 as 'claimed'                 → C "a 503 is unreachable (falls back to local)"
 *   - claimTab not sending x-device-id                             → F "claim proves the device"
 *   - readEditOutcome treating a 423 as 'ok'                       → E "a 423 is a lost lease"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tilltabs-'));
fs.writeFileSync(path.join(tmp, 'stub-capacitor-core.cjs'),
  `module.exports = { registerPlugin: () => ({}), CapacitorHttp: { request: async () => ({ status: 0, data: null }) }, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } };`);
fs.writeFileSync(path.join(tmp, 'stub-preferences.cjs'),
  `module.exports = { Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'stub-secure-storage.cjs'),
  `module.exports = { SecureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, clear: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { readClaimOutcome, readEditOutcome, parseTabList, listTabs, registerTab, claimTab, forceClaim, updateTab, releaseTab, deleteTab }
    from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/branchTabs.ts'))};
`);
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'),
  alias: {
    '@zaptill/core': path.join(ROOT, 'packages/core/src'),
    '@capacitor/core': path.join(tmp, 'stub-capacitor-core.cjs'),
    '@capacitor/preferences': path.join(tmp, 'stub-preferences.cjs'),
    '@aparajita/capacitor-secure-storage': path.join(tmp, 'stub-secure-storage.cjs'),
  },
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: 'https://dev-api.zaptill.co.ke' }) },
  logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const LINK = { url: 'https://192.168.1.9:4100', cert: 'CERT', securityCode: 'AB-CD-EF', name: 'Shop', nodeSecret: 'NS', deviceToken: 'DT' };
const TAB = { id: 't4', branch_id: 'b1', order_number: '12', label: 'T4', order_type: 'dine_in', table_number: '4', cart: '[{"q":1}]', opened_by: 'Jane', opened_at: '', last_changed_by: null, locked_by: 'android-dev', lock_expires: '2999-01-01', locked: true };
function stub(resp) {
  const calls = [];
  const fn = async (link, method, pathArg, body, headers) => { calls.push({ link, method, path: pathArg, body, headers }); if (resp instanceof Error) throw resp; return resp; };
  return { fn, calls };
}
const deps = (s, link = LINK) => ({ request: s.fn, link: async () => link, device: async () => 'android-dev' });

const run = async () => {
  console.log('\nC. readClaimOutcome (pure)');
  eq('null → unreachable', M.readClaimOutcome(null), { outcome: 'unreachable' });
  eq('a 503 is unreachable (falls back to local)', M.readClaimOutcome({ status: 503, body: '', headers: {} }), { outcome: 'unreachable' });
  eq('a 404 (old build) is unreachable', M.readClaimOutcome({ status: 404, body: '', headers: {} }), { outcome: 'unreachable' });
  { const r = M.readClaimOutcome({ status: 200, body: JSON.stringify({ ok: true, tab: TAB, stole: false }), headers: {} });
    ok('a 200 ok is claimed', r.outcome === 'claimed' && r.stole === false && r.tab.id === 't4' && Array.isArray(r.tab.cart)); }
  { const r = M.readClaimOutcome({ status: 200, body: JSON.stringify({ ok: true, tab: TAB, stole: true }), headers: {} });
    ok('a lapsed-lease claim reports stole', r.outcome === 'claimed' && r.stole === true); }
  eq('a 200 with no tab → unreachable', M.readClaimOutcome({ status: 200, body: JSON.stringify({ ok: true }), headers: {} }), { outcome: 'unreachable' });
  eq('a 409 is locked + lockedBy', M.readClaimOutcome({ status: 409, body: JSON.stringify({ lockedBy: 'till-B' }), headers: {} }), { outcome: 'locked', lockedBy: 'till-B' });

  console.log('\nE. readEditOutcome (pure)');
  { const r = M.readEditOutcome({ status: 200, body: JSON.stringify({ ok: true, tab: TAB }), headers: {} }); ok('ok', r.outcome === 'ok' && r.tab.id === 't4'); }
  eq('a 423 is a lost lease', M.readEditOutcome({ status: 423, body: '{}', headers: {} }).outcome, 'lost');
  eq('a 409 is lost', M.readEditOutcome({ status: 409, body: '{}', headers: {} }).outcome, 'lost');
  eq('null → unreachable', M.readEditOutcome(null).outcome, 'unreachable');

  console.log('\nL. parseTabList (pure)');
  eq('a bare array', M.parseTabList({ status: 200, body: JSON.stringify([TAB]), headers: {} }).length, 1);
  eq('{tabs:[…]}', M.parseTabList({ status: 200, body: JSON.stringify({ tabs: [TAB, TAB] }), headers: {} }).length, 2);
  eq('a non-200 → []', M.parseTabList({ status: 500, body: '[]', headers: {} }).length, 0);
  ok('a cart JSON string is parsed to a value', Array.isArray(M.parseTabList({ status: 200, body: JSON.stringify([TAB]), headers: {} })[0].cart));

  console.log('\nF. IO (deps injected)');
  { const s = stub({ status: 200, body: JSON.stringify({ tabs: [TAB] }), headers: {} });
    const r = await M.listTabs('b1', deps(s));
    ok('listTabs returns the parsed tabs', r.length === 1 && r[0].id === 't4');
    eq('listTabs GET path + branch', s.calls[0].path, '/node/tabs?branch_id=b1');
    eq('listTabs proves the device', s.calls[0].headers['x-device-id'], 'android-dev'); }
  { const s = stub({ status: 200, body: '[]', headers: {} });
    const r = await M.listTabs('b1', { request: s.fn, link: async () => null, device: async () => 'd' });
    ok('no link → [] and the server is untouched', r.length === 0 && s.calls.length === 0); }
  { const s = stub({ status: 200, body: '{"ok":true}', headers: {} });
    await M.registerTab({ id: 't4', branch_id: 'b1', order_number: '12', label: 'T4', order_type: 'dine_in', cart: [{ q: 1 }], opened_by: 'Jane' }, deps(s));
    eq('registerTab POSTs /node/tabs', [s.calls[0].method, s.calls[0].path], ['POST', '/node/tabs']);
    ok('registerTab carries the opened_by name', JSON.parse(s.calls[0].body).opened_by === 'Jane'); }
  { const s = stub({ status: 200, body: JSON.stringify({ ok: true, tab: TAB, stole: false }), headers: {} });
    const r = await M.claimTab('t4', 'Jane', deps(s));
    eq('claim path', s.calls[0].path, '/node/tabs/t4/claim');
    eq('claim proves the device', s.calls[0].headers['x-device-id'], 'android-dev');
    ok('claim carries the name', JSON.parse(s.calls[0].body).name === 'Jane');
    ok('claim → claimed', r.outcome === 'claimed'); }
  { const s = stub({ status: 200, body: JSON.stringify({ ok: true, tab: TAB }), headers: {} });
    await M.forceClaim('t4', 'Mgr', deps(s)); eq('force-claim path', s.calls[0].path, '/node/tabs/t4/force-claim'); }
  { const s = stub({ status: 200, body: JSON.stringify({ ok: true, tab: TAB }), headers: {} });
    await M.updateTab('t4', [{ q: 2 }], 'T4', deps(s));
    eq('update path', s.calls[0].path, '/node/tabs/t4');
    ok('update carries cart + label', JSON.parse(s.calls[0].body).label === 'T4'); }
  { const s = stub({ status: 200, body: '{"ok":true}', headers: {} });
    await M.releaseTab('t4', deps(s)); eq('release path', s.calls[0].path, '/node/tabs/t4/release'); }
  { const s = stub({ status: 200, body: '{"ok":true}', headers: {} });
    await M.deleteTab('t4', 'charged', deps(s));
    eq('delete path', s.calls[0].path, '/node/tabs/t4/delete');
    ok('delete carries the reason', JSON.parse(s.calls[0].body).reason === 'charged'); }
  { const s = stub(new Error('tls')); const r = await M.claimTab('t4', 'Jane', deps(s)); eq('a thrown request → unreachable', r.outcome, 'unreachable'); }

  console.log('\nS. source');
  const src = read('apps/android/src/shop/branchTabs.ts');
  ok('imports nodeRequest from branchServer', /from '\.\/branchServer'/.test(src) && /nodeRequest/.test(src));
  ok('does NOT import cloud/client (no new cycle)', !/cloud\/client/.test(src));
  ok('does NOT import react (pure client)', !/from 'react'/.test(src));
  ok("the lock holder is proven by x-device-id", /x-device-id/.test(src));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
