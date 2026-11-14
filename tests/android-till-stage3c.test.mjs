/**
 * android-till-stage3c.test.mjs — ZapTill for Android, Till stage 3 Slice C: the branch-server PIN VERIFY
 * (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3C.md). A joined Shop POS checks a sign-in PIN at the branch server
 * (POST /node/verify-pin, over pinned TLS) FIRST — the LAN roster is the authority. A 'no' (401) is FINAL; any other
 * problem (server down, old build, a throttle, no server joined) falls back to the cloud, then to the Stage-2 offline
 * bcrypt check. This RUNS shop/branchPin.ts with the native BranchServer request / link / device injected.
 *
 *   node --no-warnings tests/android-till-stage3c.test.mjs   (bundles apps/android/src with esbuild — Capacitor external)
 *
 * RUNS (the tested functions take injectable deps, so no device is touched):
 *   V  readPinVerdict (pure): no answer · 200 → a session built from {staff} (tokenless — the till token carries writes) ·
 *      a 200 we cannot use → fallback · 401 → a final refusal with the node's words · 503/429/404 → fallback.
 *   R  verifyPinAtServer (deps injected): no link → fallback without a call · a 200 → session, with branch_id/pin + the
 *      device proof sent · a 401 → refused · a null (unreachable) answer → fallback.
 *   S  checked in source: POSTs /node/verify-pin, reuses branchServer's nodeRequest, does NOT import cloud/client (the
 *      cycle the build sheet warns of); PinScreen tries the server first and treats a refusal as final.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - readPinVerdict treating a 503 as 'refused'                      → V "a 503 (node busy / no roster) falls back"
 *   - readPinVerdict falling back on a 401 instead of refusing        → V "a 401 is a FINAL refusal"
 *   - verifyPinAtServer calling the server when no link is saved      → R "no link → fallback, the server is not called"
 *   - branchPin importing cloud/client                                → S "does not import cloud/client (no import cycle)"
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

// ── bundle the branchPin module (Capacitor external — the tested functions take injected deps) ────────────────────────
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till3c-'));
// Capacitor and the Keystore are branchPin's native neighbours (pulled in through branchServer → tillSession → secrets).
// The tested functions take injected deps and never call them, so they are stubbed — the suite is hermetic and runs in
// CI's offline-suites job, which installs no Android deps and sets no NODE_PATH.
fs.writeFileSync(path.join(tmp, 'stub-capacitor-core.cjs'),
  `module.exports = { registerPlugin: () => ({}), CapacitorHttp: { request: async () => ({ status: 0, data: null }) }, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } };`);
fs.writeFileSync(path.join(tmp, 'stub-preferences.cjs'),
  `module.exports = { Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'stub-secure-storage.cjs'),
  `module.exports = { SecureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, clear: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { readPinVerdict, verifyPinAtServer }
    from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/branchPin.ts'))};
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
const TILL = { branchId: 'br-1', branchName: 'Westlands', businessType: 'restaurant', currency: 'KES' };
/** A stubbed nodeRequest-shaped dep: records (link, body, headers), returns `resp` (a NodeResponse or null). */
function pinStub(resp) {
  const calls = [];
  const fn = async (link, body, headers) => { calls.push({ link, body, headers }); return resp; };
  return { fn, calls };
}
const okBody = (staff) => JSON.stringify({ ok: true, staff });

const run = async () => {

  console.log('\nV. readPinVerdict (pure)');
  eq('no answer (null) → fallback', M.readPinVerdict(null, TILL).outcome, 'fallback');
  {
    const r = M.readPinVerdict({ status: 200, headers: {}, body: okBody({ staffId: 's1', name: 'Ann', roleName: 'Cashier', permissions: { 'sales.refund': true } }) }, TILL);
    ok('a 200 with a staff is a session', r.outcome === 'session');
    eq('session: staffId', r.session.staffId, 's1');
    eq('session: staffName', r.session.staffName, 'Ann');
    eq('session: role', r.session.role, 'Cashier');
    eq('session: permissions carried', r.session.permissions, { 'sales.refund': true });
    eq('session: tokenless (the till token carries writes)', r.session.token, '');
    eq('session: branch from the till', r.session.branchId, 'br-1');
  }
  eq('a 200 with no staff → fallback', M.readPinVerdict({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) }, TILL).outcome, 'fallback');
  eq('a 200 that is ok:false → fallback', M.readPinVerdict({ status: 200, headers: {}, body: JSON.stringify({ ok: false }) }, TILL).outcome, 'fallback');
  eq('a 200 with unreadable body → fallback', M.readPinVerdict({ status: 200, headers: {}, body: 'not json' }, TILL).outcome, 'fallback');
  {
    const r = M.readPinVerdict({ status: 401, headers: {}, body: JSON.stringify({ ok: false, error: 'This PIN is shared by more than one staff member. Ask a manager to reset it.' }) }, TILL);
    ok('a 401 is a FINAL refusal', r.outcome === 'refused');
    eq('a 401 carries the node’s words', r.words, 'This PIN is shared by more than one staff member. Ask a manager to reset it.');
  }
  {
    const r = M.readPinVerdict({ status: 401, headers: {}, body: '' }, TILL);
    ok('a 401 with no body still refuses', r.outcome === 'refused');
    eq('a bodyless 401 uses the default words', r.words, 'That PIN is not right.');
  }
  eq('a 503 (node busy / no roster) falls back', M.readPinVerdict({ status: 503, headers: {}, body: JSON.stringify({ reason: 'unavailable' }) }, TILL).outcome, 'fallback');
  eq('a 429 (throttle) falls back', M.readPinVerdict({ status: 429, headers: {}, body: JSON.stringify({ reason: 'rate_limited' }) }, TILL).outcome, 'fallback');
  eq('a 404 (old build, no route) falls back', M.readPinVerdict({ status: 404, headers: {}, body: 'not found' }, TILL).outcome, 'fallback');

  console.log('\nR. verifyPinAtServer (deps injected)');
  {
    const s = pinStub({ status: 200, headers: {}, body: okBody({ staffId: 'x', name: 'X' }) });
    const r = await M.verifyPinAtServer('1234', TILL, { link: async () => null, request: s.fn, device: async () => 'android-dev' });
    eq('no link → fallback', r.outcome, 'fallback');
    ok('no link → the server is not called', s.calls.length === 0);
  }
  {
    const s = pinStub({ status: 200, headers: {}, body: okBody({ staffId: 's2', name: 'Bob', roleName: 'Manager' }) });
    const r = await M.verifyPinAtServer('4321', TILL, { link: async () => LINK, request: s.fn, device: async () => 'android-dev' });
    ok('a 200 from the server → session', r.outcome === 'session' && r.session.staffId === 's2' && r.session.role === 'Manager');
    eq('the body carries branch_id + pin', JSON.parse(s.calls[0].body), { branch_id: 'br-1', pin: '4321' });
    eq('this POS proves which it is (device id + token)', [s.calls[0].headers['x-device-id'], s.calls[0].headers['x-device-token']], ['android-dev', 'DT']);
  }
  {
    const s = pinStub({ status: 401, headers: {}, body: JSON.stringify({ ok: false, error: 'Invalid PIN' }) });
    const r = await M.verifyPinAtServer('0000', TILL, { link: async () => LINK, request: s.fn, device: async () => 'd' });
    ok('a 401 from the server → refused (final)', r.outcome === 'refused' && r.words === 'Invalid PIN');
  }
  {
    const s = pinStub(null);   // nodeRequest returns null when the server did not answer / its identity changed
    const r = await M.verifyPinAtServer('1234', TILL, { link: async () => LINK, request: s.fn, device: async () => 'd' });
    eq('an unreachable server (null) → fallback', r.outcome, 'fallback');
    ok('unreachable: the server WAS tried once', s.calls.length === 1);
  }

  console.log('\nS. checked in source');
  {
    const src = read('apps/android/src/shop/branchPin.ts');
    ok('POSTs to the /node/verify-pin route', src.includes("'/node/verify-pin'"));
    ok('reuses branchServer’s pinned-TLS nodeRequest', src.includes("from './branchServer'") && src.includes('nodeRequest'));
    ok('does not import cloud/client (no import cycle)', !/\bfrom\s+['"][^'"]*cloud\/client['"]/.test(src) && !/\bimport\(\s*['"][^'"]*cloud\/client/.test(src));
    ok('a 401 is handled as a final refusal', /401[\s\S]{0,400}refused/.test(src));

    const pin = read('apps/android/src/screens/shop/PinScreen.tsx');
    ok('PinScreen tries the branch server first', pin.includes('verifyPinAtServer'));
    ok('PinScreen treats a server refusal as final (PinRefused)', pin.includes('PinRefused'));
    ok('a joined POS can sign in offline with no cached roster', pin.includes('!hasLink'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
};
run();
