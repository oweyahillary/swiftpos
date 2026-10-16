// A496 — "check update function on server till setup: sometimes the tills never get updates" (owner, 2026-10-15).
//
// Each way a till behind a branch server could end up NEVER updating, reproduced, and fixed:
//   1. A machine holding a downloaded update never checked again (check() returned early on 'downloaded'). A branch
//      server is never closed (server mode), so after it downloaded version X for itself it never fetched X+1 for its
//      tills — and they were told "not ready" for ever.
//   2. At launch the server's listener had not bound yet: its first check saw no port, treated it as an ordinary till,
//      downloaded its own update straight from the cloud and never fetched the branch's copy (then 1. held it there).
//   3. A download that stalls (no error, no bytes) never ends: Electron's requests ignore electron-updater's timeout (it
//      waits for a 'socket' event they never emit — test/update-delivery-electron.test.mjs shows it under Electron), so
//      the state stayed 'downloading' and every later check returned early. Same for a check (latest.yml) that hangs.
//   4. A till waited for the server's copy with no end: a server that could not fetch it (signed out, a refusal, a disk
//      error) left the branch waiting with no reason shown. Now it tells its tills how its fetch is going, and after
//      SHARE_STUCK_FAILURES failures (or 6 h of a till waiting) the till downloads through the server live.
//   5. A copy left on the server from before a roll-back (or a hold) was still offered as "newer" to every till.
// Plus diagnostics: one log line per decision, and the Tech page's data (getUpdateStatus note / getUpdateDiagnostics).
//
// RUNS the real compiled dist/main: the REAL branch server on a real port, a stand-in cloud, real files on disk.
//
//   cd apps/desktop && npm run build:main && node test/update-delivery.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - createUpdateLoop.check returning early on 'downloaded' again           → "1: a server holding a downloaded update still fetches the next" fails
//   - unstick() not cancelling (the stall watchdog off)                       → "3: a stalled download is cancelled" fails
//   - serveSharedUpdate never passing a stuck version on (no shareStuck)      → "4: a stuck server passes the till's request on" fails
//   - /node/update/ready offering latestReady again (not offeredVersion)      → "5: a copy from before a roll-back is not offered" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a496-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.5', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true }, session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) } };`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The cloud: two releases (9.9.9 and 9.9.10); 9.9.8's latest.yml always refused (a version the server cannot fetch) ─
const rel = (v) => {
  const exe = `ZapTill-${v}.exe`;
  const bytes = crypto.randomBytes(300_000 + v.length);
  const sha = crypto.createHash('sha512').update(bytes).digest('base64');
  return { v, exe, bytes, sha, yml: `version: ${v}\nfiles:\n  - url: ${exe}\n    sha512: ${sha}\n    size: ${bytes.length}\npath: ${exe}\nsha512: ${sha}\nreleaseDate: '2026-10-15T09:00:00.000Z'\n` };
};
const R = { '9.9.9': rel('9.9.9'), '9.9.10': rel('9.9.10'), '9.9.8': rel('9.9.8') };
const cloudSeen = [];
const cloud = await listen((req, res) => {
  cloudSeen.push(req.url);
  if (!/^Bearer tok-/.test(req.headers.authorization ?? '')) { res.writeHead(401); return res.end(); }
  const m = /^\/api\/desktop-update\/v\/([^/]+)\/(.+)$/.exec(req.url);
  if (m && R[m[1]]) {
    const r = R[m[1]];
    if (m[2] === 'latest.yml') {
      // The SERVER's own fetch of 9.9.8 is refused; a till's request for it (its own token) is not.
      if (r.v === '9.9.8' && req.headers.authorization === 'Bearer tok-server') { res.writeHead(500); return res.end('{"error":"boom"}'); }
      res.writeHead(200, { 'content-type': 'text/yaml' }); return res.end(r.yml);
    }
    if (m[2] === r.exe) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': r.bytes.length }); return res.end(r.bytes); }
  }
  res.writeHead(404); res.end();
});
const CLOUD = `http://127.0.0.1:${cloud.address().port}`;

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
const wanted = [];
S.onShareWanted((v) => wanted.push(v));
const serverDeps = { fetch: globalThis.fetch, dir: S.shareDir(), cloudUrl: () => CLOUD, token: () => 'tok-server', refresh: async () => false, log: () => {} };
const till = (device = 'dev-T2') => ({ device_role: 'till', node_url: NODE, node_secret: SECRET, device_id: device, device_name: 'Front' });

// A fake electron-updater and a cloud status answer, for the loop.
function fakeUpdater() {
  const u = { feed: null, checked: 0, cancelled: 0, hang: false, requestHeaders: null,
    setFeedURL(o) { u.feed = o.url; },
    async checkForUpdates() { u.checked++; if (u.hang) return new Promise(() => {}); return { downloadPromise: Promise.resolve(), cancellationToken: { cancel() { u.cancelled++; } } }; } };
  return u;
}
const statusFetch = (approved) => async () => new Response(JSON.stringify({ approvedVersion: approved }), { status: 200 });

function loopWith({ status, approved, isServer = true, prepare, now = () => Date.now(), stallMs, updater = fakeUpdater(), ask = async () => null, timeoutMs }) {
  let st = { state: 'idle', version: null, percent: null, ...status };
  const lines = [];
  const prepared = [];
  const loop = U.createUpdateLoop({
    status: () => st, set: (p) => { st = { ...st, ...p }; }, running: '1.0.5', isServer: () => isServer,
    log: (l) => lines.push(l), now, stallMs, askServer: ask,
    checkDeps: ({ running }) => ({
      updater, fetch: statusFetch(approved), cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running,
      log: (l) => lines.push(l), checkTimeoutMs: timeoutMs,
      share: { prepare: async (v) => { prepared.push(v); return prepare ? prepare(v) : 'ready'; }, route: () => ({ base: `${NODE}/node/cloud`, headers: {} }) },
    }),
  });
  return { loop, updater, lines, prepared, state: () => st, setState: (p) => { st = { ...st, ...p }; } };
}

console.log('\n1. A machine holding a downloaded update keeps checking\n');
{
  const a = loopWith({ status: { state: 'downloaded', version: '9.9.9' }, approved: '9.9.10' });
  await a.loop.check('hourly');
  ok('1: a server holding a downloaded update still fetches the next approved one for its tills', a.prepared[0] === '9.9.10', JSON.stringify(a.prepared));
  ok('…and downloads it for itself (newer than the one it holds)', a.updater.checked === 1 && a.updater.feed?.includes('/v/9.9.10/'), `${a.updater.checked} ${a.updater.feed}`);
  const b = loopWith({ status: { state: 'downloaded', version: '9.9.9' }, approved: '9.9.9' });
  await b.loop.check('hourly');
  ok('the same version approved: the branch copy is kept, nothing downloaded again', b.prepared[0] === '9.9.9' && b.updater.checked === 0, `${b.updater.checked}`);
  ok('…and the Tech page says why it has not changed', /9\.9\.9 downloaded — installs when ZapTill is closed/.test(b.state().note ?? ''), b.state().note);
  const c = loopWith({ status: { state: 'downloading', version: '9.9.9', percent: 40 }, approved: '9.9.9' });
  await c.loop.check('hourly');
  ok('a server mid-download still prepares the branch copy but leaves its own download alone', c.prepared[0] === '9.9.9' && c.updater.checked === 0);
  const t = loopWith({ status: { state: 'downloading', version: '9.9.9', percent: 40 }, approved: '9.9.9', isServer: false });
  const r = await t.loop.check('hourly');
  ok('a till mid-download does not ask (and logs why)', r === null && t.updater.checked === 0 && t.lines.some((l) => /download of 9\.9\.9 \(40%\) is under way/.test(l)), JSON.stringify(t.lines));
}

console.log('\n2. A server decides by its role, not by whether its port has bound yet\n');
{
  const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'autoUpdate.ts'), 'utf8');
  ok('2: the share is chosen by role (isNodeRole), and the port is read when the route is needed',
    /const server = isNodeRole\(cfg\?\.device_role \?\? null\);/.test(src) && /share: !server && cfg\?\.node_url \?/.test(src)
    && /route: \(\) => \{\s*const port = getNodePort\(\);/.test(src) && !/const port = isNodeRole\(cfg\?\.device_role \?\? null\) \? getNodePort\(\) : null;/.test(src));
  const updater = fakeUpdater();
  await U.runUpdateCheck({ updater, fetch: statusFetch('9.9.9'), cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '1.0.5',
    share: { prepare: async () => 'ready', route: () => null }, route: () => ({ base: CLOUD, headers: {} }) });
  ok('…with no port yet the server still fetches the branch copy and updates itself from the cloud', updater.feed === `${CLOUD}/api/desktop-update/v/9.9.9/`, updater.feed);
}

console.log('\n3. A stalled download or check is cut and tried again\n');
{
  let clock = 1_000_000;
  const a = loopWith({ status: {}, approved: '9.9.9', isServer: false, now: () => clock, stallMs: 60_000 });
  await a.loop.check('start');                                       // starts a download (the fake hands back its cancel)
  a.setState({ state: 'downloading', version: '9.9.9', percent: 12 });
  clock += 30_000;
  await a.loop.check('hourly');
  ok('a download making progress is left alone', a.updater.cancelled === 0 && a.updater.checked === 1);
  clock += 120_000;                                                  // no progress for 2.5 min > 1 min
  await a.loop.ask();
  ok('3: a stalled download is cancelled, said in the log, and the state lets the next check run',
    a.updater.cancelled === 1 && a.lines.some((l) => /no progress for \d+ min — cancelled/.test(l)) && a.state().state === 'error', `${a.updater.cancelled} ${a.state().state}`);
  await a.loop.check('hourly');
  ok('…and the next check starts it again', a.updater.checked === 2, String(a.updater.checked));

  const h = loopWith({ status: {}, approved: '9.9.9', isServer: false, timeoutMs: 200 });
  h.updater.hang = true;
  h.updater.checkForUpdatesPromise = 'stuck';
  const t0 = Date.now();
  const r = await h.loop.check('start');
  ok('a check whose feed never answers ends (timeout), and the updater\'s stuck check is forgotten',
    r?.timedOut === true && Date.now() - t0 < 2000 && h.updater.checkForUpdatesPromise === null && h.state().state === 'error', JSON.stringify(r));
  h.updater.hang = false;
  await h.loop.check('hourly');
  ok('…so the next check is not blocked', h.updater.checked === 2);
}

console.log('\n4. A till never waits for ever\n');
{
  const V = '9.9.10';
  ok('the server holds it → take it from the server', U.tillShareVerdict({ version: V, newer: true }, V, null, 0).verdict === 'ready');
  ok('an older server (no answer) → through it, as before', U.tillShareVerdict(null, V, null, 0).verdict === 'ready');
  const fetching = U.tillShareVerdict({ version: '9.9.9', newer: false, share: { version: V, state: 'fetching', failures: 0, error: null } }, V, Date.now() - 7 * 3600_000, Date.now());
  ok('the server is fetching it → wait, even after hours (said why)', fetching.verdict === 'busy' && /fetching 9\.9\.10/.test(fetching.reason), JSON.stringify(fetching));
  const stuck = U.tillShareVerdict({ version: null, newer: false, share: { version: V, state: 'failed', failures: 3, error: 'latest.yml: HTTP 500' } }, V, Date.now(), Date.now());
  ok('the server failed 3 times → download through it live (said why)', stuck.verdict === 'live' && /could not fetch 9\.9\.10 \(3 tries: latest\.yml: HTTP 500\)/.test(stuck.reason), JSON.stringify(stuck));
  const long = U.tillShareVerdict({ version: '9.9.9', newer: false }, V, Date.now() - 7 * 3600_000, Date.now());
  ok('told "not ready" for over 6 h with no fetch running → live', long.verdict === 'live');
  ok('…but not before', U.tillShareVerdict({ version: '9.9.9', newer: false }, V, Date.now() - 3600_000, Date.now()).verdict === 'busy');

  // The real server: its fetch of 9.9.8 fails three times.
  S._resetShareState();
  for (let i = 0; i < 3; i++) await S.prepareShare('9.9.8', serverDeps);
  const ans = await U.askBranchServer({ cfg: till(), running: '1.0.5', fetch: globalThis.fetch, want: '9.9.8' });
  ok('the server tells its tills how its fetch is going', ans?.share?.version === '9.9.8' && ans.share.state === 'failed' && ans.share.failures === 3
    && /HTTP 500/.test(ans.share.error ?? ''), JSON.stringify(ans));
  ok('…and the till reads that as "go live"', U.tillShareVerdict(ans, '9.9.8', Date.now(), Date.now()).verdict === 'live');
  cloudSeen.length = 0;
  const r = await fetch(`${NODE}/node/cloud/api/desktop-update/v/9.9.8/${R['9.9.8'].exe}`, { headers: { 'X-Node-Secret': SECRET, Authorization: 'Bearer tok-till' } });
  const buf = Buffer.from(await r.arrayBuffer());
  ok('4: a stuck server passes the till\'s request on to the cloud (whole installer)', r.status === 200 && buf.equals(R['9.9.8'].bytes)
    && cloudSeen.some((u) => u.endsWith(R['9.9.8'].exe)), `${r.status} ${buf.length}`);

  // A till that has waited long enough asks live (X-Update-Live) for a version the server never tried.
  const r2 = await fetch(`${NODE}/node/cloud/api/desktop-update/v/9.9.10/latest.yml`, { headers: { 'X-Node-Secret': SECRET, Authorization: 'Bearer tok-till' } });
  ok('without the live header (and not stuck) → 503 "still fetching", as A443', r2.status === 503);
  const r3 = await fetch(`${NODE}/node/cloud/api/desktop-update/v/9.9.10/latest.yml`, { headers: { 'X-Node-Secret': SECRET, Authorization: 'Bearer tok-till', 'X-Update-Live': '1' } });
  ok('with it → passed on to the cloud', r3.status === 200 && /version: 9\.9\.10/.test(await r3.text()));
  const upd = fakeUpdater();
  await U.runUpdateCheck({ updater: upd, fetch: statusFetch('9.9.10'), cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '1.0.5',
    share: { prepare: async () => 'live', route: () => null }, route: () => ({ base: `${NODE}/node/cloud`, headers: { 'X-Node-Secret': SECRET } }) });
  ok('a till told "live" sends the header with its download', upd.requestHeaders?.['X-Update-Live'] === '1' && upd.feed === `${NODE}/node/cloud/api/desktop-update/v/9.9.10/`, JSON.stringify(upd.requestHeaders));
}

console.log('\n5. Only the approved version is offered\n');
{
  S._resetShareState();
  ok('the server fetches 9.9.10', await S.prepareShare('9.9.10', serverDeps) === 'ready');
  const before = await U.askBranchServer({ cfg: till(), running: '1.0.5', fetch: globalThis.fetch });
  ok('before its first check, it offers its newest copy (as before)', before?.version === '9.9.10' && before.newer === true, JSON.stringify(before));
  S.noteApprovedForShare('9.9.9');                       // the owner rolled back to 9.9.9
  wanted.length = 0;
  const after = await U.askBranchServer({ cfg: till(), running: '1.0.5', fetch: globalThis.fetch });
  ok('5: a copy from before a roll-back is not offered as "newer"', after?.version === null && after.newer === false, JSON.stringify(after));
  ok('…and the server is told to fetch what is approved', wanted.length > 0);
  S.noteApprovedForShare(null);                          // on hold
  const held = await U.askBranchServer({ cfg: till(), running: '1.0.5', fetch: globalThis.fetch });
  ok('on hold: nothing offered', held?.version === null && held.newer === false);
  S.noteApprovedForShare('9.9.10');
  wanted.length = 0;
  const want = await U.askBranchServer({ cfg: till(), running: '1.0.5', fetch: globalThis.fetch, want: '9.9.11' });
  ok('a till that names a version the server does not hold makes it check now', want?.version === '9.9.10' && wanted.includes('9.9.11'), JSON.stringify(wanted));
  // The server's own check tells the share what is approved.
  const noted = [];
  await U.runUpdateCheck({ updater: fakeUpdater(), fetch: statusFetch('9.9.10'), cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '9.9.10',
    share: { prepare: async () => 'ready', route: () => null, approved: (v) => noted.push(v) } });
  await U.runUpdateCheck({ updater: fakeUpdater(), fetch: statusFetch(null), cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '9.9.10',
    share: { prepare: async () => 'ready', route: () => null, approved: (v) => noted.push(v) } });
  ok('the server\'s check reports the approval, a hold included', JSON.stringify(noted) === '["9.9.10",null]', JSON.stringify(noted));
}

console.log('\n6. Diagnostics\n');
{
  U._resetUpdateDiagnostics();
  U.noteUpdate('waiting: the branch server is fetching 9.9.10');
  const d = U.getUpdateDiagnostics();
  ok('each decision is kept for the Tech page, with its time', d.log.length === 1 && /fetching 9\.9\.10/.test(d.log[0].line) && !Number.isNaN(Date.parse(d.log[0].at)));
  ok('…and the status carries a note, the approval and when it last checked', 'note' in d.status && 'approved' in d.status && 'checkedAt' in d.status);
  for (let i = 0; i < 60; i++) U.noteUpdate(`line ${i}`);
  ok('…the last 40 only', U.getUpdateDiagnostics().log.length === 40);
  const a = loopWith({ status: {}, approved: '9.9.10', isServer: false, prepare: async () => 'busy' });
  await a.loop.check('start');
  ok('a waiting till says so in its status', /not ready yet \(busy\) — waiting/.test(a.state().note ?? '') && a.state().approved === '9.9.10' && !!a.state().checkedAt, JSON.stringify(a.state()));
  const told = [];
  const t = loopWith({ status: { state: 'downloaded', version: '9.9.10' }, approved: '9.9.10', isServer: false,
    ask: async () => { told.push(1); return { version: '9.9.10', newer: true }; } });
  await t.loop.ask();
  ok('a till holding the version the server offers does not re-check every 2 minutes', told.length === 1 && t.updater.checked === 0 && t.prepared.length === 0);
}

N.stopNodeServer?.();
cloud.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
