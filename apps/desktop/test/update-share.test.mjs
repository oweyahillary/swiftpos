// A443 — the branch server fetches an approved update ONCE and the branch's tills take it from the server.
// Owner, 2026-10-11: "can we do it this way a server pulls the update and shares it with the tills?" Before: a till behind a
// branch server downloaded the 205 MB installer live through the server's gateway, which cut every request at 60 s — on a
// shop line the download never finished, and it started again from nothing every hour.
//
// RUNS the real compiled dist/main: the REAL branch server (nodeServer, its access-code check and gateway) on a real port,
// a stand-in cloud on another that serves an update (and can drop the connection half-way), real files on disk.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/update-share.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - prepareShare ignoring the part already on disk (no Range)        → "the second try resumes" fails
//   - the sha512 check removed                                          → "a corrupt download is never shared" fails
//   - serveSharedUpdate returning false when not ready (live fallback)  → "not ready → 503, the cloud is not asked" fails
//   - the gateway's timer not reset on data (a total limit again)       → "a slow answer that keeps coming is passed on whole" fails
//   - runUpdateCheck ignoring share.prepare's answer                    → "the server waits for its own copy" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a443-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.5', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The update the cloud holds ───────────────────────────────────────────────
const V = '9.9.9';
const EXE = `ZapTill-${V}.exe`;
const INSTALLER = crypto.randomBytes(2 * 1024 * 1024 + 123);
const SHA = crypto.createHash('sha512').update(INSTALLER).digest('base64');
const yml = (sha = SHA) => `version: ${V}\nfiles:\n  - url: ${EXE}\n    sha512: ${sha}\n    size: ${INSTALLER.length}\npath: ${EXE}\nsha512: ${sha}\nreleaseDate: '2026-10-11T09:00:00.000Z'\n`;

const cloudState = { dropAt: 0, badSha: false, bytesSent: 0, ranges: [], seen: [] };
const cloud = await listen((req, res) => {
  cloudState.seen.push(req.url);
  if (req.headers.authorization !== 'Bearer tok-server' && req.headers.authorization !== 'Bearer tok-till') { res.writeHead(401); return res.end(); }
  if (req.url === `/api/desktop-update/v/${V}/latest.yml`) { res.writeHead(200, { 'content-type': 'text/yaml' }); return res.end(yml(cloudState.badSha ? 'AAAA' : SHA)); }
  if (req.url === `/api/desktop-update/v/${V}/${EXE}.blockmap`) { res.writeHead(200); return res.end('blockmap'); }
  if (req.url === `/api/desktop-update/v/${V}/${EXE}`) {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const from = range ? Number(range[1]) : 0;
    cloudState.ranges.push(req.headers.range ?? null);
    const body = INSTALLER.subarray(from);
    res.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    if (cloudState.dropAt) {               // the shop line drops half-way
      const cut = cloudState.dropAt; cloudState.dropAt = 0;
      cloudState.bytesSent += cut;
      return res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 30));
    }
    cloudState.bytesSent += body.length;
    return res.end(body);
  }
  if (req.url === '/api/slow') {           // keeps sending for longer than the limit, a little at a time
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let n = 0; const t = setInterval(() => { res.write(Buffer.alloc(1000, 1)); if (++n === 12) { clearInterval(t); res.end(); } }, 100);
    return;
  }
  if (req.url === '/api/stall') { res.writeHead(200); res.write('x'); return; }   // starts, then nothing
  res.writeHead(404); res.end();
});
const CLOUD = `http://127.0.0.1:${portOf(cloud)}`;

// ── The REAL branch server ───────────────────────────────────────────────────
process.env.SWIFTPOS_NODE_PORT = String(40000 + Math.floor(Math.random() * 20000));
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: 'br-1', device_id: 'dev-NODE', device_role: 'node', terminal_code: 'T1', device_name: 'Server' });
const SECRET = C.ensureNodeSecret();
const N = require(path.join(dist, 'nodeServer.js'));
N.startNodeServer();
await sleep(300);
const NODE = `http://127.0.0.1:${N.getNodePort()}`;
const S = require(path.join(dist, 'updateShare.js'));
const U = require(path.join(dist, 'autoUpdate.js'));
const NG = require(path.join(dist, 'nodeGateway.js'));
const wanted = [];
S.onShareWanted((v) => wanted.push(v));
const deps = { fetch: globalThis.fetch, dir: S.shareDir(), cloudUrl: () => CLOUD, token: () => 'tok-server', refresh: async () => false, log: () => {} };
const tillGet = (file, method = 'GET') => fetch(`${NODE}/node/cloud/api/desktop-update/v/${V}/${file}`, {
  method, headers: { 'X-Node-Secret': SECRET, Authorization: 'Bearer tok-till' } });

console.log('\nReading the release (pure)\n');
{
  const info = S.parseLatestYml(yml());
  ok('latest.yml → the installer, its sha512 and size', info?.version === V && info.file === EXE && info.sha512 === SHA && info.size === INSTALLER.length, JSON.stringify(info));
  ok('…and nothing from something that is not one', S.parseLatestYml('hello') === null && S.parseLatestYml(`version: ${V}\npath: ../x.exe\nsha512: a\n  size: 3\n`) === null);
  ok('a till\'s update request is recognised; nothing else is',
    JSON.stringify(S.shareRequest(`/node/cloud/api/desktop-update/v/${V}/${EXE}`)) === JSON.stringify({ version: V, file: EXE })
    && S.shareRequest('/node/cloud/api/desktop-update/status') === null && S.shareRequest('/node/cloud/api/desktop-update/v/../x') === null);
}

console.log('\nBefore the server has it\n');
{
  cloudState.seen.length = 0;
  const r = await tillGet(EXE);
  ok('not ready → 503, the cloud is not asked for the installer (no live 205 MB through the server)',
    r.status === 503 && !cloudState.seen.some((u) => u.endsWith(EXE)), `${r.status} ${JSON.stringify(cloudState.seen)}`);
  const y = await tillGet('latest.yml');
  ok('…and latest.yml too, so a till does not start a download that cannot finish', y.status === 503);
  ok('the server is told a till wants that version', wanted.includes(V));
  const b = await tillGet(`${EXE}.blockmap`);
  ok('the small blockmap still comes from the cloud as before', b.status === 200 && (await b.text()) === 'blockmap');
}

console.log('\nThe server fetches it once, resuming a broken line\n');
{
  cloudState.dropAt = 700_000; cloudState.bytesSent = 0; cloudState.ranges.length = 0;
  const first = await S.prepareShare(V, deps);
  const part = path.join(S.shareDir(), V, `${EXE}.part`);
  ok('the line drops half-way → not ready, the part kept', first === 'failed' && fs.existsSync(part) && fs.statSync(part).size > 0, `${first}`);
  const kept = fs.statSync(part).size;
  const second = await S.prepareShare(V, deps);
  ok('the second try resumes from where it stopped (Range) and finishes', second === 'ready' && cloudState.ranges[1] === `bytes=${kept}-`, `${second} ${JSON.stringify(cloudState.ranges)}`);
  ok('…so the branch downloads the installer about once, not again from the start',
    cloudState.bytesSent <= INSTALLER.length + 700_000 && cloudState.bytesSent >= INSTALLER.length, String(cloudState.bytesSent));
  ok('a ready version is not fetched again', await S.prepareShare(V, deps) === 'ready' && cloudState.ranges.length === 2);
}

console.log('\nThe tills take it from the server\n');
{
  cloudState.seen.length = 0;
  const y = await tillGet('latest.yml');
  const ytext = await y.text();
  const r = await tillGet(EXE);
  const buf = Buffer.from(await r.arrayBuffer());
  ok('the till gets latest.yml from the server\'s copy', y.status === 200 && S.parseLatestYml(ytext)?.sha512 === SHA);
  ok('…and the installer, byte for byte (its sha512 matches what the till checks)',
    r.status === 200 && r.headers.get('x-update-share') === '1' && crypto.createHash('sha512').update(buf).digest('base64') === SHA);
  ok('…without the cloud being asked', !cloudState.seen.some((u) => u.includes('/desktop-update/')), JSON.stringify(cloudState.seen));
  const h = await tillGet(EXE, 'HEAD');
  ok('a HEAD gets the size', h.status === 200 && Number(h.headers.get('content-length')) === INSTALLER.length);
  const no = await fetch(`${NODE}/node/cloud/api/desktop-update/v/${V}/${EXE}`, { headers: { Authorization: 'Bearer tok-till' } });
  ok('only with the branch access code', no.status === 401);
  const other = await fetch(`${NODE}/node/cloud/api/desktop-update/v/9.9.8/ZapTill-9.9.8.exe`, { headers: { 'X-Node-Secret': SECRET } });
  ok('only the version the server holds', other.status === 503);
}

console.log('\nA bad download is never shared\n');
{
  const deps2 = { ...deps, dir: path.join(userData, 'share-2') };
  cloudState.badSha = true;
  const r = await S.prepareShare(V, deps2);
  cloudState.badSha = false;
  ok('a corrupt download (sha512 mismatch) is discarded, not shared', r === 'failed' && !S.readyVersion(deps2.dir, V)
    && !fs.existsSync(path.join(deps2.dir, V, EXE)) && !fs.existsSync(path.join(deps2.dir, V, `${EXE}.part`)));
}

console.log('\nThe gateway no longer cuts a long answer\n');
{
  const gw = await listen((req, res) => NG.forwardToCloud(req, res, CLOUD, { timeoutMs: 300, idleMs: 300 }));
  const t0 = Date.now();
  let buf = Buffer.alloc(0);
  try {
    const r = await fetch(`http://127.0.0.1:${portOf(gw)}/node/cloud/api/slow`, { headers: { Authorization: 'Bearer tok-till' } });
    buf = Buffer.from(await r.arrayBuffer());
  } catch { /* cut — reported below */ }
  ok('a slow answer that keeps coming is passed on whole (1.2 s > the 0.3 s limit)', buf.length === 12_000 && Date.now() - t0 > 1000, `${buf.length}`);
  let cut = false;
  try { const s = await fetch(`http://127.0.0.1:${portOf(gw)}/node/cloud/api/stall`, { headers: { Authorization: 'Bearer tok-till' } }); await s.arrayBuffer(); } catch { cut = true; }
  ok('an answer that stops arriving is still cut', cut);
  gw.close();
}

console.log('\nThe branch server\'s own update\n');
{
  const calls = { feed: null, checked: 0 };
  const updater = { setFeedURL(o) { calls.feed = o.url; }, requestHeaders: null, async checkForUpdates() { calls.checked++; return null; } };
  const base = {
    updater, running: '1.0.5', token: () => 'tok', refresh: async () => false, cloudUrl: () => CLOUD,
    fetch: async () => new Response(JSON.stringify({ approvedVersion: V }), { status: 200 }),
  };
  const notReady = await U.runUpdateCheck({ ...base, share: { prepare: async () => 'busy', route: () => ({ base: `${NODE}/node/cloud`, headers: { 'X-Node-Secret': SECRET } }) } });
  ok('the server waits for its own copy before updating itself', notReady.waiting === true && calls.checked === 0, JSON.stringify(notReady));
  const ready = await U.runUpdateCheck({ ...base, share: { prepare: async () => 'ready', route: () => ({ base: `${NODE}/node/cloud`, headers: { 'X-Node-Secret': SECRET } }) } });
  ok('…then updates from it, through its own gateway', calls.checked === 1 && calls.feed === `${NODE}/node/cloud/api/desktop-update/v/${V}/`
    && updater.requestHeaders['X-Node-Secret'] === SECRET, `${calls.feed}`);
  const prepared = [];
  await U.runUpdateCheck({ ...base, running: V, share: { prepare: async (v) => { prepared.push(v); return 'ready'; }, route: () => null } });
  ok('a server already on the approved version still holds it for the tills', prepared[0] === V);
  prepared.length = 0;
  await U.runUpdateCheck({ ...base, fetch: async () => new Response(JSON.stringify({ approvedVersion: null }), { status: 200 }),
    share: { prepare: async (v) => { prepared.push(v); return 'ready'; }, route: () => null } });
  ok('nothing is fetched while the business is on hold', prepared.length === 0);
}

console.log('\nThe server tells its tills, and knows what each runs\n');
{
  S._resetTills();
  const till = (name, device) => ({ device_role: 'till', node_url: NODE, node_secret: SECRET, device_id: device, device_name: name });
  const behind = await U.askBranchServer({ cfg: till('Front', 'dev-T2'), running: '1.0.5', fetch: globalThis.fetch });
  ok('a till on 1.0.5 asks and is told the server holds 9.9.9 — fetch it now', behind?.version === V && behind.newer === true, JSON.stringify(behind));
  const upToDate = await U.askBranchServer({ cfg: till('Bar', 'dev-T3'), running: V, fetch: globalThis.fetch });
  ok('a till already on it is told nothing to do', upToDate?.version === V && upToDate.newer === false);
  const list = S.tillVersions(S.latestReady(S.shareDir()));
  ok('the server lists each till and what it runs (Front behind, Bar current)',
    list.length === 2 && list.find((t) => t.name === 'Front')?.current === false && list.find((t) => t.name === 'Bar')?.current === true, JSON.stringify(list));
  const wrong = await U.askBranchServer({ cfg: { ...till('X', 'dev-X'), node_secret: 'nope' }, running: '1.0.5', fetch: globalThis.fetch });
  ok('only with the branch access code (a wrong one is "no answer")', wrong === null && !S.tillVersions(null).some((t) => t.deviceId === 'dev-X'));
  const off = await U.askBranchServer({ cfg: { ...till('Y', 'dev-Y'), node_url: 'http://127.0.0.1:1' }, running: '1.0.5', fetch: globalThis.fetch });
  ok('a server that cannot be reached is "no answer" (asked again in 2 minutes)', off === null);
  ok('the server itself and a till with no server do not ask',
    await U.askBranchServer({ cfg: { ...till('S', 'dev-S'), device_role: 'node' }, running: '1.0.5', fetch: globalThis.fetch }) === null
    && await U.askBranchServer({ cfg: { ...till('Z', 'dev-Z'), node_url: '' }, running: '1.0.5', fetch: globalThis.fetch }) === null);
  const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'autoUpdate.ts'), 'utf8');
  // A496: the loop moved into createUpdateLoop (testable; test/update-delivery.test.mjs drives it) — same meaning.
  ok('a till asks every 2 minutes and at start, and checks at once when told', /void loop\.ask\(\);\n\s+setInterval\(\(\) => \{ void loop\.ask\(\); \}, 2 \* 60_000\);/.test(src)
    && /await check\('the branch server holds a newer version'\);/.test(src));
  // A496: "the server holds it → ready, an older server → ready, else wait" is tillShareVerdict now (and a wait ends).
  ok('…and downloads only once the server holds that version (an older server: as before)',
    U.tillShareVerdict({ version: V, newer: true }, V, null, Date.now()).verdict === 'ready'
    && U.tillShareVerdict(null, V, null, Date.now()).verdict === 'ready'
    && U.tillShareVerdict({ version: '9.9.8', newer: false }, V, Date.now(), Date.now()).verdict === 'busy');
  ok('the server\'s screen lists the tills', /<TillVersionsPanel \/>/.test(fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'TechPage.tsx'), 'utf8')));
}

N.stopNodeServer?.();
cloud.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
