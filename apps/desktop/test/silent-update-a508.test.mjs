// A508 — usage-aware silent updates: a till left open, and a branch server (never closed), install their downloaded,
// still-approved update on their own when nobody is using them.
//
// Owner, 2026-10-16: "some clients take forever to update unless am there we need to find a way of silently updating
// tills and server" — and not a fixed 02:00–05:00 window: "can the till or server check if its in use track usage".
//
// RUNS the real compiled dist/main (electron and electron-updater shimmed, REAL SQLite):
//   cd apps/desktop && npm run build:main && TZ=UTC node test/silent-update-a508.test.mjs
//
// Covers: the quiet-hour profile (168 buckets, the < 7 days fallback, a till's own sales vs a server's branch rows),
// installVerdict (busy / idle / quiet / 90 min / 72 h / a server's tills / not approved / the share / Windows' prompt /
// a sync push), the install sequence (flush → stop the node server (server) → quitAndInstall(true, true)), the record
// and the post-restart line, the activity pings over IPC (throttled — main and the renderer's helper), the main-process
// events, the Windows elevation probe, and that the cashier's update bar shows nothing for it.
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - installVerdict without the busy check                         → "busy: a sale in the cart → no" fails
//   - installVerdict without the approved check (A503)              → "not approved → never" fails
//   - IDLE_LONG_MS check dropped                                    → "idle 95 min outside a quiet hour → install" fails
//   - the server's lastTill left out of lastActivity                 → "server: a till trading 5 min ago → no" fails
//   - runIdleInstall calling quitAndInstall before the flush         → "the order: flush → stop → quitAndInstall" fails
//   - noteRendererPing without the 30-s throttle                    → "IPC pings: 10 in 10 s → 1 taken" fails
//   - usageProfile ties Sunday-first (no hour tie-break)            → "a shop shut every night: 00:00–05:59 quiet EVERY night" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a508-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {}); const listeners = (global.__listeners = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on(ch, fn) { listeners[ch] = fn; }, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true },
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
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

if (new Date(0).getTimezoneOffset() !== 0) console.log('  (note: run with TZ=UTC — the hour-of-week checks below are written in UTC)');

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Front', configured: true });
const A = require(path.join(dist, 'activityTracker.js'));
const U = require(path.join(dist, 'autoUpdate.js'));
const E = require(path.join(dist, 'syncEngine.js'));

// A Wednesday noon, UTC: 2026-10-14T12:00Z.
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const how = (day, hour) => day * 24 + hour;   // hour of week, Sunday 00:00 = 0

console.log('\n1. The usage profile — 168 buckets, the quietest 25%\n');
{
  const p = A.usageProfile([], NOW);
  ok('no sales: 168 buckets, the fallback night (01:00–05:00 every day)',
    p.buckets.length === 168 && p.quiet.length === 168 && p.fallback === true
    && p.quiet.filter(Boolean).length === 28 && [1, 2, 3, 4].every((h) => [0, 1, 2, 3, 4, 5, 6].every((d) => p.quiet[how(d, h)]))
    && !p.quiet[how(3, 0)] && !p.quiet[how(3, 5)], JSON.stringify({ n: p.quiet.filter(Boolean).length, f: p.fallback }));
  const six = [];
  for (let d = 0; d < 6; d++) for (let h = 8; h < 22; h++) six.push(NOW - d * DAY - (12 - h) * HOUR);
  const p6 = A.usageProfile(six, NOW);
  ok('under 7 days of sales: still the fallback night', p6.fallback === true && p6.days < 7 && p6.quiet[how(3, 2)] && !p6.quiet[how(3, 23)], `${p6.days}`);

  // A shop open 08:00–21:59 every day for 28 days (a few sales an hour), shut every night.
  const shop = [];
  for (let d = 0; d < 28; d++) for (let h = 8; h < 22; h++) for (let k = 0; k < 3; k++) {
    const t = Date.UTC(2026, 9, 14 - d, h, 10 + k * 10);
    if (t <= NOW) shop.push(t);
  }
  const ps = A.usageProfile(shop, NOW);
  const quietHours = new Set(ps.quiet.map((q, i) => (q ? i % 24 : -1)).filter((h) => h >= 0));
  ok('a shop shut every night: 42 quiet hours, 00:00–05:59 quiet EVERY night (ties go to the earlier hour of the day)',
    ps.fallback === false && ps.quiet.filter(Boolean).length === 42
    && [0, 1, 2, 3, 4, 5].every((h) => [0, 1, 2, 3, 4, 5, 6].every((d) => ps.quiet[how(d, h)])) && quietHours.size === 6,
    JSON.stringify([...quietHours]));
  ok('…and never a trading hour', !ps.quiet[how(3, 12)] && !ps.quiet[how(5, 20)] && !ps.quiet[how(6, 8)]);
  ok('the buckets count the sales of the hour (local time)', ps.buckets[how(3, 9)] > 0 && ps.buckets[how(3, 3)] === 0);

  // A 24-hour place: 5 sales every hour, except a slow spell of 42 chosen hours (1 sale) — those are the quiet ones.
  const slow = new Set();
  for (let d = 0; d < 7; d++) for (const h of [14, 15, 16, 17, 18, 19]) slow.add(how(d, h));   // afternoons are its slow time
  const allDay = [];
  for (let d = 1; d <= 28; d++) for (let h = 0; h < 24; h++) {
    const t0 = NOW - d * DAY + (h - 12) * HOUR + 5 * MIN;
    const n = slow.has(A.hourOfWeek(t0)) ? 1 : 5;
    for (let k = 0; k < n; k++) allDay.push(t0 + k * MIN);
  }
  const pa = A.usageProfile(allDay, NOW);
  ok('a 24-hour place: its slowest hours (here the afternoons) are quiet, not 2–5 am',
    [...slow].every((i) => pa.quiet[i]) && !pa.quiet[how(3, 3)], `${[...slow].filter((i) => !pa.quiet[i]).length} slow hours not quiet`);
  ok('sales older than 28 days are not counted', A.usageProfile([NOW - 40 * DAY, NOW - 35 * DAY], NOW).buckets.reduce((a, b) => a + b, 0) === 0);

  // From the real database: a till counts its own sales, a branch server every sale it holds.
  const ins = db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, device_id)
                          VALUES (?, 'biz-1', 'br-1', ?, 100, 16, 116, ?, ?)`);
  let n = 0;
  for (let d = 1; d <= 20; d++) {
    ins.run(`o-own-${d}`, `B-${++n}`, new Date(NOW - d * DAY).toISOString(), 'dev-T1');
    ins.run(`o-other-${d}`, `B-${++n}`, new Date(NOW - d * DAY + HOUR).toISOString(), 'dev-T2');
  }
  A._resetProfileCache();
  const till = A.loadUsageProfile({ server: false, deviceId: 'dev-T1' }, NOW);
  A._resetProfileCache();
  const server = A.loadUsageProfile({ server: true, deviceId: 'dev-S' }, NOW);
  const sum = (b) => b.reduce((a, x) => a + x, 0);
  ok('the real orders table: a till counts its own 20 sales, a server all 40 of the branch',
    sum(till.buckets) === 20 && sum(server.buckets) === 40 && till.fallback === false, `${sum(till.buckets)} ${sum(server.buckets)}`);
}

console.log('\n2. installVerdict\n');
const base = (o = {}) => ({
  running: '1.0.16', downloaded: '1.0.17', approved: true, downloadedAt: NOW - 2 * HOUR, shareReady: true, blocker: null,
  busy: null, lastActivity: NOW - 25 * MIN, lastTill: 0, quietNow: true, syncSince: null, ...o,
});
{
  const v = (o) => A.installVerdict(base(o), NOW);
  ok('idle 25 min in a quiet hour → install', v({}).install === true, v({}).reason);
  ok('busy: a sale in the cart → no', v({ busy: 'a sale is in the cart' }).install === false && /cart/.test(v({ busy: 'a sale is in the cart' }).reason));
  ok('busy: the payment screen → no; a print queued → no', !v({ busy: 'the payment screen is open' }).install && !v({ busy: '1 print job is still queued' }).install);
  ok('idle 15 min in a quiet hour → not yet', v({ lastActivity: NOW - 15 * MIN }).install === false);
  ok('idle 25 min outside a quiet hour → not yet', v({ quietNow: false }).install === false, v({ quietNow: false }).reason);
  ok('idle 95 min outside a quiet hour → install', v({ quietNow: false, lastActivity: NOW - 95 * MIN }).install === true);
  ok('72 h fallback: downloaded 73 h ago, quiet, idle 12 min → install', v({ downloadedAt: NOW - 73 * HOUR, lastActivity: NOW - 12 * MIN }).install === true);
  ok('…downloaded 71 h ago, idle 12 min → not yet', v({ downloadedAt: NOW - 71 * HOUR, lastActivity: NOW - 12 * MIN }).install === false);
  ok('…downloaded 73 h ago, idle 12 min but not a quiet hour → not yet', v({ downloadedAt: NOW - 73 * HOUR, lastActivity: NOW - 12 * MIN, quietNow: false }).install === false);
  ok('…downloaded 73 h ago, idle 8 min → not yet', v({ downloadedAt: NOW - 73 * HOUR, lastActivity: NOW - 8 * MIN }).install === false);
  ok('not approved (A503) → never, however idle', v({ approved: false, lastActivity: NOW - 10 * HOUR }).install === false
    && /no longer approved/.test(v({ approved: false }).reason));
  ok('nothing downloaded, or not newer than what runs → no', !v({ downloaded: null }).install && !v({ downloaded: '1.0.16' }).install && !v({ downloaded: '1.0.9' }).install);
  ok('a server whose branch copy is not ready (A496) → waits', v({ shareReady: false }).install === false && /branch's copy/.test(v({ shareReady: false }).reason));
  ok('Windows would ask for permission → never silently (installs on close)', v({ blocker: 'Windows asks for permission (UAC)' }).install === false
    && /installs when ZapTill is closed/.test(v({ blocker: 'x' }).reason));
  ok('a sync push started 30 s ago → waits; one in flight for 3 min (hung) → install', v({ syncSince: NOW - 30_000 }).install === false
    && v({ syncSince: NOW - 3 * MIN }).install === true);
}

console.log('\n3. The idle installer — activity, a server\'s points of sale, the install sequence\n');
const fakeDeps = (o = {}) => {
  const calls = [];
  const d = {
    running: '1.0.16', now: () => NOW,
    candidate: () => ({ version: '1.0.17', approved: true }),
    isServer: () => false, shareReady: () => true, blocker: async () => null,
    activity: () => ({ lastUse: NOW - 30 * MIN, lastUseWhat: 'input', lastTill: 0, busy: null }),
    quiet: () => true, downloadedAt: () => NOW - HOUR, syncSince: () => null,
    flush: async (ms) => { calls.push(`flush:${ms}`); return { pushed: 2, errors: [], timedOut: false }; },
    markQuitting: () => calls.push('markQuitting'),
    stopNodeServer: () => calls.push('stopNodeServer'),
    record: (r) => calls.push(`record:${r.from}->${r.to}:${r.reason}`),
    closeDb: () => calls.push('closeDb'),
    quitAndInstall: (s, f) => calls.push(`quitAndInstall:${s},${f}`),
    log: (l) => calls.push(`log:${l}`), note: () => {},
    ...o,
  };
  return { d, calls };
};
{
  const { d, calls } = fakeDeps({ isServer: () => true });
  const r = await U.createIdleInstaller(d).tick();
  const steps = calls.filter((c) => !c.startsWith('log:'));
  ok('a server, idle in a quiet hour: installs', r.install === true, r.reason);
  ok('the order: flush (60 s cap) → record → stop the node server → close the database → quitAndInstall(true, true)',
    JSON.stringify(steps) === JSON.stringify(['flush:60000', 'record:1.0.16->1.0.17:idle', 'markQuitting', 'stopNodeServer', 'closeDb', 'quitAndInstall:true,true']),
    JSON.stringify(steps));
  ok('…and it says so in one plain sentence first', /^log:installing 1\.0\.17 now while nobody is using this branch server/.test(calls[0]), calls[0]);
  const t = fakeDeps();
  await U.createIdleInstaller(t.d).tick();
  ok('a till: the same, without stopping a node server', !t.calls.includes('stopNodeServer') && t.calls.at(-1) === 'quitAndInstall:true,true', JSON.stringify(t.calls));

  const s2 = fakeDeps({ isServer: () => true, activity: () => ({ lastUse: NOW - 5 * HOUR, lastUseWhat: 'input', lastTill: NOW - 5 * MIN, busy: null }) });
  const r2 = await U.createIdleInstaller(s2.d).tick();
  ok('server: nobody at it for 5 h but a till trading 5 min ago → no', r2.install === false && !s2.calls.some((c) => c.startsWith('quitAndInstall')) && /a POS was trading/.test(r2.reason), r2.reason);
  const s3 = fakeDeps({ isServer: () => true, shareReady: () => false });
  ok('server: the branch copy not ready → no', (await U.createIdleInstaller(s3.d).tick()).install === false);
  const s4 = fakeDeps({ candidate: () => ({ version: '1.0.17', approved: false }) });
  ok('not approved any more → no, and the install never starts', (await U.createIdleInstaller(s4.d).tick()).install === false && !s4.calls.some((c) => c.startsWith('flush')));
  const s5 = fakeDeps({ blocker: async () => 'Windows asks for permission (UAC) before an install, and nobody is there to give it' });
  const r5 = await U.createIdleInstaller(s5.d).tick();
  ok('Windows would prompt → no, and the reason is logged once', r5.install === false && s5.calls.filter((c) => /UAC/.test(c)).length === 1);
  const s6 = fakeDeps({ failedBefore: (v) => v === '1.0.17' });
  ok('an earlier idle install of the same version that did not take → not tried again', (await U.createIdleInstaller(s6.d).tick()).install === false);
  const s7 = fakeDeps({ flush: async () => { s7.calls.push('flush'); return { pushed: 0, errors: ['no answer in 60 s'], timedOut: true }; } });
  await U.createIdleInstaller(s7.d).tick();
  ok('a flush that times out never blocks the install (logged, then installs)', s7.calls.at(-1) === 'quitAndInstall:true,true'
    && s7.calls.some((c) => /did not finish/.test(c)), JSON.stringify(s7.calls));
  const s8 = fakeDeps();
  const inst = U.createIdleInstaller(s8.d);
  await inst.tick(); await inst.tick();
  ok('installs once (a second tick does nothing)', s8.calls.filter((c) => c.startsWith('quitAndInstall')).length === 1);
  const s9 = fakeDeps({ activity: () => ({ lastUse: NOW - 3 * MIN, lastUseWhat: 'input', lastTill: 0, busy: null }) });
  const i9 = U.createIdleInstaller(s9.d);
  for (let k = 0; k < 5; k++) await i9.tick();
  ok('the "not yet" reason is logged once, not once a minute', s9.calls.filter((c) => c.startsWith('log:')).length === 1, JSON.stringify(s9.calls));
}

console.log('\n4. flushBeforeInstall — one push pass, capped\n');
{
  const r0 = await E.flushBeforeInstall(1_000);
  ok('nothing configured: returns at once, not timed out', r0.timedOut === false, JSON.stringify(r0));
  // A cloud that never answers (and ignores the abort): the flush gives up at its cap.
  db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'r', 'dev-T1', 'biz-1', 'B', '2026-10-14T00:00:00Z')`).run();
  db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, status, created_at, sync_status)
              VALUES ('day-1', 'biz-1', 'br-1', 'dev-T1', 'T1', '2026-10-14', ?, 'open', ?, 'pending')`).run(new Date().toISOString(), new Date().toISOString());
  E.configureSyncEngine('http://cloud', 't', 'r');
  globalThis.fetch = () => new Promise(() => {});
  const t0 = Date.now();
  const r1 = await E.flushBeforeInstall(400);
  ok('a cloud that never answers: the flush stops at its cap (never blocks the install for ever)', r1.timedOut === true && Date.now() - t0 < 5_000, JSON.stringify(r1));
  ok('…and while it hangs, syncPushSince says a push is in flight', typeof E.syncPushSince() === 'number');
}

console.log('\n5. The record, and the line after the restart\n');
{
  U._resetUpdateDiagnostics();
  U.recordIdleInstall({ from: '1.0.16', to: '1.0.17', at: new Date(NOW).toISOString(), reason: 'idle', why: 'idle 25 min in a quiet hour' });
  const kept = JSON.parse(db.prepare(`SELECT value FROM maintenance_state WHERE key = 'update_idle_install'`).get().value);
  ok('recorded in maintenance_state: {from, to, at, reason: idle}', kept.from === '1.0.16' && kept.to === '1.0.17' && kept.reason === 'idle' && kept.at);
  const r = U.reportIdleInstall('1.0.17');
  const d1 = U.getUpdateDiagnostics();
  ok('after the restart on 1.0.17: "updated from 1.0.16 to 1.0.17 while idle" in the update log', r?.ok === true
    && d1.log.some((l) => /updated from 1\.0\.16 to 1\.0\.17 while idle/.test(l.line)), JSON.stringify(d1.log));
  ok('…in getUpdateDiagnostics and getUpdateStatus (the Tech page)', d1.idleInstall?.ok === true && d1.idleInstall.to === '1.0.17'
    && U.getUpdateStatus().idleInstall?.from === '1.0.16');
  U._resetUpdateDiagnostics();
  U.reportIdleInstall('1.0.17');
  ok('…logged once (not again at every start)', !U.getUpdateDiagnostics().log.length);
  U._resetUpdateDiagnostics();
  U.recordIdleInstall({ from: '1.0.16', to: '1.0.18', at: new Date(NOW).toISOString(), reason: 'idle' });
  const bad = U.reportIdleInstall('1.0.16');
  ok('an install that did not take: said plainly, ok = false', bad?.ok === false && U.getUpdateDiagnostics().log.some((l) => /still runs 1\.0\.16/.test(l.line)));
  const banner = fs.readFileSync(path.join(desktop, 'src/renderer/pages/UpdateBanner.tsx'), 'utf8');
  ok('the cashier\'s update bar shows nothing for it (it reads only downloading / downloaded)',
    !/idleInstall|idleNote|while idle/.test(banner) && /const shown = \(downloading \|\| ready\) && !dismissed/.test(banner));
  const panel = fs.readFileSync(path.join(desktop, 'src/renderer/components/UpdateDiagnosticsPanel.tsx'), 'utf8');
  ok('the Tech page\'s update panel shows it', /update-idle-install/.test(panel) && /while idle/.test(panel));
}

console.log('\n6. Activity — the IPC ping (throttled), the main-process events, a server\'s points of sale\n');
{
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
  const ping = global.__listeners['activity:ping'];
  ok('activity:ping is registered (ipcMain.on — fire and forget)', typeof ping === 'function');
  A._resetActivity(0);
  const realNow = Date.now;
  let fake = NOW;
  Date.now = () => fake;
  try {
    for (let k = 0; k < 10; k++) { ping({}, { input: true }); fake += 1_000; }
    ok('IPC pings: 10 in 10 s → 1 taken', A._pingsTaken() === 1, String(A._pingsTaken()));
    fake += 30_000;
    ping({}, { input: true });
    ok('…and the next one after 30 s is taken', A._pingsTaken() === 2 && A.activitySnapshot().lastUse === fake);
    ping({}, 'junk'); ping({}, null); ping({}, { input: 'yes' });
    ok('anything else is ignored', A._pingsTaken() === 2);
    ping({}, { busy: { cart: true, payment: false } });
    ok('busy from the sale screen: a cart', A.activitySnapshot().busy === 'a sale is in the cart');
    ping({}, { busy: { cart: true, payment: true } });
    ok('…the payment screen', A.activitySnapshot().busy === 'the payment screen is open');
    ping({}, { busy: { cart: false, payment: false } });
    ok('…cleared', A.activitySnapshot().busy === null);

    fake += HOUR;
    // A519: a hold needs someone signed in who may sell (sellGate) — a cashier on a map from before A490 here.
    L.getLocalDb().prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
      VALUES (1, 'u-a508', 'Ann', 'cashier', 'br-1', 'Main', '{}', '', NULL, '2026-10-16T00:00:00Z')`).run();
    await global.__handlers['held:hold']({}, { orderNumber: 'H-1', label: 'T1', orderType: 'retail', cart: [] });
    ok('a held bill counts as use', A.activitySnapshot().lastUse === fake && A.activitySnapshot().lastUseWhat === 'held');
    fake += MIN;
    const S = require(path.join(dist, 'shiftService.js'));
    try { S.closeShift(0); } catch { /* no open shift */ }
    ok('a drawer close (even refused) counts as use', A.activitySnapshot().lastUseWhat === 'shift' && A.activitySnapshot().lastUse === fake);
    fake += MIN;
    require(path.join(dist, 'print', 'printWorker.js')).queueTickets([{ order: { billNumber: 'B-1' } }], []);
    ok('a print queued counts as use', A.activitySnapshot().lastUseWhat === 'print' && A.activitySnapshot().lastUse === fake);
    A.setPrintPendingProbe(() => 2);
    ok('a print queue that is not empty is busy', A.activitySnapshot().busy === '2 print jobs are still queued');

    fake += MIN;
    const before = A.activitySnapshot().lastUse;
    ok('a server: a till\'s background poll through the gateway is not use',
      !A.noteGatewayCall('GET', '/node/cloud/api/pos/catalogue-version') && !A.noteGatewayCall('POST', '/node/cloud/api/auth/refresh')
      && !A.noteGatewayCall('GET', '/node/cloud/api/desktop-update/v/1.0.17/latest.yml') && A.activitySnapshot().lastTill === 0);
    ok('…a till sending a sale through it is (lastTill, not this machine\'s own use)',
      A.noteGatewayCall('POST', '/node/cloud/api/orders') && A.activitySnapshot().lastTill === fake && A.activitySnapshot().lastUse === before);
    fake += MIN;
    ok('…a till pushing rows to /node/sync is; an empty push is not', !A.noteTillSync({ orders: [] }) && A.noteTillSync({ orders: [{ id: 'x' }] }) && A.activitySnapshot().lastTill === fake);
  } finally { Date.now = realNow; }

  const ns = fs.readFileSync(path.join(desktop, 'src/main/nodeServer.ts'), 'utf8');
  ok('the branch server calls them from /node/sync and the gateway (one line each)', /noteTillSync\(body\?\.tables\)/.test(ns) && /noteGatewayCall\(req\.method, url[,)]/.test(ns));   // A541: with the body size
  const se = fs.readFileSync(path.join(desktop, 'src/main/syncEngine.ts'), 'utf8');
  ok('a sale (createLocalOrder) counts as use', /noteActivity\('sale'\);[^\n]*\n\s*return orderId;/.test(se));

  // The renderer's helper (TypeScript, transpiled here): one ping in 30 s from keys, clicks and touches.
  const ts = require('typescript');
  const src = fs.readFileSync(path.join(desktop, 'src/renderer/lib/activity.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const sent = [];
  globalThis.window = { swiftpos: { activity: (p) => sent.push(p) } };
  const m = { exports: {} };
  new Function('module', 'exports', 'require', js)(m, m.exports, require);
  const evs = {};
  let t = 1_000_000;
  const added = m.exports.startActivityPings({ addEventListener: (ev, fn, o) => { evs[ev] = { fn, o }; } }, () => t);
  for (let k = 0; k < 20; k++) { evs[['keydown', 'pointerdown', 'touchstart'][k % 3]].fn(); t += 1_000; }
  ok('renderer: keydown / pointerdown / touchstart, passive — 20 in 20 s send 1 ping', added === 3 && sent.length === 1 && sent[0].input === true && evs.keydown.o.passive === true, JSON.stringify(sent));
  t += 30_000; evs.pointerdown.fn();
  ok('…the next after 30 s is sent; wired once (a second start adds nothing)', sent.length === 2 && m.exports.startActivityPings({ addEventListener() {} }) === 0);
  m.exports.reportBusy({ cart: true, payment: false }); m.exports.reportBusy({ cart: true, payment: false }); m.exports.reportBusy({ cart: false, payment: false });
  ok('…busy is sent only when it changes', sent.filter((p) => p.busy).length === 2);
  const mainTsx = fs.readFileSync(path.join(desktop, 'src/renderer/main.tsx'), 'utf8');
  const pos = fs.readFileSync(path.join(desktop, 'src/renderer/pages/POSPage.tsx'), 'utf8');
  const pre = fs.readFileSync(path.join(desktop, 'src/main/preload.ts'), 'utf8');
  ok('wired at the app root, from the sale screen, and in preload (send, not invoke)', /startActivityPings\(\);/.test(mainTsx)
    && /reportBusy\(\{ cart: cart\.length > 0, payment: showPayment \}\)/.test(pos) && /ipcRenderer\.send\('activity:ping'/.test(pre));
}

console.log('\n7. Would Windows ask for permission? (per-machine install → elevate.exe)\n');
{
  const run = (answers) => async (cmd, args) => answers[`${cmd} ${args[0]}`] ?? { code: 1, out: '' };
  const B = (o, answers) => U.silentInstallBlocker({ platform: 'win32', adminRequired: true, run: run(answers), ...o });
  ok('not Windows / no admin rights needed → nothing stops it', (await B({ platform: 'linux' }, {})) === null && (await B({ adminRequired: false }, {})) === null);
  ok('already elevated (net session succeeds) → installs', (await B({}, { 'net session': { code: 0, out: '' } })) === null);
  ok('a standard Windows account → blocked (an administrator\'s password would be asked)',
    /not an administrator/.test(await B({}, { 'whoami /groups': { code: 0, out: 'BUILTIN\\Users  Alias  S-1-5-32-545  Enabled group' } })));
  const admin = { 'whoami /groups': { code: 0, out: 'BUILTIN\\Administrators  Alias  S-1-5-32-544  Group used for deny only' } };
  ok('an administrator with the usual UAC prompt → blocked',
    /UAC/.test(await B({}, { ...admin, 'reg query': { code: 0, out: '    ConsentPromptBehaviorAdmin    REG_DWORD    0x5' } })));
  ok('an administrator whose Windows elevates without asking (ConsentPromptBehaviorAdmin = 0) → installs',
    (await B({}, { ...admin, 'reg query': { code: 0, out: '    ConsentPromptBehaviorAdmin    REG_DWORD    0x0' } })) === null);
  ok('not known (adminRequired null) is taken as needing admin', /UAC/.test(await B({ adminRequired: null }, { ...admin, 'reg query': { code: 1, out: '' } })));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
