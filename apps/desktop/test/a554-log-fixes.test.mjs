// A554 (2026-10-21) — fixes found in the first pulled till log (B Foods, T1 "Left Till", the branch server, no other
// tills, the 1.0.20 test build labelled 1.0.19) and the owner's test.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/a554-log-fixes.test.mjs
//
// Drives the REAL compiled dist/main (liveSync with a stand-in WebSocket, autoUpdate's loop, singleInstance, nodeServer's
// port step, the auth:verifyPin handler and logFile's console capture) on a real SQLite file, electron shimmed; the
// shared panel helper from src/shared (strip-types).
//
//   1  the push channel (log: "push channel closed (1006)" every ~13 min, a minute after each token renewal): a renewed
//      token is told to an A554 cloud on the open socket (reauth → reauthed, nothing closes); not confirmed → a planned
//      reconnect with the new token; an older cloud (no features) → the planned reconnect at once (never a drop); the
//      keepalive pings every 25 s and a socket that does not answer in 20 s is replaced at once; an old cloud is not pinged.
//   2  the update question (log: a branch server asking "the branch server" every hour): a node, an office PC and a till
//      with no server never ask (and log nothing); a till behind a server does.
//   3  one ZapTill (log: a second instance started beside the tray one and bound 4101): a launch without the lock ends
//      (process.exit — app.quit() before ready let the start-up run); the relaunch after an update waits for the lock (at
//      most 30 s); the whenReady handler never runs without the lock; the branch server waits for 4100 before a fallback.
//   4  a wrong PIN (log: "Error occurred in handler for 'auth:verifyPin': Error: Invalid PIN at …"): the handler still
//      rejects with the same message (the renderer unchanged, the lockout counted), and the console line is not printed.
//   5  the categories panel starts collapsed at every start, pinned or not (the pin is never stored).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
//   - liveSync socketKeepalive without the renewed-token check                   → 1 "reauth on the open socket" fails
//   - liveSync onmessage not adopting the token on 'reauthed'                    → 1 "nothing more after reauthed" fails
//   - liveSync socketKeepalive without the PONG_WAIT_MS check                    → 1 "a dead socket is replaced" fails
//   - autoUpdate createUpdateLoop ask() without the behindServer check           → 2 "a node never asks" fails
//   - singleInstance secondLaunchStep always 'exit'                              → 3 "the relaunch waits" fails
//   - index.ts back to app.quit() without the lock                               → 3 "ends at once" fails
//   - nodeServer nextListenStep without the default-port wait                    → 3 "waits for 4100" fails
//   - logFile console.error without the expected-refusal check                   → 4 "no console line" fails
//   - signIn verifyPin throwing a plain Error for a 401                          → 4 "marked expected" fails
//   - menuFilter panelPrefsText storing the pin again / panelStartsOpen → pinned  → 5 fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A554_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A554_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a554-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {} } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8').replace(/\r\n/g, '\n');
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// The console as Electron's own code would reach it (captured before logFile loads: its originals are these).
const consoleErrors = [];
const realError = console.error;
console.error = (...a) => { consoleErrors.push(a); };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok-1', 'dev-T1', 'biz-1', 'B Foods', '2026-10-21T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Left Till' });
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok-1', refreshToken: 'r-1' });
const E = require(path.join(dist, 'syncEngine.js'));
const LS = require(path.join(dist, 'liveSync.js'));
const LF = require(path.join(dist, 'logFile.js'));
const logText = () => { try { return fs.readdirSync(userData).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(userData, f), 'utf8')).join('\n'); } catch { return ''; } };

console.log('A554 — fixes from the first pulled till log\n');
try {
  // ── 1 ── the push channel ───────────────────────────────────────────────────────────────────────────────────────
  const made = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = null; made.push(this); queueMicrotask(() => this.onopen?.()); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close(code, reason) { this.closed = { code: code ?? null, reason: reason ?? null }; }
    says(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  globalThis.WebSocket = FakeWS;
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('live_seq', '500', ?)`).run(new Date().toISOString());
  const open = async (token, features) => {
    E.configureSyncEngine('http://cloud', token, 'r-1');
    LS._openLiveSocket(Date.now());
    const s = made[made.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    s.says({ type: 'ready', last_seq: 500, ...(features ? { features } : {}) });
    return s;
  };
  const sentOf = (s, type) => s.sent.filter((m) => m.type === type);

  LS._resetLive();
  const s1 = await open('tok-1', ['ping', 'reauth']);
  ok('the socket signs in with the token it was opened with (hello)', sentOf(s1, 'hello')[0]?.token === 'tok-1', JSON.stringify(s1.sent));
  const t0 = Date.now();
  ok('…an open socket that just spoke: nothing to send', LS.socketKeepalive(t0) === 'none' && s1.sent.length === 1);

  E.configureSyncEngine('http://cloud', 'tok-2', 'r-1');   // the 13-minute renewal
  const r1 = LS.socketKeepalive(t0 + 1000);
  ok('A554: a renewed token is told to an A554 cloud on the OPEN socket (reauth) — nothing closed, no new socket',
    r1 === 'reauth' && sentOf(s1, 'reauth')[0]?.token === 'tok-2' && s1.closed === null && made.length === 1, JSON.stringify({ r1, sent: s1.sent, n: made.length }));
  ok('…asked once (the next look waits for the answer)', LS.socketKeepalive(t0 + 2000) === 'none' && sentOf(s1, 'reauth').length === 1);
  s1.says({ type: 'reauthed' });
  ok('…reauthed: nothing more is sent for that token, the socket stays (the cloud moved its expiry)',
    LS.socketKeepalive(t0 + 20_000) === 'none' && sentOf(s1, 'reauth').length === 1 && s1.closed === null && made.length === 1);

  E.configureSyncEngine('http://cloud', 'tok-3', 'r-1');
  LS.socketKeepalive(t0 + 21_000);
  const r2 = LS.socketKeepalive(t0 + 21_000 + LS.REAUTH_WAIT_MS);
  const s2 = made[made.length - 1];
  ok('A554: a reauth the cloud did not confirm in 15 s → the planned reconnect: closed by the till (1000) and opened again at once with the new token',
    r2 === 'renew' && s1.closed?.code === 1000 && made.length === 2 && s2 !== s1, JSON.stringify({ r2, closed: s1.closed, n: made.length }));
  await new Promise((r) => setTimeout(r, 0));
  ok('…the new socket signs in with the renewed token', sentOf(s2, 'hello')[0]?.token === 'tok-3', JSON.stringify(s2.sent));

  // keepalive
  s2.says({ type: 'ready', last_seq: 500, features: ['ping', 'reauth'] });
  const k0 = Date.now();
  ok('A554: the keepalive — no ping within 25 s of the last message', LS.socketKeepalive(k0 + 10_000) === 'none' && sentOf(s2, 'ping').length === 0);
  ok('…a ping once 25 s pass', LS.socketKeepalive(k0 + LS.KEEPALIVE_MS) === 'ping' && sentOf(s2, 'ping').length === 1);
  ok('…not a second while it waits for the answer', LS.socketKeepalive(k0 + LS.KEEPALIVE_MS + 5000) === 'none' && sentOf(s2, 'ping').length === 1);
  s2.says({ type: 'pong' });
  ok('…answered: the line is alive (nothing replaced)', LS.socketKeepalive(Date.now() + 1000) === 'none' && made.length === 2);
  const p0 = Date.now() + LS.KEEPALIVE_MS;
  LS.socketKeepalive(p0);   // the next ping
  const before = made.length;
  const r3 = LS.socketKeepalive(p0 + LS.PONG_WAIT_MS);
  ok('A554: a ping not answered in 20 s → the socket is dead and replaced AT ONCE (no back-off, no 1006 wait)',
    r3 === 'dead' && made.length === before + 1 && s2.closed !== null, JSON.stringify({ r3, n: made.length }));

  // an older cloud: no features
  LS._resetLive();
  const s3 = await open('tok-4', null);
  ok('an older cloud (no features in ready): never pinged — it pings the till itself', LS.socketKeepalive(Date.now() + 60_000) === 'none' && sentOf(s3, 'ping').length === 0);
  E.configureSyncEngine('http://cloud', 'tok-5', 'r-1');
  const n3 = made.length;
  const r4 = LS.socketKeepalive(Date.now() + 61_000);
  ok('A554: …a renewed token → the planned reconnect at once (before the old token runs out — never the cloud\'s close, never a 1006)',
    r4 === 'renew' && s3.closed?.code === 1000 && made.length === n3 + 1, JSON.stringify({ r4, closed: s3.closed }));
  ok('…and a planned reconnect is not logged as a dropped channel', !/A531: push channel closed/.test(logText()) && /A554: push channel signed in again/.test(logText()));
  const s4 = made[made.length - 1];
  await new Promise((r) => setTimeout(r, 0));
  s4.says({ type: 'ready', last_seq: 500 });
  s4.onclose?.({ code: 1006 });
  ok('a real drop of an open socket is still logged as before (A531)', /A531: push channel closed \(1006\)/.test(logText()));
  LS._resetLive();
  ok('the server side answers ping and reauth (apps/server liveHub — tests/sync-changes-a531.test.mjs W A554)',
    /if \(msg\?\.type === 'ping'\) \{ c\.alive = true; send\(c, \{ type: 'pong' \}\); return; \}/.test(fs.readFileSync(path.join(desktop, '..', 'server', 'src', 'lib', 'liveHub.ts'), 'utf8')));

  // ── 2 ── the update question ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n2. A branch server never asks "the branch server" about updates\n');
  const U = require(path.join(dist, 'autoUpdate.js'));
  ok('asksBranchServer: a node, an office PC → no (they ARE the server); a till with no server → no; behind one → yes',
    U.asksBranchServer({ device_role: 'node', node_url: 'http://192.168.1.5:4100' }) === false
    && U.asksBranchServer({ device_role: 'office', node_url: null }) === false
    && U.asksBranchServer({ device_role: 'till', node_url: '' }) === false && U.asksBranchServer({ device_role: 'till', node_url: '  /' }) === false
    && U.asksBranchServer(null) === false
    && U.asksBranchServer({ device_role: 'till', node_url: 'https://192.168.1.5:4100' }) === true);
  const loopFor = (behind) => {
    const logs = []; let asked = 0;
    const loop = U.createUpdateLoop({ status: () => ({ state: 'idle', version: null, percent: null }), set() {}, running: '1.0.19',
      isServer: () => !behind, checkDeps: () => { throw new Error('no check here'); }, askServer: async () => { asked++; return null; },
      log: (l) => logs.push(l), behindServer: () => behind });
    return { loop, logs, asked: () => asked };
  };
  const node = loopFor(false);
  for (let i = 0; i < 31; i++) await node.loop.ask();   // an hour of 2-minute asks
  ok('A554: the branch server\'s 2-minute question: never asked, nothing logged (the hourly "did not answer" line is gone)',
    node.asked() === 0 && node.logs.length === 0, JSON.stringify({ asked: node.asked(), logs: node.logs }));
  const peer = loopFor(true);
  for (let i = 0; i < 31; i++) await peer.loop.ask();
  ok('…a till behind a server still asks every time, and says so at most once in 30 (an hour)',
    peer.asked() === 31 && peer.logs.filter((l) => /did not answer the update question/.test(l)).length === 2, JSON.stringify({ asked: peer.asked(), logs: peer.logs.length }));
  ok('…the wiring: initAutoUpdate hands the loop the role check (read on every ask)',
    /behindServer: \(\) => asksBranchServer\(getDeviceConfig\(\) as any\),/.test(src('main/autoUpdate.ts'))
    && /if \(!c \|\| !asksBranchServer\(c\)\) return null;/.test(src('main/autoUpdate.ts')));

  // ── 3 ── one ZapTill ───────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n3. One ZapTill per machine\n');
  const SI = require(path.join(dist, 'singleInstance.js'));
  ok('secondLaunchStep: a launch by hand, the sign-in task, the restart task → end; the relaunch after an update → wait (30 s at most)',
    SI.secondLaunchStep(['zaptill.exe'], 0) === 'exit' && SI.secondLaunchStep(['zaptill.exe', '--at-login'], 0) === 'exit'
    && SI.secondLaunchStep(['zaptill.exe', '--watchdog'], 0) === 'exit'
    && SI.secondLaunchStep(['zaptill.exe', '--updated'], 0) === 'wait' && SI.secondLaunchStep(['zaptill.exe', '--updated'], SI.LOCK_WAIT_MS) === 'exit');
  {
    let clock = 0, asks = 0;
    const got = SI.takeSingleInstanceLock({ request: () => ++asks >= 4, argv: ['x', '--updated'], sleep: (ms) => { clock += ms; }, now: () => clock });
    ok('A554: the relaunch after an update waits for the old ZapTill to let go of the lock (asked again every 0.5 s), then runs', got === true && asks === 4 && clock === 1500, JSON.stringify({ got, asks, clock }));
    clock = 0; asks = 0;
    const gave = SI.takeSingleInstanceLock({ request: () => { asks++; return false; }, argv: ['x', '--updated'], sleep: (ms) => { clock += ms; }, now: () => clock });
    ok('…and gives up after 30 s (the old one is still running: it stays the one)', gave === false && clock >= SI.LOCK_WAIT_MS && asks === SI.LOCK_WAIT_MS / SI.LOCK_RETRY_MS + 1, JSON.stringify({ gave, clock, asks }));
    asks = 0;
    const byHand = SI.takeSingleInstanceLock({ request: () => { asks++; return false; }, argv: ['x'], sleep: () => { throw new Error('never waits'); } });
    ok('…a second launch by hand asks once and ends (the running ZapTill shows its window)', byHand === false && asks === 1);
  }
  const idx = src('main/index.ts');
  ok('A554: index.ts — without the lock the launch ENDS (process.exit), never app.quit() (before ready it let the whole start-up run)',
    /const gotTheLock = takeSingleInstanceLock\(\{ request: \(\) => app\.requestSingleInstanceLock\(\), argv: process\.argv, sleep: sleepSync \}\);\s*if \(!gotTheLock\) \{\s*process\.exit\(0\);/.test(idx)
    && !/if \(!gotTheLock\) \{\s*app\.quit\(\);/.test(idx));
  ok('…and the start-up never runs without the lock (whenReady checks it first)', /app\.whenReady\(\)\.then\(async \(\) => \{\s*if \(!gotTheLock\) return;/.test(idx));
  ok('…a second launch by hand still shows the running ZapTill (second-instance → showWindow)', /app\.on\('second-instance', \(_e, argv\) => \{[\s\S]{0,700}showWindow\(\);/.test(idx));
  const NS = require(path.join(dist, 'nodeServer.js'));
  {
    const steps = []; let a = 0, t = 0;
    for (let i = 0; i < 14; i++) { const s = NS.nextListenStep(a, t); if (!s) { steps.push(null); break; } if (s.attempt === a) t++; else { a = s.attempt; t = 0; } steps.push(s); }
    const onDefault = steps.filter((s) => s && s.attempt === 0);
    ok('A554: the branch server waits for 4100 (every 2 s, 20 s) before 4101 — a ZapTill still closing gets its port back',
      onDefault.length === NS.DEFAULT_PORT_WAIT_TRIES && onDefault.every((s) => s.delayMs === NS.DEFAULT_PORT_WAIT_MS) && steps[NS.DEFAULT_PORT_WAIT_TRIES]?.attempt === 1,
      JSON.stringify(steps));
    ok('…then the fallbacks as before (4101–4103), then none', NS.nextListenStep(1, 0)?.attempt === 2 && NS.nextListenStep(3, 0) === null);
  }

  // ── 4 ── a wrong PIN ───────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n4. A wrong PIN is an answer, not an error\n');
  const SIGNED = { 'content-type': 'application/json', 'x-zaptill-server': '1' };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/auth/verify-pin')) return new Response(JSON.stringify({ error: 'Invalid PIN' }), { status: 401, headers: SIGNED });
    return new Response('{}', { status: 200, headers: SIGNED });
  };
  E.configureSyncEngine('http://cloud', 'tok-1', 'r-1');
  require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
  const H = global.__handlers;
  LF.installConsoleCapture();
  const failures = () => Number(JSON.parse(db.prepare(`SELECT value FROM maintenance_state WHERE key = 'pin_attempts'`).get()?.value ?? '{}').failures ?? 0);
  const failuresBefore = failures();
  const e1 = await rejects(H['auth:verifyPin']({}, { pin: '9999', branch_id: 'br-1' }));
  ok('the handler still REJECTS with "Invalid PIN" — what the renderer gets is unchanged (Error: Invalid PIN)',
    e1 && e1.message === 'Invalid PIN' && String(e1) === 'Error: Invalid PIN', String(e1));
  ok('A554: …marked an expected answer', e1?.zaptillExpected === true);
  ok('…and counted toward the lockout as before', failures() === failuresBefore + 1, JSON.stringify({ now: failures(), failuresBefore }));
  consoleErrors.length = 0;
  console.error(`Error occurred in handler for 'auth:verifyPin':`, e1);   // what Electron's ipc code does with it
  ok('A554: Electron\'s "Error occurred in handler" line for it is NOT printed (no stack in the log) — one short line instead',
    consoleErrors.length === 0 && /\[ipc\] auth:verifyPin: Invalid PIN \(an expected answer/.test(logText()) && !/Error occurred in handler for 'auth:verifyPin'/.test(logText()),
    JSON.stringify(consoleErrors.map((a) => String(a[0]))));
  const real = new Error('SQLITE_CORRUPT: database disk image is malformed');
  console.error(`Error occurred in handler for 'pos:createOrder':`, real);
  ok('…a real handler error is still printed and logged as before', consoleErrors.length === 1 && /Error occurred in handler for 'pos:createOrder'/.test(logText()));
  ok('…and the renderer\'s handling is untouched (posApi still turns "Invalid PIN" into the friendly line; PinPage shows e.message)',
    /\[\/invalid pin\/i,\s+'That PIN was not recognised\. Please try again\.'\]/.test(src('renderer/lib/posApi.ts'))
    && /setError\(e\?\.message \?\? 'Invalid PIN'\);/.test(src('renderer/pages/PinPage.tsx')));
  ok('…the lockout and the till\'s own check are marked too (signIn.ts)',
    /try \{ assertPinAllowed\(\); \} catch \(e\) \{ throw expectedRefusal\(e as Error\); \}/.test(src('main/ipc/signIn.ts'))
    && /throw expectedRefusal\(new Error\(nodeSaidNo \?\? /.test(src('main/ipc/signIn.ts')));

  // ── 5 ── the categories panel ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n5. The categories panel starts collapsed\n');
  const M = await import(pathToFileURL(path.join(desktop, '..', '..', 'packages', 'core', 'src', 'menuFilter.ts')).href);
  const stored = M.panelPrefsText({ pinned: true, menu: 'drinks' });
  ok('A554: a pin is never stored (only the menu) and a stored one (an older build) is not honoured',
    !/pinned/.test(stored) && M.parsePanelPrefs(stored).menu === 'drinks' && M.parsePanelPrefs('{"pinned":true,"menu":"tea"}').pinned === false, stored);
  ok('A554: the panel starts collapsed at every start — pinned or not', M.panelStartsOpen() === false);
  ok('…the till and the web POS both open it collapsed (the hook takes no stored state for it)',
    /useState<boolean>\(\(\) => panelStartsOpen\(\)\)/.test(src('renderer/components/CategoryPanel.tsx'))
    && /useState<boolean>\(\(\) => panelStartsOpen\(\)\)/.test(fs.readFileSync(path.join(desktop, '..', 'dashboard', 'src', 'pages', 'pos', 'cashier', 'CategoryPanel.tsx'), 'utf8')));
  ok('…a pin still keeps it open after a pick during the session', M.panelOpenAfterPick({ pinned: true, menu: 'all' }) === true && M.panelOpenAfterPick({ pinned: false, menu: 'all' }) === false);
} finally {
  console.error = realError;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
