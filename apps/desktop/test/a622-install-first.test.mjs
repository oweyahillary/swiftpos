// A622 — a downloaded update installs first on every start, and a support log carries every log the PC holds.
//
// Owner, 2026-11-04, after TJS T1 (a branch server) sat on 1.0.20 for a week: its 1.0.21 install failed twice in ~20 s
// and it never tried again (once per version; a server opened by hand never installs). "on start up whether is a server
// or a till it should always install downloaded updates they should happen as the first thing on startup" — and "how can
// we get all logs the app generates not just running logs".
//
// RUNS the real compiled dist/main (electron shimmed):
//   cd apps/desktop && npm run build:main && TZ=UTC node --no-warnings test/a622-install-first.test.mjs
//
// Covers:
//   1. failedInstallReason: the updater's "failed" / "refused" answer about a version newer than what runs → the reason;
//      an answer about what runs now (it did install), "done", or nothing → null;
//   2. the update report carries install_error; a change of it is a new report (reportKey);
//   3. the hourly check says a downloaded version is waiting, not that "this machine runs" it;
//   4. machineLogs: the updater's log lines in the window and its last answer; no updater log → one plain line; the
//      Windows events script (ZapTill only, errors and warnings, the window's hours); the events section from a stub
//      runner — lines, none, unreadable, not Windows;
//   5. buildSupportText puts each extra section after auth.log, every secret removed;
//   6. the wiring: a pull and the Tech page's send gather machineLogSections; the fallback relaunch carries --updated.
//
// MUTATIONS TO CONFIRM BITE (checked by editing dist/main and re-running):
//   - failedInstallReason ignoring the version comparison                → "an answer about what runs now: null" fails
//   - buildUpdateReport without install_error                            → "the report carries install_error" fails
//   - updaterSections without the window                                 → "only the window's updater lines" fails
//   - buildSupportText dropping opts.sections                            → "each extra section after auth.log" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a622-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, session: { fromPartition: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return path.join(userData, 'eu-shim.cjs');
  return orig.call(this, req, parent, ...rest);
};
fs.writeFileSync(path.join(userData, 'eu-shim.cjs'), `module.exports = { autoUpdater: { on() {}, setFeedURL() {}, checkForUpdates: async () => null } };`);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const AU = require(path.join(dist, 'autoUpdate.js'));
const UR = require(path.join(dist, 'updateReport.js'));
const ML = require(path.join(dist, 'machineLogs.js'));
const SL = require(path.join(dist, 'supportLogs.js'));

// ── 1 ──
console.log('\n1. Why the last install did not take (the updater\'s answer)\n');
{
  const F = AU.failedInstallReason;
  const o = (x = {}) => ({ state: 'failed', version: '1.0.21', reason: 'installer exit 2', at: '2026-10-28T21:01:00Z', ...x });
  ok('failed, newer than what runs → "1.0.21: installer exit 2"', F(o(), '1.0.20') === '1.0.21: installer exit 2', F(o(), '1.0.20'));
  ok('refused → says the updater refused it', /^1\.0\.21: the updater refused it — offline$/.test(F(o({ state: 'refused', reason: 'offline' }), '1.0.20') ?? ''));
  ok('an answer about what runs now (it did install): null', F(o(), '1.0.21') === null && F(o(), '1.0.23') === null);
  ok('done / ready, no version, nothing: null', F(o({ state: 'done' }), '1.0.20') === null && F(o({ state: 'ready' }), '1.0.20') === null
    && F(o({ version: null }), '1.0.20') === null && F(null, '1.0.20') === null);
  ok('no reason given: says so', F(o({ reason: '' }), '1.0.20') === '1.0.21: no reason given');
}

// ── 2 ──
console.log('\n2. The update report\n');
{
  const st = { state: 'downloaded', version: '1.0.23', percent: 100, checkedAt: null, approved: '1.0.23', downloadedAt: Date.parse('2026-11-03T12:31:00Z') };
  const r = UR.buildUpdateReport({ status: st, running: '1.0.20', stateAt: null, idleNote: null, task: true, server: true, installError: '1.0.23: installer exit 2' });
  ok('the report carries install_error', r.install_error === '1.0.23: installer exit 2', JSON.stringify(r));
  const r0 = UR.buildUpdateReport({ status: st, running: '1.0.20', stateAt: null, idleNote: null, task: true });
  ok('none → null', r0.install_error === null);
  ok('a change of it is a new report', UR.reportKey(r) !== UR.reportKey(r0));
}

// ── 3 ──
console.log('\n3. The hourly check\'s words\n');
{
  const lines = [];
  const check = (o) => AU.runUpdateCheck({
    updater: { setFeedURL() {}, requestHeaders: null, checkForUpdates: async () => null },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ approvedVersion: '1.0.21' }) }),
    cloudUrl: () => 'http://127.0.0.1:9', token: () => 'tok', refresh: async () => false, log: (l) => lines.push(l), ...o,
  });
  await check({ running: '1.0.21', downloaded: true });
  await check({ running: '1.0.21' });
  ok('a download waiting: "1.0.21 is downloaded and waiting to install" — never "this machine runs 1.0.21"',
    lines.some((l) => /1\.0\.21 is downloaded and waiting to install/.test(l)) && lines.filter((l) => /this machine runs/.test(l)).length === 1, lines.join(' | '));
}

// ── 4 ──
console.log('\n4. The PC\'s other logs\n');
{
  const now = Date.parse('2026-11-04T09:00:00Z');
  const files = {
    'D\\updater.log': '﻿2026-10-20T10:00:00Z  old line\n2026-10-28T21:00:59Z  asked to install 1.0.21 and start ZapTill again after.\n2026-10-28T21:01:12Z  the install of 1.0.21 did not finish (installer exit 2; ZapTill.exe is 1.0.20.0)\n',
    'D\\updater-status.json': '{"id":"x","state":"failed","version":"1.0.21","reason":"installer exit 2"}',
  };
  const d = { dir: 'D', readFile: (f) => files[f.replace(/\//g, '\\')] ?? null };
  const s = ML.updaterSections(d, now, 7 * 86_400_000);
  ok('two sections: updater.log and its last answer', s.length === 2 && /updater\.log/.test(s[0].title) && /updater-status/.test(s[1].title));
  ok('only the window\'s updater lines (7 days), with the installer\'s exit code', /installer exit 2/.test(s[0].text) && !/old line/.test(s[0].text), s[0].text);
  ok('the last answer as written', /"state":"failed"/.test(s[1].text));
  const none = ML.updaterSections({ dir: 'D', readFile: () => null }, now, 86_400_000);
  ok('no updater log: one plain line', /no updater log on this PC/.test(none[0].text) && none[1].text === '(none)');

  const sc = ML.eventScript(168);
  ok('the events script: Application log, errors and warnings, 168 hours, ZapTill only, capped',
    /LogName = 'Application'/.test(sc) && /Level = 1,2,3/.test(sc) && /AddHours\(-168\)/.test(sc) && /-match 'ZapTill'/.test(sc) && /-First 40/.test(sc), sc);
  const ev = await ML.windowsEventSection(86_400_000, async () => ({ code: 0, out: '2026-11-03T20:25:00Z  Error Application Error 1000: Faulting application name: ZapTill.exe\r\n\r\n' }), 'win32');
  ok('the events: one line each', ev.text === '2026-11-03T20:25:00Z  Error Application Error 1000: Faulting application name: ZapTill.exe', ev.text);
  ok('none in the window: says so', (await ML.windowsEventSection(1, async () => ({ code: 0, out: '' }), 'win32')).text === '(none in the window)');
  ok('unreadable: says so, never throws', (await ML.windowsEventSection(1, async () => { throw new Error('x'); }, 'win32')).text === '(the event log could not be read)'
    && (await ML.windowsEventSection(1, async () => ({ code: 1, out: '' }), 'win32')).text === '(the event log could not be read)');
  ok('not Windows: says so', (await ML.windowsEventSection(1, async () => ({ code: 0, out: 'x' }), 'linux')).text === '(not Windows)');
}

// ── 5 ──
console.log('\n5. The bundle\n');
{
  const now = Date.parse('2026-11-04T09:00:00Z');
  const header = { business: 'TJS', businessId: 'b', branch: 'Branch', branchId: 'br', terminal: 'T1', deviceId: 'd', deviceName: 'T1',
    role: 'node', version: '1.0.24', os: 'win32', ramGb: 8, freeGb: 5, startup: null, sync: [], tech: 'support', at: new Date(now).toISOString() };
  const t = SL.buildSupportText(header, ['2026-11-04T08:00:00.000Z [update] hello\n'], ['2026-11-04T08:00:00.000Z [ack]\n'], now,
    { sections: [{ title: 'updater.log (the ZapTill Updater task)', text: '2026-11-04T08:10:00Z  token=abcdef0123456789abcdef0123456789 installed' },
      { title: 'Windows Application events naming ZapTill (errors and warnings)', text: '(none in the window)' }] }).text;
  const a = t.indexOf('── auth.log'), u = t.indexOf('── updater.log'), w = t.indexOf('── Windows Application events');
  ok('each extra section after auth.log, in order', a > 0 && u > a && w > u, t);
  ok('every secret removed in them too', !/abcdef0123456789abcdef0123456789/.test(t));
}

// ── 6 ──
console.log('\n6. The wiring\n');
{
  const src = (f) => fs.readFileSync(path.join(desktop, 'src', 'main', f), 'utf8');
  ok('a pull gathers the PC\'s other logs for its window', /machineLogSections\(now, r\.range_hours \* 3_600_000\)/.test(src('logPull.ts')));
  ok('the Tech page\'s send and save gather them too', /machineLogSections\(now, WINDOW_MS\)/.test(src('ipc/tech.ts'))
    && /packSupportText\(await supportText\(\)\)/.test(src('ipc/tech.ts')) && /writeFileSync\(choice\.filePath, await supportText\(\)/.test(src('ipc/tech.ts')));
  const au = src('autoUpdate.ts');
  ok('an install that did not start relaunches as "after an update" (no second try in that start)', /app\.relaunch\(\{ args: \[UPDATED_ARG\] \}\)/.test(au));
  ok('the failed install is read and logged at every start', /installError = noteFailedInstall\(running\)/.test(au) && /updater\.log: \$\{line\}/.test(au));
}

// ── 7 ── the Tech page's menu (owner, 2026-11-04: "the tech screen is too long for scrolling can we add a menu to it")
console.log('\n7. The Tech page\'s menu\n');
{
  const page = fs.readFileSync(path.join(desktop, 'src', 'renderer', 'pages', 'TechPage.tsx'), 'utf8');
  const menu = fs.readFileSync(path.join(desktop, 'src', 'renderer', 'lib', 'techMenu.ts'), 'utf8');
  const ids = [...menu.matchAll(/\{ id: '([a-z]+)', label: '([^']+)' \}/g)].map((m) => m[1]);
  ok('nine sections in the menu', ids.length === 9 && ids[0] === 'device' && ids.at(-1) === 'reset', ids.join(','));
  ok('the menu stays in view (sticky) and shows one section at a time', /<nav className="sticky top-0[^"]*"/.test(page) && /TECH_SECTIONS\.map/.test(page));
  ok('every section in the menu shows something, and nothing shows outside a section',
    ids.every((id) => page.includes(`section === '${id}'`)) && !/\n {8}<section className/.test(page.split("section === 'device'")[0]), ids.filter((id) => !page.includes(`section === '${id}'`)).join(','));
  ok('every panel sits under one section (Device, the customer screen … Reset)', ['<CustomerScreenPanel', '<UpdateDiagnosticsPanel', '<HistoryUploadPanel', '<BrandingEditor', 'Reset this device', 'tech-rejoin']
    .every((k) => { const i = page.indexOf(k); const before = page.slice(0, i); return before.lastIndexOf("section === '") > before.lastIndexOf('\n        </>)}'); }));
  ok('the last section picked is kept (per POS, never required)', /localStorage\.setItem/.test(menu) && /catch \{ \/\* storage blocked/.test(menu));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(fail ? 1 : 0);
