// A427 — a new till finds the branch server on the network and joins it when someone at the server allows it; the
// branch server keeps running whenever the computer is on.
// Owner, 2026-10-09: "the server to broadcast in the network and the till or any installation to listen, if none exist
// the tech gets the screen to select … add the server as a service that never sleeps … when the app is closed the app
// remains open in the task panel … the till codes and branch code remain, nothing changes there".
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/server-join.test.mjs
//
// RUNS the real compiled dist/main: the beacon over real UDP, and the REAL branch server (startNodeServer) answering
// join requests over real HTTP — with no access code, while every other route still demands it.
//
// MUTATIONS TO CONFIRM BITE:
//   - parseBeacon accepting any JSON                       → "only our beacon" fails
//   - readJoin handing the grant out twice / to any token  → "once, to the holder of the token" fails
//   - the join routes placed after the access-code check   → "a till with no code can ask" fails
//   - the setup screen skipping straight to typing          → "searches first" pins fail
//   - window-all-closed quitting a branch server             → "the server stays in the tray" pin fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a418-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.4', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const B = require(path.join(dist, 'serverBeacon.js'));
const J = require(path.join(dist, 'serverJoin.js'));

console.log('\nThe server announces itself\n');
{
  const msg = B.buildBeacon({ port: 4100, business: 'Albaik', server: 'Back office' });
  const f = B.parseBeacon(msg, '192.168.1.20');
  ok('a beacon carries only the port and names — no access code, no ids', !/secret|token|code|branch_id|business_id/i.test(msg.toString()), msg.toString());
  ok('…and is read back as the server\'s address', f && f.url === 'http://192.168.1.20:4100' && f.business === 'Albaik' && f.server === 'Back office', JSON.stringify(f));
  ok('only our beacon: other traffic, a bad port or a bad address is ignored',
    B.parseBeacon(Buffer.from('{"magic":"OTHER","port":4100}'), '192.168.1.20') === null
    && B.parseBeacon(Buffer.from('not json'), '192.168.1.20') === null
    && B.parseBeacon(Buffer.from(JSON.stringify({ magic: B.BEACON_MAGIC, port: 99999 })), '192.168.1.20') === null
    && B.parseBeacon(msg, 'fe80::1') === null);
  const addrs = B.broadcastAddresses({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0' }],
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }] });
  ok('it is sent to each network\'s own broadcast address and to all networks', addrs.includes('192.168.1.255') && addrs.includes('255.255.255.255') && !addrs.includes('127.255.255.255'), addrs.join(','));
}

console.log('\nA new till listens (real UDP)\n');
{
  const listening = B.listenForServers(900);
  await new Promise((r) => setTimeout(r, 200));
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.send(B.buildBeacon({ port: 4123, business: 'Albaik', server: null }), B.BEACON_PORT, '127.0.0.1', r));
  await new Promise((r) => s.send(B.buildBeacon({ port: 4123, business: 'Albaik', server: null }), B.BEACON_PORT, '127.0.0.1', r));
  s.close();
  const found = await listening;
  const mine = found.filter((x) => x.url === 'http://127.0.0.1:4123');
  ok('it hears the server, once per address however often the server announces', mine.length === 1, JSON.stringify(found));
  ok('nothing heard is an empty list, never an error (the technician then gets the usual setup)', Array.isArray(await B.listenForServers(150)));
}

console.log('\nAsking to join (the rules)\n');
{
  J._resetJoins();
  const a = J.createJoinRequest({ device_id: 'dev-NEW', name: 'FRONT-PC' }, '192.168.1.31', 1000);
  ok('a till asks: it gets a request id and a private token; the server lists it for a person to answer',
    a.ok && a.token.length >= 32 && J.pendingJoins(1000).length === 1 && J.pendingJoins(1000)[0].name === 'FRONT-PC' && J.pendingJoins(1000)[0].ip === '192.168.1.31');
  ok('nothing is handed out while it waits', J.readJoin(a.id, a.token, 1000).status === 'pending' && !J.readJoin(a.id, a.token, 1000).grant);
  let failed = '';
  try { await J.answerJoin(a.id, true, async () => { throw new Error('no internet'); }); } catch (e) { failed = e.message; }
  ok('Allow with no internet: the reason goes back to the screen and the request still waits', failed === 'no internet' && J.pendingJoins(1000).length === 1);
  const grant = { cloud_url: 'https://api.zaptill.co.ke', business_id: 'bz', branch_id: 'br', branch_name: 'Town', code: 'ABCDEFGHJK', node_secret: 'SECR-ET00-0000-0000' };
  await J.answerJoin(a.id, true, async () => grant);
  ok('a wrong token gets nothing', J.readJoin(a.id, 'x'.repeat(a.token.length), 1000).status === 'unknown');
  const got = J.readJoin(a.id, a.token, 1000);
  ok('allowed: the grant goes once, to the holder of the token', got.status === 'approved' && got.grant?.code === 'ABCDEFGHJK');
  ok('…and never again', J.readJoin(a.id, a.token, 1000).status === 'unknown');

  const d = J.createJoinRequest({ device_id: 'dev-X', name: 'X' }, '192.168.1.40', 1000);
  await J.answerJoin(d.id, false, async () => grant);
  ok('denied: the till is told no, and gets nothing', JSON.stringify(J.readJoin(d.id, d.token, 1000)) === '{"status":"denied"}');

  J._resetJoins();
  const first = J.createJoinRequest({ device_id: 'a', name: 'A' }, '10.0.0.5', 1000);
  J.createJoinRequest({ device_id: 'a', name: 'A again' }, '10.0.0.5', 1000);
  ok('asking again from the same address replaces the first request', J.pendingJoins(1000).length === 1 && J.readJoin(first.id, first.token, 1000).status === 'unknown');
  for (let i = 0; i < J.MAX_PENDING; i++) J.createJoinRequest({ device_id: `d${i}`, name: 'N' }, `10.0.1.${i}`, 1000);
  ok('at most a handful wait at once (a flood is refused)', J.createJoinRequest({ device_id: 'zz', name: 'N' }, '10.0.2.1', 1000).ok === false);
  ok('a request nobody answers runs out', J.pendingJoins(1000 + J.JOIN_TTL_MS + 1).length === 0);
  ok('a request without a device id is refused', J.createJoinRequest({ name: 'N' }, '10.0.3.1', 1000).ok === false);
}

console.log('\nThrough the REAL branch server\n');
{
  J._resetJoins();
  process.env.SWIFTPOS_NODE_PORT = String(40000 + Math.floor(Math.random() * 20000));
  const C = require(path.join(dist, 'deviceConfig.js'));
  C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1', device_id: 'dev-SRV', device_role: 'node', terminal_code: 'T1', device_name: 'Back office' });
  const SECRET = C.ensureNodeSecret();
  const N = require(path.join(dist, 'nodeServer.js'));
  const seen = [];
  N.onServingChange((on) => seen.push(on));
  N.startNodeServer();
  await new Promise((r) => setTimeout(r, 300));
  const NODE = `http://127.0.0.1:${N.getNodePort()}`;
  ok('the server says when it starts serving (index.ts then keeps it awake and in the tray)', seen[0] === true, JSON.stringify(seen));

  const r1 = await fetch(`${NODE}/node/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: 'dev-NEW', name: 'FRONT-PC' }) });
  const b1 = await r1.json();
  ok('a till with no access code can ask to join', r1.status === 202 && b1.id && b1.token, JSON.stringify(b1));
  ok('…but every other route still demands the code', (await fetch(`${NODE}/node/health`)).status === 401);
  ok('the server lists it with the address it came from', J.pendingJoins()[0]?.ip === '127.0.0.1' && J.pendingJoins()[0]?.name === 'FRONT-PC', JSON.stringify(J.pendingJoins()));
  const st = async () => (await fetch(`${NODE}/node/join/status?id=${b1.id}&token=${b1.token}`)).json();
  ok('waiting: pending, nothing handed out', JSON.stringify(await st()) === '{"status":"pending"}');
  await J.answerJoin(b1.id, true, async () => ({ cloud_url: 'https://api.zaptill.co.ke', business_id: 'bz', branch_id: 'br-1', branch_name: 'Town', code: 'ABCDEFGHJK', node_secret: SECRET }));
  const got = await st();
  ok('allowed: the till collects the cloud, business, branch, one-time code and this server\'s access code',
    got.status === 'approved' && got.grant.node_secret === SECRET && got.grant.code === 'ABCDEFGHJK' && got.grant.branch_id === 'br-1');
  ok('…once', (await st()).status === 'unknown');
  ok('the access code it now holds opens the server', (await fetch(`${NODE}/node/health`, { headers: { 'X-Node-Secret': got.grant.node_secret } })).status === 200);
  N.stopNodeServer();
  ok('…and says when it stops', seen[seen.length - 1] === false);
}

console.log('\nWired in\n');
{
  const ipc = src('src/main/ipcHandlers.ts');
  const status = ipc.slice(ipc.indexOf("handle('install:joinStatus'"), ipc.indexOf("handle('node:joinRequests'"));
  ok('allowed: the server\'s address and code are saved BEFORE enrolling, so enrolling goes through the server (A410)',
    status.indexOf('node_url: ask.url, node_secret: String(g.node_secret)') > 0 && status.indexOf('node_url: ask.url') < status.indexOf('await joinBusiness('));
  ok('…not marked configured — the technician finishes setup on screen (till code and the rest unchanged)', /configured: false/.test(status) && !/terminal_code/.test(status));
  ok('Allow asks the cloud for the code with the server\'s own sign-in', /tillFetch\('\/api\/pos\/join-code'/.test(ipc));
  const inst = src('src/renderer/pages/InstallPage.tsx');
  ok('setup searches the network first', /useState<Step>\('search'\)/.test(inst) && /posApi\.install\.findServers\(\)/.test(inst));
  ok('heard nothing → the usual setup screen', /if \(list\.length === 0\) setStep\('connection'\);/.test(inst));
  ok('joined → the last step with the branch locked and the server filled in; the till code is still typed',
    /setBranchLocked\(true\);/.test(inst) && /setNodeSecret\(st\.nodeSecret\);/.test(inst) && /value=\{terminalCode\}/.test(inst));
  ok('the server shows "a till wants to join" over every screen', /<AppScreens \/><JoinPrompt \/>/.test(src('src/renderer/App.tsx')));
  const index = src('src/main/index.ts');
  ok('the server stays in the tray when its window is closed', /if \(isServing\(\)\) return;/.test(index) && /keepServerWindowAlive\(win\)/.test(index));
  ok('serving → start with Windows, never sleep, tray; stop serving → all undone',
    /onServingChange\(\(on\) => \{ if \(on\) enterServerMode\(\); else leaveServerMode\(\); \}\);/.test(index));
  const mode = src('src/main/serverMode.ts');
  ok('…which means: login item, prevent-app-suspension, a tray with Open / Restart / Quit',
    /openAtLogin: true/.test(mode) && /powerSaveBlocker\.start\('prevent-app-suspension'\)/.test(mode) && /Restart ZapTill/.test(mode) && /app\.relaunch\(\)/.test(mode));
  ok('the installer opens UDP 4199 on private networks', /protocol=UDP localport=4199 profile=private/.test(src('build/installer.nsh')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
