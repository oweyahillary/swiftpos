/**
 * android-till-stage3.test.mjs — ZapTill for Android, Till stage 3 Slice A: the branch-server GATEWAY
 * (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3A.md). A joined Shop POS sends its cloud calls THROUGH the branch
 * server (`<server>/node/cloud/api/…`, A410) over pinned TLS, and falls back to its own cloud (preference, not lock-in)
 * on any server problem. This RUNS shop/branchGateway.ts with the native BranchServer / link / device injected.
 *
 *   node --no-warnings tests/android-till-stage3.test.mjs   (bundles apps/android/src with esbuild — Capacitor external)
 *
 * RUNS (the tested functions take injectable deps, so no device is touched):
 *   G  readGatewayVia (pure): the gateway mark vs an old server's 404 vs a down uplink vs a refusal.
 *   T  gatewayTarget (pure): the `<server>/node/cloud` + /api path; a non-cloud URL is left alone.
 *   H  readServerHealth (pure): protocol parse, "this POS too old" / "server too old".
 *   F  gatewayFetch: none (no link / bad method / non-cloud) · gateway forward · uplink-down · old-server · refusal ·
 *      a thrown request → unreachable · the down-memo skips a known-down server, then re-probes after the window.
 *   C  checkServerHealth: parses /node/health, blocks routing when this POS is too old, clears the down-memo.
 *   S  checked in source: the gateway prefix, the X-Node-Secret header, the import of the saved ServerLink.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - readGatewayVia treating a 404 WITHOUT the mark as 'gateway'   → G "no mark + 404 is an old server"
 *   - gatewayFetch routing a PATCH                                  → F "a non GET/POST is left to the cloud"
 *   - gatewayFetch not marking a thrown server down                → F "a known-down server is skipped (no second call)"
 *   - gatewayFetch routing when this POS is older than the server   → C "too-old POS does not route through the gateway"
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

// ── bundle the gateway module (Capacitor external — the tested functions take injected deps) ──────────────────────────
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till3-'));
// Capacitor and the Keystore are the branch gateway's native neighbours (pulled in through branchServer → tillSession →
// secrets). The tested functions take injected deps and never call them, so they are stubbed here — the suite is then
// hermetic: it runs in CI's offline-suites job, which installs no Android deps and sets no NODE_PATH.
fs.writeFileSync(path.join(tmp, 'stub-capacitor-core.cjs'),
  `module.exports = { registerPlugin: () => ({}), CapacitorHttp: { request: async () => ({ status: 0, data: null }) }, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } };`);
fs.writeFileSync(path.join(tmp, 'stub-preferences.cjs'),
  `module.exports = { Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'stub-secure-storage.cjs'),
  `module.exports = { SecureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, clear: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { readGatewayVia, gatewayTarget, readServerHealth, gatewayFetch, checkServerHealth, serverHealth,
           gatewayBlockedByProtocol, lastGatewayState, noteServerReachable, TILL_PROTOCOL, _resetBranchGateway }
    from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/branchGateway.ts'))};
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

const BASE = 'https://dev-api.zaptill.co.ke';
const LINK = { url: 'https://192.168.1.9:4100', cert: 'CERT', securityCode: 'AB-CD-EF', name: 'Shop', nodeSecret: 'NS', deviceToken: 'DT' };
/** A stubbed BranchServer.request: records calls, returns `resp` (or throws when it is an Error). */
function stub(resp) {
  const calls = [];
  const fn = async (o) => { calls.push(o); if (resp instanceof Error) throw resp; return resp; };
  return { fn, calls };
}
const depsWith = (reqStub, link = LINK) => ({ request: reqStub.fn, link: async () => link, device: async () => 'android-dev' });

const run = async () => {

  console.log('\nG. readGatewayVia (pure)');
  eq('a forwarded answer has the gateway mark', M.readGatewayVia(200, { 'x-node-gateway': '1' }), 'gateway');
  eq('no mark + 404 is an old server', M.readGatewayVia(404, {}), 'old-server');
  eq('no mark + 401 is a refusal', M.readGatewayVia(401, {}), 'server-refused');
  eq('the uplink-down mark wins over a status', M.readGatewayVia(502, { 'x-node-uplink': 'down' }), 'uplink-down');

  console.log('\nT. gatewayTarget (pure)');
  eq('a cloud call becomes the gateway address', M.gatewayTarget(LINK.url, `${BASE}/api/orders?x=1`),
    'https://192.168.1.9:4100/node/cloud/api/orders?x=1');
  eq('a trailing slash on the server url is trimmed', M.gatewayTarget('https://192.168.1.9:4100/', `${BASE}/api/tables`),
    'https://192.168.1.9:4100/node/cloud/api/tables');
  eq('a non-cloud URL is left alone', M.gatewayTarget(LINK.url, 'https://example.com/api/x'), null);

  console.log('\nH. readServerHealth (pure)');
  eq('a server before A501 reports no protocol → 1', M.readServerHealth({}).protocol, 1);
  {
    const h = M.readServerHealth({ protocol: 2, min_till_protocol: 1, capabilities: ['gateway', 'cursors'] });
    ok('a matching server is fine', !h.tooOldForServer && !h.serverTooOld && h.capabilities.length === 2);
    const older = M.readServerHealth({ protocol: 2, min_till_protocol: 9 });
    ok('a server needing a newer POS flags tooOldForServer', older.tooOldForServer === true);
    const old = M.readServerHealth({ protocol: 1, min_till_protocol: 1 });
    ok('an older server flags serverTooOld', old.serverTooOld === true);
  }

  console.log('\nF. gatewayFetch (deps injected)');
  {
    M._resetBranchGateway();
    const s = stub({ status: 200, headers: {}, body: '' });
    eq('no ServerLink → none', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, { request: s.fn, link: async () => null, device: async () => 'd' })).via, 'none');
    ok('none does not call the server', s.calls.length === 0);

    eq('a non GET/POST is left to the cloud', (await M.gatewayFetch(`${BASE}/api/pumps/1/activate`, 'PATCH', '{}', {}, 1000, depsWith(s))).via, 'none');
    eq('a non-cloud URL is left to the caller', (await M.gatewayFetch('https://example.com/x', 'GET', undefined, {}, 1000, depsWith(s))).via, 'none');
    ok('neither touched the server', s.calls.length === 0);
  }
  {
    M._resetBranchGateway();
    const s = stub({ status: 200, headers: { 'x-node-gateway': '1' }, body: '{"ok":true}' });
    const r = await M.gatewayFetch(`${BASE}/api/orders?x=1`, 'POST', '{"a":1}', { Authorization: 'Bearer TK' }, 1000, depsWith(s));
    eq('gateway: via', r.via, 'gateway');
    eq('gateway: status forwarded', r.status, 200);
    eq('gateway: body forwarded', r.body, '{"ok":true}');
    const sent = s.calls[0];
    eq('gateway: target url', sent.url, 'https://192.168.1.9:4100/node/cloud/api/orders?x=1');
    eq('gateway: branch access code sent', sent.headers['X-Node-Secret'], 'NS');
    eq('gateway: the caller Authorization is forwarded', sent.headers.Authorization, 'Bearer TK');
    eq('gateway: device id + token sent', [sent.headers['x-device-id'], sent.headers['x-device-token']], ['android-dev', 'DT']);
    eq('gateway: the body is passed through', sent.body, '{"a":1}');
  }
  {
    M._resetBranchGateway();
    const s = stub({ status: 502, headers: { 'x-node-uplink': 'down' }, body: '' });
    eq('the server with no internet → uplink-down', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, depsWith(s))).via, 'uplink-down');

    M._resetBranchGateway();
    const o = stub({ status: 404, headers: {}, body: 'not found' });
    eq('an old server with no gateway → old-server', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, depsWith(o))).via, 'old-server');

    M._resetBranchGateway();
    const ref = stub({ status: 401, headers: {}, body: '{"error":"X-Node-Secret"}' });
    eq('a wrong access code → server-refused', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, depsWith(ref))).via, 'server-refused');
  }
  {
    // A thrown request marks the server down; the next call is skipped until the window passes, then re-probed.
    M._resetBranchGateway();
    const dead = stub(new Error('UNREACHABLE'));
    eq('a thrown request → server-unreachable', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, depsWith(dead))).via, 'server-unreachable');
    const good = stub({ status: 200, headers: { 'x-node-gateway': '1' }, body: '{}' });
    const r2 = await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 2000, depsWith(good));
    ok('a known-down server is skipped (no second call)', r2.via === 'server-unreachable' && good.calls.length === 0);
    const r3 = await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000 + 60001, depsWith(good));
    ok('after the window the server is tried again', r3.via === 'gateway' && good.calls.length === 1);
  }

  console.log('\nC. checkServerHealth (deps injected)');
  {
    M._resetBranchGateway();
    const h = stub({ status: 200, headers: {}, body: JSON.stringify({ protocol: 2, min_till_protocol: 1, capabilities: ['gateway'] }) });
    const got = await M.checkServerHealth(1000, { request: h.fn, link: async () => LINK });
    eq('health is read from /node/health', [got.protocol, got.minTillProtocol], [2, 1]);
    eq('the probe hit /node/health', h.calls[0].url, 'https://192.168.1.9:4100/node/health');
    ok('serverHealth() now set', M.serverHealth() && M.serverHealth().protocol === 2);
  }
  {
    // A server that needs a newer POS blocks routing: gatewayFetch returns none even with a good link.
    M._resetBranchGateway();
    const h = stub({ status: 200, headers: {}, body: JSON.stringify({ protocol: 3, min_till_protocol: 9 }) });
    await M.checkServerHealth(1000, { request: h.fn, link: async () => LINK });
    ok('gatewayBlockedByProtocol is true', M.gatewayBlockedByProtocol() === true);
    const s = stub({ status: 200, headers: { 'x-node-gateway': '1' }, body: '{}' });
    eq('too-old POS does not route through the gateway', (await M.gatewayFetch(`${BASE}/api/orders`, 'POST', '{}', {}, 1000, depsWith(s))).via, 'none');
    ok('and never called the server', s.calls.length === 0);
  }

  console.log('\nS. checked in source');
  {
    const src = read('apps/android/src/shop/branchGateway.ts');
    ok('routes to the /node/cloud gateway prefix', src.includes("'/node/cloud'"));
    ok('sends the branch access code header', src.includes("'X-Node-Secret'"));
    ok('reuses the saved ServerLink (branchServer.ts)', src.includes("from './branchServer'") && src.includes('readServerLink'));
    ok('A410 is a preference (cloud fallback documented)', /preference/i.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
};
run();
