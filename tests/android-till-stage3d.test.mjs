/**
 * android-till-stage3d.test.mjs — ZapTill for Android, Till stage 3 Slice D: SESSION REFRESH through the branch server
 * (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3D.md). A joined Shop POS renews its session via the server
 * (POST /node/refresh[/ack], pinned TLS), which proxies the cloud's /api/auth/refresh[/ack]; the cloud's own forwarded
 * answer is used as-is, and only a transport-like problem (no answer / 404 / 503) falls back to a cloud-direct renewal.
 * This RUNS shop/branchRefresh.ts with the native BranchServer / link injected.
 *
 *   node --no-warnings tests/android-till-stage3d.test.mjs   (bundles apps/android/src with esbuild — Capacitor external)
 *
 * RUNS (the tested functions take injected deps, so no device is touched):
 *   R  readRefreshResult (pure): null / 404 / 503 → fallback; every other status → the cloud's forwarded answer.
 *   V  refreshViaServer: no link → fallback (server not called) · a 200/401 answer forwarded · the /ack path routes ·
 *      x-device-id sent but x-device-token NEVER · 503 and a thrown request → fallback.
 *   S  checked in source: branchRefresh never sends x-device-token and imports neither cloud/client nor tillSession;
 *      tillSession routes renew through refreshCall and exports the setter; ShopPos installs the router.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - readRefreshResult treating a 503 as an 'answer'                  → R "a 503 (node can't reach the cloud) falls back"
 *   - refreshViaServer sending x-device-token                          → V "the server key is never forwarded as the cloud's"
 *   - tillSession keeping the bare cloudPost('/auth/refresh')          → S "renew routes through refreshCall"
 *   - branchRefresh importing cloud/client                             → S "no import cycle"
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

// ── bundle the branchRefresh module (Capacitor external — the tested functions take injected deps) ────────────────────
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till3d-'));
// Capacitor and the Keystore are branchRefresh's native neighbours (pulled in through branchServer → tillSession →
// secrets). The tested functions take injected deps and never call them, so they are stubbed — the suite is hermetic and
// runs in CI's offline-suites job, which installs no Android deps and sets no NODE_PATH.
fs.writeFileSync(path.join(tmp, 'stub-capacitor-core.cjs'),
  `module.exports = { registerPlugin: () => ({}), CapacitorHttp: { request: async () => ({ status: 0, data: null }) }, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } };`);
fs.writeFileSync(path.join(tmp, 'stub-preferences.cjs'),
  `module.exports = { Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'stub-secure-storage.cjs'),
  `module.exports = { SecureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, clear: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { readRefreshResult, refreshViaServer }
    from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/branchRefresh.ts'))};
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
/** A stubbed nodeRequest-shaped dep: records (link, path, body, headers), returns `resp` (a NodeResponse or null). */
function refStub(resp) {
  const calls = [];
  const fn = async (link, p, body, headers) => { calls.push({ link, path: p, body, headers }); return resp; };
  return { fn, calls };
}
const tokens = (access, refresh) => JSON.stringify({ accessToken: access, refreshToken: refresh, ack: true });

const run = async () => {

  console.log('\nR. readRefreshResult (pure)');
  eq('no answer (null) → fallback', M.readRefreshResult(null).via, 'fallback');
  eq('a 404 (old build, no route) → fallback', M.readRefreshResult({ status: 404, headers: {}, body: 'not found' }).via, 'fallback');
  eq('a 503 (node can’t reach the cloud) falls back', M.readRefreshResult({ status: 503, headers: {}, body: JSON.stringify({ error: 'node cannot reach the cloud right now' }) }).via, 'fallback');
  {
    const r = M.readRefreshResult({ status: 200, headers: {}, body: tokens('AT2', 'RT2') });
    ok('a 200 is the cloud’s forwarded answer', r.via === 'answer' && r.status === 200);
    eq('a 200 carries the new tokens', r.data, { accessToken: 'AT2', refreshToken: 'RT2', ack: true });
  }
  {
    const r = M.readRefreshResult({ status: 401, headers: {}, body: JSON.stringify({ error: 'refresh token revoked', code: 'TOKEN_REVOKED' }) });
    ok('a 401 is forwarded as the cloud’s own (drives signBackIn)', r.via === 'answer' && r.status === 401);
    eq('a 401 carries the cloud’s error/code', r.data, { error: 'refresh token revoked', code: 'TOKEN_REVOKED' });
  }
  eq('a 429 (cloud throttle, forwarded) is an answer', M.readRefreshResult({ status: 429, headers: {}, body: '{}' }).via, 'answer');
  eq('a 200 with an unreadable body is still an answer (data {})', M.readRefreshResult({ status: 200, headers: {}, body: 'not json' }).via, 'answer');

  console.log('\nV. refreshViaServer (deps injected)');
  {
    const s = refStub({ status: 200, headers: {}, body: tokens('AT', 'RT') });
    const r = await M.refreshViaServer('/node/refresh', 'RT0', 'android-dev', { link: async () => null, request: s.fn });
    eq('no link → fallback', r.via, 'fallback');
    ok('no link → the server is not called', s.calls.length === 0);
  }
  {
    const s = refStub({ status: 200, headers: {}, body: tokens('AT', 'RT') });
    const r = await M.refreshViaServer('/node/refresh', 'RT0', 'android-dev', { link: async () => LINK, request: s.fn });
    ok('a 200 from the server → answer with the cloud’s tokens', r.via === 'answer' && r.data.accessToken === 'AT');
    eq('routed to /node/refresh', s.calls[0].path, '/node/refresh');
    eq('the body carries the refresh token', JSON.parse(s.calls[0].body), { refreshToken: 'RT0' });
    ok('x-device-id is sent', s.calls[0].headers['x-device-id'] === 'android-dev');
    ok('x-device-token is NEVER forwarded as the cloud’s (F7)', !('x-device-token' in s.calls[0].headers) && !('X-Device-Token' in s.calls[0].headers));
  }
  {
    const s = refStub({ status: 200, headers: {}, body: '{}' });
    await M.refreshViaServer('/node/refresh/ack', 'RTnew', 'd', { link: async () => LINK, request: s.fn });
    eq('the ack routes to /node/refresh/ack', s.calls[0].path, '/node/refresh/ack');
  }
  {
    const s = refStub({ status: 503, headers: {}, body: JSON.stringify({ error: 'node cannot reach the cloud right now' }) });
    const r = await M.refreshViaServer('/node/refresh', 'RT0', 'd', { link: async () => LINK, request: s.fn });
    eq('a 503 from the server → fallback (renew cloud-direct)', r.via, 'fallback');
    ok('503: the server WAS tried once', s.calls.length === 1);
  }
  {
    const s = refStub(null);   // nodeRequest returns null when the server did not answer / its identity changed
    const r = await M.refreshViaServer('/node/refresh', 'RT0', 'd', { link: async () => LINK, request: s.fn });
    eq('an unreachable server (null) → fallback', r.via, 'fallback');
  }

  console.log('\nS. checked in source');
  {
    const src = read('apps/android/src/shop/branchRefresh.ts');
    ok('POSTs to the /node/refresh route', src.includes("'/node/refresh'"));
    ok('reuses branchServer’s pinned-TLS nodeRequest', src.includes("from './branchServer'") && src.includes('nodeRequest'));
    ok('sends x-device-id', src.includes("'x-device-id'"));
    ok('NEVER sends x-device-token as a header key (F7)', !/['"]x-device-token['"]/i.test(src));
    ok('does not import cloud/client (no import cycle)', !/\bfrom\s+['"][^'"]*cloud\/client['"]/.test(src) && !/\bimport\(\s*['"][^'"]*cloud\/client/.test(src));
    ok('does not import tillSession (the setter breaks the cycle)', !/\bfrom\s+['"][^'"]*\.\/tillSession['"]/.test(src));

    const till = read('apps/android/src/shop/tillSession.ts');
    ok('tillSession exports setServerRefresh', /export function setServerRefresh/.test(till));
    ok('renew routes through refreshCall, not a bare cloudPost', /refreshCall\(\s*['"]\/auth\/refresh['"]/.test(till) && !/cloudPost<RenewAnswer>\(\s*['"]\/auth\/refresh['"]/.test(till));
    ok('tillSession does NOT import branchRefresh (setter injection)', !/from\s+['"][^'"]*branchRefresh['"]/.test(till));

    const shop = read('apps/android/src/screens/shop/ShopPos.tsx');
    ok('ShopPos installs the router (setServerRefresh(refreshViaServer))', shop.includes('setServerRefresh(refreshViaServer)'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
};
run();
