// A410 — at a branch with a server, only the server talks to the cloud.
// Owner, 2026-10-05: "if its a branch other tills rely on that server why would it save to cloud for other the server
// should be the only till communicating with the cloud not other tills".
//
// RUNS the real compiled dist/main: the REAL branch server (nodeServer.startNodeServer, its access-code check and the
// /node/cloud gateway) on a real port, a stand-in cloud on another, and a peer's cloudFetch / syncEngine / update check
// going through it over real HTTP.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/branch-gateway.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - routeCloudRequest returning the cloud URL for a peer        → "a peer's cloud call goes to its branch server" fails
//   - nodeGateway passing X-Node-Secret on to the cloud            → "the access code stays on the branch" fails
//   - upstreamUrl allowing a path outside /api/                    → "not an open proxy" fails
//   - cloudFetch passing the server's own 401 back as a response   → "a wrong access code is no connection" fails
//   - syncFetch calling globalThis.fetch again                      → "the sync engine goes through it" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = path.join(here, '..', 'src', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a410-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.2', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {} } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const portOf = (s) => s.address().port;

// ── The stand-in cloud: records what reached it ─────────────────────────────
const seen = [];
const BIG = Buffer.alloc(3 * 1024 * 1024, 7);
const cloud = await listen((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/api/expired')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Invalid or expired token","code":"TOKEN_EXPIRED"}'); }
    if (req.url.startsWith('/api/big')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(BIG); }
    res.writeHead(201, { 'content-type': 'application/json', 'x-cloud': 'yes' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
});
const CLOUD = `http://127.0.0.1:${portOf(cloud)}`;

// ── The REAL branch server, in this process (its config is the node's) ─────
process.env.SWIFTPOS_NODE_PORT = String(40000 + Math.floor(Math.random() * 20000));
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: 'br-1', device_id: 'dev-NODE', device_role: 'node', terminal_code: 'T1', device_name: 'Server' });
const SECRET = C.ensureNodeSecret();
const N = require(path.join(dist, 'nodeServer.js'));
N.startNodeServer();
await new Promise((r) => setTimeout(r, 300));
const NODE = `http://127.0.0.1:${N.getNodePort()}`;

const G = require(path.join(dist, 'cloudGateway.js'));
const NG = require(path.join(dist, 'nodeGateway.js'));
const peer = { device_role: 'till', node_url: NODE, node_secret: SECRET, server_url: CLOUD };

console.log('\nWhere a request goes (pure)\n');
{
  const r = G.routeCloudRequest(`${CLOUD}/api/orders?x=1`, peer);
  ok('a peer\'s cloud call goes to its branch server, with the access code',
    r.viaNode && r.url === `${NODE}/node/cloud/api/orders?x=1` && r.headers['X-Node-Secret'] === SECRET, JSON.stringify(r));
  ok('the branch server itself and an office PC call the cloud',
    !G.routeCloudRequest(`${CLOUD}/api/x`, { ...peer, device_role: 'node' }).viaNode && !G.routeCloudRequest(`${CLOUD}/api/x`, { ...peer, device_role: 'office' }).viaNode);
  ok('a till with no branch server calls the cloud', !G.routeCloudRequest(`${CLOUD}/api/x`, { ...peer, node_url: '' }).viaNode);
  ok('a peer\'s own LAN calls and other hosts are left alone',
    !G.routeCloudRequest(`${NODE}/node/sync`, peer).viaNode && !G.routeCloudRequest('https://images.example/logo.png', peer).viaNode);
  ok('the update feed of a peer is the gateway, with the access code',
    JSON.stringify(G.cloudBaseFor(CLOUD + '/', peer)) === JSON.stringify({ base: `${NODE}/node/cloud`, headers: { 'X-Node-Secret': SECRET } }));
  ok('not an open proxy: only the cloud\'s /api/, no climbing out',
    NG.upstreamUrl('/node/cloud/api/orders?a=1', CLOUD) === `${CLOUD}/api/orders?a=1`
    && NG.upstreamUrl('/node/cloud/admin', CLOUD) === null && NG.upstreamUrl('/node/cloud/api/../admin', CLOUD) === null
    && NG.upstreamUrl('/node/cloud//evil.example/api/x', CLOUD) === null && NG.upstreamUrl('/node/cloud/api/x', '') === null);
}

console.log('\nThrough the real branch server\n');
{
  seen.length = 0;
  const res = await G.cloudFetch(`${CLOUD}/api/stations/st-1/categories?v=2`, {
    method: 'PUT', body: JSON.stringify({ category_ids: ['c1', 'c2'] }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-peer', 'X-Device-Id': 'dev-T2', 'X-Idempotency-Key': 'idem-9' },
  }, { cfg: peer });
  const body = await res.json();
  const got = seen[0];
  ok('the cloud gets the till\'s request as sent: method, path, query, body',
    got?.method === 'PUT' && got?.url === '/api/stations/st-1/categories?v=2' && got?.body === '{"category_ids":["c1","c2"]}', JSON.stringify(got));
  ok('…with the till\'s own token, device and idempotency key', got?.headers.authorization === 'Bearer tok-peer'
    && got?.headers['x-device-id'] === 'dev-T2' && got?.headers['x-idempotency-key'] === 'idem-9');
  ok('the access code stays on the branch (never sent to the cloud)', got && !('x-node-secret' in got.headers));
  ok('the answer comes back as the cloud gave it', res.status === 201 && body.ok === true && res.headers.get('x-cloud') === 'yes'
    && res.headers.get('x-node-gateway') === '1');
}
{
  const res = await G.cloudFetch(`${CLOUD}/api/expired`, { headers: { Authorization: 'Bearer old' } }, { cfg: peer });
  ok('the cloud\'s own 401 reaches the till as a 401 (so it renews its sign-in as before)', res.status === 401 && (await res.json()).code === 'TOKEN_EXPIRED');
}
{
  const res = await G.cloudFetch(`${CLOUD}/api/big`, {}, { cfg: peer });
  const buf = Buffer.from(await res.arrayBuffer());
  ok('a large download (an update) comes through whole', buf.length === BIG.length && buf.equals(BIG), String(buf.length));
}
{
  let threw = null;
  try { await G.cloudFetch(`${CLOUD}/api/x`, {}, { cfg: { ...peer, node_secret: 'wrong' }, log: () => {} }); } catch (e) { threw = e; }
  ok('a wrong access code is "no connection", never a refused sign-in', threw?.name === 'NodeRefusedError' && /fetch failed/.test(threw.message), String(threw));
}
{
  const r = await fetch(`${NODE}/node/cloud/admin/secret`, { headers: { 'X-Node-Secret': SECRET } });
  ok('the server refuses anything but the cloud API', r.status === 400);
  const r2 = await fetch(`${NODE}/node/cloud/api/x`);
  ok('…and anyone without the branch access code', r2.status === 401);
}

console.log('\nWhen something is down\n');
{
  let threw = null;
  seen.length = 0;
  try { await G.cloudFetch(`${CLOUD}/api/x`, {}, { cfg: { ...peer, node_url: 'http://127.0.0.1:1' } }); } catch (e) { threw = e; }
  ok('branch server unreachable → no connection (the till does NOT go round it)', threw !== null && seen.length === 0, String(threw));
}
{
  // The server is up but has no internet: point it at a dead cloud.
  C.saveDeviceConfig({ server_url: 'http://127.0.0.1:1' });
  seen.length = 0;
  let threw = null, direct = false;
  try { await G.cloudFetch(`${CLOUD}/api/orders`, { method: 'POST', body: '{}' }, { cfg: peer, fetch: async (u, i) => { if (String(u).startsWith(CLOUD)) direct = true; return fetch(u, i); } }); } catch (e) { threw = e; }
  ok('server without internet → "no connection" to the till, so the sale stays queued', threw?.name === 'UplinkDownError', String(threw));
  ok('…and the till did not call the cloud itself', !direct && seen.length === 0);
  C.saveDeviceConfig({ server_url: CLOUD });
}
{
  G._resetGatewayMemory();
  const old = await listen((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); });
  seen.length = 0;
  const logs = [];
  const res = await G.cloudFetch(`${CLOUD}/api/ping`, {}, { cfg: { ...peer, node_url: `http://127.0.0.1:${portOf(old)}` }, log: (l) => logs.push(l) });
  ok('a branch server on an older build (no gateway): the till calls the cloud itself, and says so',
    res.status === 201 && seen[0]?.url === '/api/ping' && /older build/.test(logs[0] ?? ''));
  old.close(); G._resetGatewayMemory();
}

console.log('\nThe till\'s callers\n');
{
  // The sync engine on a peer: its cloud calls go through the server.
  const E = require(path.join(dist, 'syncEngine.js'));
  const S = fs.readFileSync(path.join(src, 'syncEngine.ts'), 'utf8');
  ok('the sync engine goes through it (syncFetch → cloudFetch)', /function syncFetch[\s\S]{0,700}return cloudFetch\(url,/.test(S) && !/function syncFetch[\s\S]{0,700}globalThis\.fetch\(/.test(S));
  // Every remaining raw fetch( in main is not a cloud call.
  const offenders = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.ts'))) {
    if (['cloudGateway.ts', 'nodeGateway.ts', 'nodeClient.ts'].includes(f)) continue;
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/(?<![\w.])fetch\(\s*`?\$?\{?([^,\n]*)/g)) {
      const arg = m[1];
      if (/getCloudUrl|server_url|_serverUrl|serverUrl|cloud/i.test(arg)) {
        // The branch server's own uplink (it IS the server) and its sign-in broker are allowed.
        if (f === 'nodeServer.ts') continue;
        offenders.push(`${f}: fetch(${arg.slice(0, 60)}`);
      }
    }
  }
  ok('no till code calls the cloud with a raw fetch (all through cloudFetch)', offenders.length === 0, offenders.join(' | '));
  void E;
}
{
  const U = require(path.join(dist, 'autoUpdate.js'));
  const log = { feed: null, asks: [] };
  const updater = { setFeedURL(o) { log.feed = o; }, requestHeaders: null, async checkForUpdates() {} };
  await U.runUpdateCheck({
    updater, cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '1.0.1',
    fetch: async (u, i) => { log.asks.push(String(u)); return new Response('{"approvedVersion":"1.0.2"}', { status: 200 }); },
    route: (c) => G.cloudBaseFor(c, peer),
  });
  ok('an approved update downloads through the branch server, with the access code',
    log.feed?.url === `${NODE}/node/cloud/api/desktop-update/v/1.0.2/` && updater.requestHeaders?.['X-Node-Secret'] === SECRET
    && updater.requestHeaders?.Authorization === 'Bearer tok', JSON.stringify({ feed: log.feed, h: updater.requestHeaders }));
}

N.stopNodeServer(); cloud.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
