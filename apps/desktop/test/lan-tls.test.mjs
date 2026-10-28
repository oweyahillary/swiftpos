// A489 — the branch server and its tills talk over TLS on the shop network, the till pinning the server's certificate.
// Owner, 2026-10-14 (branch server audit, decision on item 2): mitigations in phase 1, then TLS in its own release,
// keeping the old http path during the move.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json --force && node test/lan-tls.test.mjs
//
// RUNS the real compiled dist/main: the REAL branch server (startNodeServer) on a real port, then the same process as a
// till pointed at it — lanFetch, ensureNodeTls, probeNode, cloudFetch through the gateway — over real TCP and TLS.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - lanFetch falling back to plain fetch on a NodeIdentityError       → "never falls back to plain" fails
//   - pinnedFetch resolving before the answer is read                   → the run stalls / crashes (connection pool)
//   - the sniffer sending every connection to the plain server          → "TLS on the same port" crashes the run
//   - ensureNodeTls pinning without the encrypted health check          → "a server that refuses the code is not pinned" fails
//   - CERT_NOT_BEFORE back to "now - 1 day"                             → "valid from 2020" fails
//   - ensureNodeTls forgetting the pin on a mismatch by itself          → "the tick does not quietly trust" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import tls from 'node:tls';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a489-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.15', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true }, session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

process.env.SWIFTPOS_NODE_PORT = String(40000 + Math.floor(Math.random() * 20000));   // before nodeServer reads it
const T = require(path.join(dist, 'lanTls.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const N = require(path.join(dist, 'nodeServer.js'));
const NC = require(path.join(dist, 'nodeClient.js'));
const G = require(path.join(dist, 'cloudGateway.js'));
const { getLocalDb } = require(path.join(dist, 'localDb.js'));

// Every plain fetch this process makes, by URL — the proof of which requests did NOT go over TLS.
const realFetch = globalThis.fetch;
let plainCalls = [];
globalThis.fetch = (url, init) => { plainCalls.push(String(url)); return realFetch(url, init); };

console.log('\nThe branch server\'s certificate\n');
{
  const a = T.makeServerIdentity();
  const x = new crypto.X509Certificate(a.cert);
  const key = crypto.createPrivateKey(a.key);
  ok('a real X.509 certificate: parses, signed by its own key, the key is the certificate\'s',
    x.verify(x.publicKey) && x.checkPrivateKey(key) && x.subject.includes('ZapTill branch server'), x.subject);
  ok('valid from 2020 (a till with a wrong clock still trusts it) for 20 years',
    Date.parse(x.validFrom) === Date.UTC(2020, 0, 1) && Date.parse(x.validTo) - Date.now() > 19.9 * 365 * 86_400_000, `${x.validFrom} → ${x.validTo}`);
  ok('its own trust anchor (CA:TRUE) — the till pins it, no public CA is involved', x.ca === true);
  const b = T.makeServerIdentity();
  ok('a security code a person can compare: 12 hex digits in threes, different per server',
    /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(T.securityCode(a.cert)) && T.securityCode(a.cert) !== T.securityCode(b.cert), T.securityCode(a.cert));
  // A596: a 0x00-led serial (1 in ~256 before) made OpenSSL refuse the certificate — "illegal padding".
  let refused = 0;
  for (let i = 0; i < 2000; i++) { const id = T.makeServerIdentity(); try { tls.createSecureContext({ cert: id.cert, key: id.key }); } catch { refused++; } }
  ok('every certificate it makes loads into TLS (2,000 made, none refused)', refused === 0, `${refused} refused`);
  ok('anything that is not a certificate has no code and cannot be pinned',
    T.securityCode('nope') === null && T.securityCode(null) === null && !!(await rejects(Promise.resolve().then(() => T.setTillPin('nope')))));
}

// ── The REAL branch server ─────────────────────────────────────────────────────────────────────────────────────────
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1', device_id: 'dev-SRV', device_role: 'node', terminal_code: 'T1', device_name: 'Back office' });
const SECRET = C.ensureNodeSecret();
N.startNodeServer();
await new Promise((r) => setTimeout(r, 300));
const PORT = N.getNodePort();
const NODE = `http://127.0.0.1:${PORT}`;
// A496: /node/tech-session (this test's echo route) answers only a till that proves which it is, and holds only a real
// tech token — so this test's requests carry a joined device's key, and its tokens are signed by the tech key the server
// holds. Same meaning as before: the bytes go up and come back over TLS.
const NI = require(path.join(dist, 'nodeIngest.js'));
const H = { 'X-Node-Secret': SECRET, 'X-Device-Id': 'dev-LT', 'X-Device-Token': NI.issueDeviceKey('dev-LT') };
const techKeys = crypto.generateKeyPairSync('ed25519');
require(path.join(dist, 'techService.js')).cacheTechConfig(techKeys.publicKey.export({ type: 'spki', format: 'pem' }), null);
const techToken = (extra = {}) => {
  const payload = Buffer.from(JSON.stringify({ techId: 't1', techName: 'Tech', branchId: 'br-1', businessId: 'b1', scope: 'all', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra })).toString('base64url');
  return `st2.${payload}.${crypto.sign(null, Buffer.from(payload), techKeys.privateKey).toString('base64url')}`;
};

console.log('\nOne port, both protocols\n');
let CERT;
{
  const r = await realFetch(`${NODE}/node/tls`);
  const b = await r.json();
  CERT = b.cert;
  ok('GET /node/tls hands out the certificate with no access code (it is public) and its code',
    r.status === 200 && T.certDer(CERT) && b.code === T.securityCode(CERT) && b.code === T.serverSecurityCode(), JSON.stringify(b).slice(0, 80));
  ok('plain HTTP still works on the same port — a till on an older build keeps trading',
    (await realFetch(`${NODE}/node/health`, { headers: H })).status === 200);
  const t = await T.pinnedFetch(`${NODE}/node/health`, { headers: H }, CERT);
  const tb = await t.json();
  ok('TLS on the same port, to the same routes (http:// in the address is sent as https://)', t.status === 200 && tb.ok === true && tb.role === 'node', JSON.stringify(tb));
  ok('…and the access code is still required over TLS', (await T.pinnedFetch(`${NODE}/node/health`, {}, CERT)).status === 401);
  const e = await rejects(realFetch(`https://127.0.0.1:${PORT}/node/health`, { headers: H }));
  ok('nothing but the pin trusts it: the system\'s own trust refuses the certificate', !!e, String(e?.cause?.code ?? e));
  N.stopNodeServer(); N.startNodeServer(); await new Promise((r) => setTimeout(r, 300));
  const again = await (await realFetch(`http://127.0.0.1:${N.getNodePort()}/node/tls`)).json();
  ok('the certificate is kept: a restarted server hands out the same one (its tills stay pinned)', again.cert === CERT);
}

console.log('\nThe pinned client\n');
{
  const other = T.makeServerIdentity().cert;
  const leak = techToken({ techName: 'LEAK-' + crypto.randomBytes(4).toString('hex') });
  const e = await rejects(T.pinnedFetch(`${NODE}/node/tech-session`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: leak }) }, other));
  ok('another certificate is refused before anything is sent (NodeIdentityError)', e?.name === 'NodeIdentityError', String(e));
  const held = await (await realFetch(`${NODE}/node/tech-session`, { headers: H })).json();
  ok('…the request never reached the server', held.token !== leak, JSON.stringify(held));
  const big = techToken({ pad: 'x'.repeat(300_000) });
  await T.pinnedFetch(`${NODE}/node/tech-session`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: big }) }, CERT);
  const back = await (await T.pinnedFetch(`${NODE}/node/tech-session`, { headers: H }, CERT)).json();
  ok('a 300 KB body goes up and comes back whole over TLS', back.token === big, String(back.token?.length));
  const BYTES = techToken({ techName: 'bytes' });
  const u8 = await (await T.pinnedFetch(`${NODE}/node/tech-session`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ token: BYTES })) }, CERT)).json();
  ok('a body given as bytes is sent as is', u8.ok === true && (await (await T.pinnedFetch(`${NODE}/node/tech-session`, { headers: H }, CERT)).json()).token === BYTES);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await T.pinnedFetch(`${NODE}/node/health`, { headers: H, signal: AbortSignal.timeout(3000) }, CERT);
  ok('twenty answers nobody reads do not stall the connection pool', Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);
  const ab = await rejects(T.pinnedFetch(`${NODE}/node/health`, { headers: H, signal: AbortSignal.abort() }, CERT));
  ok('an aborted request rejects as aborted (callers already treat that as no connection)', ab?.name === 'AbortError', String(ab?.name));
  const down = await rejects(T.pinnedFetch('http://127.0.0.1:9/node/health', { headers: H, signal: AbortSignal.timeout(3000) }, CERT));
  ok('no server at all is "fetch failed" — the same as fetch, never an identity problem', down instanceof TypeError && down.name !== 'NodeIdentityError', String(down));
  const head = await T.pinnedFetch(`${NODE}/node/health`, { headers: H }, CERT);
  ok('answers keep their headers', head.headers.get('content-type') === 'application/json');
}

// ── The same process as a till of that server ──────────────────────────────────────────────────────────────────────
C.saveDeviceConfig({ device_role: 'till', device_id: 'dev-TILL', node_url: NODE, node_secret: SECRET });
T._resetLanTls(); T.setTillPin(null);
NC.setNodeDeviceToken(NI.issueDeviceKey('dev-TILL'));   // A496: a till that joined (its /node/since needs its key)

console.log('\nA till already joined switches by itself\n');
{
  ok('before: not pinned, plain — as every till is today', T.tillPin() === null && T.nodeTlsStatus().state === 'plain', JSON.stringify(T.nodeTlsStatus()));
  plainCalls = [];
  ok('…its requests to the server go plain', await NC.isNodeReachable() === true && plainCalls.some((u) => u.startsWith(`${NODE}/node/health`)), plainCalls.join(','));
  const st = await T.ensureNodeTls(() => NC.nodeHeaders());
  ok('the first tick pins the server\'s certificate (after an encrypted health check with its access code)',
    st === 'encrypted' && T.tillPin() === CERT && T.nodeTlsStatus().state === 'encrypted' && T.nodeTlsStatus().code === T.securityCode(CERT), JSON.stringify(T.nodeTlsStatus()));
  plainCalls = [];
  const reach = await NC.isNodeReachable();
  const drift = await NC.measureNodeDrift();
  const pull = await NC.pullNodeDistribution({});
  ok('from then on every request to the server is TLS — none of them plain', reach === true && drift !== null && pull !== null
    && !plainCalls.some((u) => u.startsWith(NODE)), plainCalls.join(','));
  ok('lanUrl names the server https:// (update downloads), and leaves other addresses alone',
    T.lanUrl(`${NODE}/node/cloud/api/x`) === `https://127.0.0.1:${PORT}/node/cloud/api/x` && T.lanUrl('https://api.zaptill.co.ke/x') === 'https://api.zaptill.co.ke/x');
  plainCalls = [];
  const viaGateway = await rejects(G.cloudFetch('http://127.0.0.1:9/api/pos/init', { headers: { Authorization: 'Bearer t' } }));
  ok('the till\'s cloud calls ride the encrypted connection through the server\'s gateway (its own cloud is down here: "no connection")',
    viaGateway?.name === 'UplinkDownError' && !plainCalls.some((u) => u.startsWith(NODE)), `${viaGateway} ${plainCalls.join(',')}`);
  plainCalls = [];
  await T.lanFetch('http://127.0.0.1:9/elsewhere', { signal: AbortSignal.timeout(2000) }).catch(() => {});
  ok('anything that is not the branch server is the ordinary fetch', plainCalls.includes('http://127.0.0.1:9/elsewhere'));
  const probe = await NC.probeNode(NODE);
  ok('probing an address (repoint) proves the server over TLS and hands back its certificate to pin', probe.ok && probe.cert === CERT && probe.code === T.securityCode(CERT), JSON.stringify({ ...probe, cert: !!probe.cert }));
}

console.log('\nThe server\'s identity changes\n');
{
  N.stopNodeServer();
  getLocalDb().prepare(`DELETE FROM maintenance_state WHERE key IN ('node_tls_cert','node_tls_key')`).run();
  C.saveDeviceConfig({ device_role: 'node' }); N.startNodeServer(); C.saveDeviceConfig({ device_role: 'till', node_url: NODE });
  await new Promise((r) => setTimeout(r, 300));
  ok('(the reinstalled server came back on the same port)', N.getNodePort() === PORT, String(N.getNodePort()));
  const NEW = (await (await realFetch(`${NODE}/node/tls`)).json()).cert;
  plainCalls = [];
  const e = await rejects(T.lanFetch(`${NODE}/node/health`, { headers: NC.nodeHeaders() }));
  ok('a different certificate: refused, and the till NEVER falls back to plain HTTP',
    e?.name === 'NodeIdentityError' && !plainCalls.some((u) => u.startsWith(NODE)), `${e} ${plainCalls.join(',')}`);
  ok('…its callers see "no connection" (sales stay queued on the till)', await NC.isNodeReachable() === false && (await NC.pushRowsToNode({})).kind === 'transport');
  ok('the Tech page says the server\'s identity changed', T.nodeTlsStatus().state === 'mismatch', JSON.stringify(T.nodeTlsStatus()));
  ok('the tick does not quietly trust the new certificate', await T.ensureNodeTls(() => NC.nodeHeaders()) === 'mismatch' && T.tillPin() === CERT);
  T.setTillPin(null);   // a person pressed "Trust it again"
  ok('a person trusts it again: the next tick pins the new certificate', await T.ensureNodeTls(() => NC.nodeHeaders()) === 'encrypted' && T.tillPin() === NEW);
  ok('…and the server answers again', await NC.isNodeReachable() === true);
}

console.log('\nOlder servers, and impostors\n');
{
  const old = http.createServer((req, res) => { res.writeHead(req.url === '/node/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  const OLD = `http://127.0.0.1:${old.address().port}`;
  C.saveDeviceConfig({ node_url: OLD }); T.setTillPin(null); T._resetLanTls();
  ok('a server on an older build (no /node/tls): the till stays plain and says so', await T.ensureNodeTls(() => NC.nodeHeaders()) === 'old_server' && T.nodeTlsStatus().state === 'old_server' && T.tillPin() === null);
  plainCalls = [];
  ok('…and keeps working with it, plain', await NC.isNodeReachable() === true && plainCalls.some((u) => u.startsWith(OLD)));
  old.close();
  // A machine that hands out a certificate but does not accept this till's access code is not pinned.
  // (Server and till share this process's config, so the wrong code is sent rather than saved.)
  C.saveDeviceConfig({ node_url: NODE }); T._resetLanTls();
  ok('a server that refuses this till\'s access code is not pinned', await T.ensureNodeTls(() => ({ 'X-Node-Secret': 'not-the-code' })) === 'plain' && T.tillPin() === null);
}

console.log('\nUpdate downloads (Chromium) trust only the pin\n');
{
  T.setTillPin(null); await T.ensureNodeTls(() => NC.nodeHeaders());
  let proc = null;
  T.trustPinnedNodeIn({ setCertificateVerifyProc: (p) => { proc = p; } });
  const ask = (hostname, data) => new Promise((r) => proc({ hostname, certificate: { data } }, r));
  ok('the branch server\'s address with the pinned certificate is trusted (0)', await ask('127.0.0.1', T.tillPin()) === 0);
  ok('the same address with another certificate is left to Chromium (-3, which refuses a self-signed one)', await ask('127.0.0.1', T.makeServerIdentity().cert) === -3);
  ok('any other host is left to Chromium (-3)', await ask('api.zaptill.co.ke', T.tillPin()) === -3);
}

console.log('\nThe join, encrypted\n');
{
  const J = require(path.join(dist, 'serverJoin.js'));
  J._resetJoins();
  const cert = (await (await realFetch(`${NODE}/node/tls`)).json()).cert;
  const r1 = await T.pinnedFetch(`${NODE}/node/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: 'dev-NEW', name: 'FRONT-PC' }) }, cert);
  const b1 = await r1.json();
  ok('a new till asks to join over TLS (no access code yet)', r1.status === 202 && !!b1.token, JSON.stringify(b1));
  await J.answerJoin(b1.id, true, async () => ({ cloud_url: 'https://api.zaptill.co.ke', business_id: 'bz', branch_id: 'br-1', branch_name: 'Town', code: 'ABCDEFGHJK', node_secret: SECRET }));
  const got = await (await T.pinnedFetch(`${NODE}/node/join/status?id=${b1.id}&token=${b1.token}`, {}, cert)).json();
  ok('…and collects the access code and its device key over TLS', got.status === 'approved' && got.grant.node_secret === SECRET && /^[0-9a-f]{64}$/.test(got.grant.device_token ?? ''), JSON.stringify(got).slice(0, 120));
}

console.log('\nWired in\n');
{
  const nc = src('src/main/nodeClient.ts');
  ok('nodeClient: no plain fetch to the server — every call is lanFetch (the probe reads the certificate first)',
    !/[^.\w]fetch\(`\$\{base\}/.test(nc) && (nc.match(/lanFetch\(`\$\{base\}/g) ?? []).length >= 18 && /readServerCert\(base, timeoutMs\)/.test(nc));
  ok('cloudGateway: a peer\'s cloud calls go through lanFetch', /const f = deps\.fetch \?\? lanFetch;/.test(src('src/main/cloudGateway.ts')));
  ok('staffRoster: the roster ping is lanFetch', /await lanFetch\(`\$\{base\}\/node\/roster\/refresh`/.test(src('src/main/staffRoster.ts')));
  const au = src('src/main/autoUpdate.ts');
  ok('updates: the updater\'s own session trusts the pin; the feed is https:// once pinned; the server is asked with lanFetch',
    /trustPinnedNodeIn\(session\.fromPartition\('electron-updater', \{ cache: false \}\)\)/.test(au) && /base: lanUrl\(r\.base\)/.test(au)
    && (au.match(/fetch: lanFetch as typeof fetch/g) ?? []).length === 2 && !/askBranchServer\([^)]*globalThis\.fetch/.test(au));
  const ipc = ipcHandlersSource();
  ok('join: the certificate first, the join and its answer over TLS, pinned on success (and put back if a rejoin fails)',
    /const \{ cert \} = await readServerCert\(url, 4000\);/.test(ipc) && /joinFetch\(`\$\{url\}\/node\/join`/.test(ipc) && /joinFetch\(`\$\{ask\.url\}\/node\/join\/status/.test(ipc)
    && (ipc.match(/setTillPin\(ask\.cert\);/g) ?? []).length === 2 && /setTillPin\(pinBefore\);/.test(ipc));
  // A490: settings.manage is a broad key now — trusting again is a technician or settings.business (the fine key).
  ok('repoint pins what the probe proved; promotion forgets the pin; trusting again is a technician or settings.business',
    // A502: the typed repoint (tech:setNodeUrl, which pinned what its probe proved) is gone — a till is pointed at a server
    // only by a join (pinned above). A503: the assertion follows the code.
    !/handle\('tech:setNodeUrl'/.test(ipc) && /saveDeviceConfig\(\{ device_role: 'node', node_url: null \}\);\s*setTillPin\(null\);/.test(ipc)
    && /handle\('node:tlsRetrust'[\s\S]{0,200}if \(!getActiveSession\(\) && !signedInCan\('settings\.business'\)\) throw/.test(ipc));
  ok('the till checks every minute (index.ts)', /setInterval\(tlsTick, 60_000\)/.test(src('src/main/index.ts')) && /ensureNodeTls\(\(\) => nodeHeaders\(\)\)/.test(src('src/main/index.ts')));
  ok('both screens show the security code to compare', /data-testid="join-prompt-code"/.test(src('src/renderer/components/JoinPrompt.tsx'))
    && /data-testid="join-security-code"/.test(src('src/renderer/components/JoinWaitPanel.tsx'))
    && /securityCode=\{joinWait\.code\}/.test(src('src/renderer/pages/InstallPage.tsx')) && /securityCode=\{joinWait\.code\}/.test(src('src/renderer/pages/EnrolPage.tsx')));
  ok('the Tech page shows the connection and "Trust it again"', /<LanSecurityRow \/>/.test(src('src/renderer/pages/TechPage.tsx')) && /data-testid="lan-retrust"/.test(src('src/renderer/components/LanSecurityRow.tsx')));
  const ns = src('src/main/nodeServer.ts');
  ok('the server: one listening socket, the first byte decides (0x16 = TLS), plain still served; a till on plain is logged, never refused',
    /first\[0\] === 0x16 && tlsServer \? tlsServer : plainServer/.test(ns) && /notePlainTill\(req\);/.test(ns) && !/notePlainTill[\s\S]{0,400}json\(res, 4/.test(ns));
}

N.stopNodeServer();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
