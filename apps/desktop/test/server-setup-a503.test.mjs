// A503 — till <-> branch server setup, scenario audit for 1.0.16 (fresh shop, upgrades in every order, failover, re-trust,
// roll-back). Against the REAL compiled dist/main: the real branch server on a real port (TLS and plain on one port), a real
// SQLite file, electron shimmed.
//
//   cd apps/desktop && npm run build:main && node test/server-setup-a503.test.mjs
//
//   1  join: a till the server already holds a key for may ask again when its key was never used (the grant answer was
//      lost / its enrolment failed) or when it proves the key it holds (X-Join-Proof, bound to THIS server's certificate);
//      anything else stays 409 (A496)
//   2  Find my server never lists this machine's own beacon while it is announcing (a server stepping down)
//   3  a downloaded update no longer approved (roll-back, hold) is not installed at quit; approved again → it is
//   4  "Trust it again" never sends anything plain to the server's address until a certificate is pinned again
//   5  closing a tech session clears the token the branch server holds (null, not '' — the server refused '');
//      on the server itself it is cleared locally
//   6  stale copy: nothing tells a person to type an address or an access code (A502)
//
// MUTATIONS TO CONFIRM BITE (each made in dist/main, seen to fail, reverted):
//   - joinVerdict returning 'held' for an unused join key           → "1: a till whose grant never arrived may ask again" fails
//   - joinVerdict ignoring the server code in the proof             → "1: a proof made for another server is refused" fails
//   - lanFetch without the awaitingRepin() check                    → "4: nothing goes plain while a re-trust waits" fails
//   - createUpdateLoop never calling installOnQuit(false)           → "3: a rolled-back download is not installed" fails
//   - broadcastTechToken sending '' again                           → "5: closing clears the server's token" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a503-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true }, session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) } };`);
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
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

process.env.SWIFTPOS_NODE_PORT = String(42000 + Math.floor(Math.random() * 15000));
const realFetch = globalThis.fetch;
let plainCalls = [];
globalThis.fetch = (url, init) => { plainCalls.push(String(url)); return realFetch(url, init); };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
const I = require(path.join(dist, 'nodeIngest.js'));
const NS = require(path.join(dist, 'nodeServer.js'));
const NC = require(path.join(dist, 'nodeClient.js'));
const J = require(path.join(dist, 'serverJoin.js'));
const T = require(path.join(dist, 'lanTls.js'));
const B = require(path.join(dist, 'serverBeacon.js'));
const U = require(path.join(dist, 'autoUpdate.js'));

C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1', device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server', node_url: null });
const SECRET = C.ensureNodeSecret();
NS.startNodeServer();
await new Promise((r) => setTimeout(r, 300));
const PORT = NS.getNodePort();
const NODE = `http://127.0.0.1:${PORT}`;
const CERT = (await (await realFetch(`${NODE}/node/tls`)).json()).cert;
const CODE = T.securityCode(CERT);
const join = (device, headers = {}) => T.pinnedFetch(`${NODE}/node/join`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ device_id: device, name: 'FRONT' }) }, CERT);
const grantFor = async (b) => {
  await J.answerJoin(b.id, true, async () => ({ cloud_url: 'https://c', business_id: 'bz', branch_id: 'br-1', branch_name: null, code: 'X', node_secret: SECRET }));
  return (await (await T.pinnedFetch(`${NODE}/node/join/status?id=${b.id}&token=${b.token}`, {}, CERT)).json());
};
const keyed = (device, key) => ({ 'X-Node-Secret': SECRET, 'X-Device-Id': device, 'X-Device-Token': key });

console.log('\n1. Asking to join again\n');
{
  J._resetJoins();
  const r1 = await join('dev-T2');
  const g1 = await grantFor(await r1.json());
  ok('a new till joins and collects its key (over TLS)', r1.status === 202 && /^[0-9a-f]{64}$/.test(g1.grant?.device_token ?? ''), JSON.stringify(g1).slice(0, 80));
  // The answer never reached the till (a blip), or its enrolment failed after it: it asks again with no key of this server's.
  J._resetJoins();
  const r2 = await join('dev-T2');
  ok('1: a till whose grant never arrived (its key never used) may ask again', r2.status === 202, String(r2.status));
  const g2 = await grantFor(await r2.json());
  const KEY = g2.grant.device_token;
  const used = await realFetch(`${NODE}/node/report`, { headers: keyed('dev-T2', KEY) });
  ok('…its new key works', used.status === 200 && I.checkDeviceKey('dev-T2', KEY) === 'ok');
  J._resetJoins();
  const r3 = await join('dev-T2');
  ok('a key in use: a request naming that till with no proof is still refused (A496)', r3.status === 409, String(r3.status));
  const forOther = J.joinProofFor(KEY, 'dev-T2', 'AAAA-BBBB-CCCC');
  ok('1: a proof made for another server (another certificate) is refused', (await join('dev-T2', { 'X-Join-Proof': forOther })).status === 409);
  ok('…a proof from a wrong key is refused', (await join('dev-T2', { 'X-Join-Proof': J.joinProofFor(crypto.randomBytes(32).toString('hex'), 'dev-T2', CODE) })).status === 409);
  ok('…a proof for another device is refused', (await join('dev-T2', { 'X-Join-Proof': J.joinProofFor(KEY, 'dev-T3', CODE) })).status === 409);
  // The till side: the helper reads the key it holds and binds the proof to the certificate it read.
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_device_token', ?, ?)`).run(KEY, new Date().toISOString());
  const h = NC.joinProofHeaders('dev-T2', CERT);
  ok('the till\'s proof headers carry no key, only an HMAC', !!h['X-Join-Proof'] && !JSON.stringify(h).includes(KEY));
  const r4 = await join('dev-T2', h);
  ok('1: the same till proving the key it holds may ask again (A436 rejoin through its own server)', r4.status === 202, String(r4.status));
  ok('…and the person at the server is still asked (nothing is handed out yet)', (await (await T.pinnedFetch(`${NODE}/node/join/status?id=${(await r4.json()).id}&token=x`, {}, CERT)).json()).status === 'unknown'
    && J.pendingJoins().length === 1);
  ok('no key held yet → no proof header (a new till needs none)', Object.keys(NC.joinProofHeaders(null, CERT)).length === 0);
  ok('an older server (no certificate) still checks a proof bound to no code', J.joinProofFor(KEY, 'd', null) === J.joinProofFromHash(crypto.createHash('sha256').update(KEY).digest('hex'), 'd', null));
  J._resetJoins();
}

console.log('\n2. Find my server never lists this machine while it announces\n');
{
  const own = B.ownAddresses({ eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false, netmask: '255.255.255.0' }] });
  ok('2: this machine\'s own beacon is dropped while it announces', B.keepHeard('192.168.1.20', true, own) === false && B.keepHeard('127.0.0.1', true, own) === false);
  ok('…another machine\'s is kept; a till (not announcing) keeps everything', B.keepHeard('192.168.1.30', true, own) && B.keepHeard('192.168.1.20', false, own));
}

console.log('\n3. A download no longer approved is not installed\n');
{
  const statusFetch = (approved) => async () => new Response(JSON.stringify({ approvedVersion: approved }), { status: 200 });
  const loopWith = (approved, status = { state: 'downloaded', version: '1.0.17', percent: 100 }) => {
    let st = { state: 'idle', version: null, percent: null, ...status };
    const quit = [];
    const loop = U.createUpdateLoop({
      status: () => st, set: (p) => { st = { ...st, ...p }; }, running: '1.0.16', isServer: () => false, log: () => {},
      askServer: async () => null, installOnQuit: (on) => quit.push(on),
      checkDeps: ({ running }) => ({ updater: { setFeedURL() {}, requestHeaders: null, checkForUpdates: async () => null },
        fetch: statusFetch(approved.v), cloudUrl: () => 'https://c', token: () => 'tok', refresh: async () => false, running }),
    });
    return { loop, quit, state: () => st, approved };
  };
  const a = loopWith({ v: '1.0.16' });
  await a.loop.check('hourly');
  ok('3: a rolled-back download (1.0.17 held, 1.0.16 approved) is not installed at quit', a.quit.at(-1) === false && a.state().state === 'idle'
    && /no longer approved/.test(a.state().note ?? ''), JSON.stringify({ q: a.quit, s: a.state() }));
  a.approved.v = '1.0.17';
  await a.loop.check('hourly');
  ok('…approved again: it installs at quit, and shows as downloaded', a.quit.at(-1) === true && a.state().state === 'downloaded' && a.state().version === '1.0.17', JSON.stringify(a.state()));
  const h = loopWith({ v: null });
  await h.loop.check('hourly');
  ok('the business put on hold after the download: not installed', h.quit.at(-1) === false);
  const c = loopWith({ v: '1.0.17' });
  await c.loop.check('hourly');
  ok('still approved: installed at quit as before', c.quit.at(-1) === true && c.state().state === 'downloaded');
  const u = { quit: [] };   // unreachable cloud: no answer changes nothing
  const lu = U.createUpdateLoop({ status: () => ({ state: 'downloaded', version: '1.0.17', percent: 100 }), set: () => {}, running: '1.0.16', isServer: () => false,
    log: () => {}, askServer: async () => null, installOnQuit: (on) => u.quit.push(on),
    checkDeps: ({ running }) => ({ updater: { setFeedURL() {}, requestHeaders: null, checkForUpdates: async () => null },
      fetch: async () => { throw new TypeError('fetch failed'); }, cloudUrl: () => 'https://c', token: () => 'tok', refresh: async () => false, running }) });
  await lu.check('hourly');
  ok('an unanswered check changes nothing', u.quit.length === 0);
  ok('wired: electron-updater\'s autoInstallOnAppQuit follows it', /installOnQuit: \(on\) => \{ autoUpdater\.autoInstallOnAppQuit = on; \}/.test(src('src/main/autoUpdate.ts')));
}

console.log('\n5. Closing a tech session clears what the server holds\n');
{
  const realTok = 'st2.x.y';
  db.exec(`CREATE TABLE IF NOT EXISTS node_state (id INTEGER PRIMARY KEY CHECK (id = 1), tech_token TEXT, updated_at TEXT); INSERT OR IGNORE INTO node_state (id) VALUES (1)`);
  db.prepare(`UPDATE node_state SET tech_token = ? WHERE id = 1`).run(realTok);
  await NC.broadcastTechToken('');   // this process is the server
  ok('5: on the branch server itself, closing clears the token it offers its tills', db.prepare(`SELECT tech_token FROM node_state WHERE id = 1`).get().tech_token === null);
}

console.log('\n4. "Trust it again" never goes plain\n');
{
  // Now the same process is a till pointed at the server, pinned.
  C.saveDeviceConfig({ device_role: 'till', node_url: NODE, device_id: 'dev-T2' });
  T.setTillPin(CERT);
  db.prepare(`UPDATE node_state SET tech_token = 'st2.held.token' WHERE id = 1`).run();   // a session the server offers
  await NC.broadcastTechToken('');
  // what a till sends on close: the server is asked to clear (null) — '' was refused as "not a valid tech token"
  const r = await T.lanFetch(`${NODE}/node/tech-session`, { headers: NC.nodeHeaders() });
  ok('5: a till closing its session clears the token the server holds (null, not \'\')', r.status === 200 && (await r.json()).token === null);
  plainCalls = [];
  T.forgetPinForRetrust();
  const e = await rejects(T.lanFetch(`${NODE}/node/health`, { headers: NC.nodeHeaders() }));
  ok('4: nothing goes plain while a re-trust waits (no request reached the network)', !!e && /waiting to trust/.test(String(e?.cause?.message)) && plainCalls.length === 0, `${e} ${plainCalls}`);
  ok('…the updater feed is https:// meanwhile (its session refuses it with no pin)', T.lanUrl(`${NODE}/node/cloud`).startsWith('https://'));
  ok('…the Tech page says so', T.nodeTlsStatus().state === 'tls_failed' && /waiting to trust/.test(T.nodeTlsStatus().error ?? ''));
  const st = await T.ensureNodeTls(() => NC.nodeHeaders());
  ok('…the next tick pins the server again (proven over TLS with this till\'s code) and it flows again',
    st === 'encrypted' && !T.awaitingRepin() && (await T.lanFetch(`${NODE}/node/health`, { headers: NC.nodeHeaders() })).status === 200);
  T.setTillPin(null);
  ok('an explicit "no pin" (a join to an older server) is not held back', !T.awaitingRepin() && T.lanUrl(`${NODE}/x`).startsWith('http://'));
}

console.log('\n6. No typed address or access code in the copy (A502)\n');
{
  ok('6: the Branch sync panel sends people to Find my server', !/re-enter it \(Install/.test(src('src/renderer/components/BranchSyncPanel.tsx'))
    && !/set the address below/.test(src('src/renderer/components/BranchSyncPanel.tsx')));
  ok('…the follow log too', !/set the address on the Tech page/.test(src('src/main/nodeFollow.ts')));
  ok('…the server\'s setup no longer says each till must be given the code', !/must be given the same code/.test(src('src/renderer/pages/InstallPage.tsx')));
}

NS.stopNodeServer();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
