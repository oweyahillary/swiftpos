// A509 — a safe elevated updater task: an approved update installs with no Windows prompt (UAC) on a till nobody is at.
//
// The installer (per machine, unsigned) needs administrator rights, so electron-updater ran it through elevate.exe and
// Windows asked at every update — on an unattended till nobody answered, and A508's idle install refused. Now the
// installer (already elevated) registers "ZapTill Updater" (SYSTEM, highest, no trigger, a fixed script, no arguments;
// users may run it, not change it) and "ZapTill Relaunch" (the signed-in user's session). The app only writes an
// UNTRUSTED request and starts the task; the script refuses a downgrade, copies the installer into a SYSTEM-only folder
// and checks THAT copy's SHA-512 and size against latest.yml read over HTTPS from the official release.
//
// RUNS the real compiled dist/main (electron and electron-updater shimmed; child_process stubbed) and the REAL
// PowerShell script in its test mode (Windows only — elsewhere those cases say SKIPPED):
//   cd apps/desktop && npm run build:main && node test/updater-task-a509.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing a copy and pointing A509_SCRIPT / dist at it):
//   - the script's SHA-512 comparison removed                      → "a mismatched hash is refused" fails
//   - the script's "not newer" check removed                       → "a downgrade is refused" / "the same version" fail
//   - the script hashing the SOURCE instead of the copy            → "a swap after the copy changes nothing" fails
//   - runIdleInstall leaving autoInstallOnAppQuit on (task path)   → "with the task: flush → ask the task …" fails
//   - runIdleInstall stopping the server before asking the task    → "a refusal leaves everything running" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a509-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {}); const listeners = (global.__listeners = {}); const appOn = (global.__appOn = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on(ev, fn) { appOn[ev] = fn; }, isPackaged: false, quit() {}, exit() {} },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on(ch, fn) { listeners[ch] = fn; }, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {}, autoInstallOnAppQuit: true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const T = require(path.join(dist, 'updaterTask.js'));
const U = require(path.join(dist, 'autoUpdate.js'));

console.log('\n1. Where the updater lives, and finding the task\n');
{
  ok('"%ProgramFiles%\\ZapTill Updater" — the 64-bit Program Files even from the 32-bit build',
    T.updaterDir({ ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files (x86)' }) === 'C:\\Program Files\\ZapTill Updater'
    && T.updaterDir({ ProgramFiles: 'D:\\PF' }) === 'D:\\PF\\ZapTill Updater');
  const calls = [];
  const deps = (o = {}) => ({ platform: 'win32', dir: 'C:\\PF\\ZapTill Updater', exists: () => true, writeFile() {}, readFile: () => null,
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, out: '' }; }, ...o });
  ok('found: the script is there and schtasks /Query /TN "ZapTill Updater" succeeds',
    (await T.hasUpdaterTask(deps())) === true && calls.at(-1) === 'schtasks /Query /TN ZapTill Updater', calls.at(-1));
  ok('missing (a machine installed before 1.0.16): the query fails → false',
    (await T.hasUpdaterTask(deps({ run: async () => ({ code: 1, out: 'ERROR: The system cannot find the file specified.' }) }))) === false);
  ok('the script missing → false (not even asked)', (await T.hasUpdaterTask(deps({ exists: () => false, run: async () => { throw new Error('asked'); } }))) === false);
  ok('not Windows → false', (await T.hasUpdaterTask(deps({ platform: 'linux' }))) === false);

  // child_process stubbed: the real defaultTaskDeps().run calls execFile exactly so, hidden.
  const cp = require('node:child_process');
  const realExec = cp.execFile;
  const seen = [];
  cp.execFile = (cmd, args, opts, cb) => { seen.push({ cmd, args, opts }); cb(null, 'TaskName  ZapTill Updater'); };
  try {
    const d = { ...T.defaultTaskDeps(), platform: 'win32', exists: () => true };
    const r = await T.hasUpdaterTask(d);
    ok('child_process: execFile("schtasks", ["/Query","/TN","ZapTill Updater"]), windowsHide, with a timeout',
      r === true && seen.length === 1 && seen[0].cmd === 'schtasks' && JSON.stringify(seen[0].args) === JSON.stringify(['/Query', '/TN', 'ZapTill Updater'])
      && seen[0].opts.windowsHide === true && seen[0].opts.timeout > 0, JSON.stringify(seen));
    cp.execFile = (cmd, args, opts, cb) => { seen.push({ cmd, args }); const e = new Error('x'); e.code = 1; cb(e, ''); };
    ok('…a failing schtasks is a code, never a throw', (await d.run('schtasks', ['/Run', '/TN', 'ZapTill Updater'])).code === 1);
  } finally { cp.execFile = realExec; }
}

console.log('\n2. The request the app writes, the trigger, the answer\n');
{
  const mk = (statusFor) => {
    const files = {}; const calls = []; let t = 1_000_000;
    const d = {
      platform: 'win32', dir: 'C:\\PF\\ZapTill Updater', exists: () => true, newId: () => 'req-1',
      writeFile: (f, s) => { files[f] = s; }, readFile: (f) => files[f] ?? null,
      run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); const s = statusFor?.(); if (s) files[T.statusFile('C:\\PF\\ZapTill Updater')] = s; return { code: 0, out: '' }; },
      now: () => t, sleep: async (ms) => { t += ms; },
    };
    return { d, files, calls };
  };
  const ready = mk(() => JSON.stringify({ id: 'req-1', state: 'ready', version: '1.0.17' }));
  const r = await T.requestTaskInstall(ready.d, { version: '1.0.17', installerPath: 'C:\\Users\\cash\\AppData\\Local\\zaptill-updater\\pending\\ZapTill-1.0.17.exe', relaunch: true });
  const req = JSON.parse(ready.files['C:\\PF\\ZapTill Updater\\request\\update-request.json'] ?? 'null');
  ok('the request: { id, version, installerPath, relaunch, at } in request\\update-request.json — nothing else',
    req && JSON.stringify(Object.keys(req)) === JSON.stringify(['id', 'version', 'installerPath', 'relaunch', 'at'])
    && req.id === 'req-1' && req.version === '1.0.17' && req.installerPath.endsWith('pending\\ZapTill-1.0.17.exe') && req.relaunch === true, JSON.stringify(req));
  ok('the trigger: schtasks /Run /TN "ZapTill Updater" (no arguments a user could pass to the script)',
    JSON.stringify(ready.calls) === JSON.stringify(['schtasks /Run /TN ZapTill Updater']), JSON.stringify(ready.calls));
  ok('the script answers ready (same id) → ok', r.ok === true, JSON.stringify(r));

  const refused = mk(() => JSON.stringify({ id: 'req-1', state: 'refused', reason: 'the official release list could not be reached over HTTPS (offline)' }));
  const r2 = await T.requestTaskInstall(refused.d, { version: '1.0.17', installerPath: 'C:\\x.exe', relaunch: false });
  ok('refused (offline, behind a branch server without internet) → not ok, with the script\'s reason', !r2.ok && /could not be reached over HTTPS/.test(r2.reason), JSON.stringify(r2));

  const stale = mk(() => JSON.stringify({ id: 'an-older-request', state: 'ready' }));
  const r3 = await T.requestTaskInstall(stale.d, { version: '1.0.17', installerPath: 'C:\\x.exe', relaunch: true, timeoutMs: 5_000, pollMs: 1_000 });
  ok('an answer to an OLDER request is not this one\'s → it times out (not ok)', !r3.ok && /did not answer/.test(r3.reason), JSON.stringify(r3));

  const silent = mk(() => null);
  const r4 = await T.requestTaskInstall(silent.d, { version: '1.0.17', installerPath: 'C:\\x.exe', relaunch: true, timeoutMs: 10_000 });
  ok('no answer at all (PowerShell blocked by policy, antivirus) → not ok after the timeout', !r4.ok && /did not answer in 10 s/.test(r4.reason), JSON.stringify(r4));

  const cant = mk(); cant.d.run = async () => ({ code: 1, out: 'ERROR: Access is denied.' });
  const r5 = await T.requestTaskInstall(cant.d, { version: '1.0.17', installerPath: 'C:\\x.exe', relaunch: true });
  ok('the task cannot be started → not ok at once', !r5.ok && /could not be started/.test(r5.reason));
  const bad = mk();
  const r6 = await T.requestTaskInstall(bad.d, { version: '1.0.17; calc', installerPath: 'C:\\x.exe', relaunch: true });
  ok('a version that is not plain is never written', !r6.ok && Object.keys(bad.files).length === 0 && bad.calls.length === 0);

  const tail = T.updaterLogTail({ dir: 'D', readFile: () => '\uFEFF2026-10-16T01:00:00Z  a\r\n2026-10-16T01:00:01Z  b\r\n\r\n' }, 1);
  ok('the updater log\'s tail for the Tech page (BOM and CRLF handled)', JSON.stringify(tail) === JSON.stringify(['2026-10-16T01:00:01Z  b']));
  const dg = U.getUpdateDiagnostics();
  ok('getUpdateDiagnostics carries updaterTask { installed, log }', dg.updaterTask && 'installed' in dg.updaterTask && Array.isArray(dg.updaterTask.log));
}

console.log('\n3. The idle install with the task — and without it\n');
{
  const run = (answers) => async (cmd, args) => answers[`${cmd} ${args[0]}`] ?? { code: 1, out: '' };
  const standard = { 'whoami /groups': { code: 0, out: 'BUILTIN\\Users  Alias  S-1-5-32-545  Enabled group' } };
  ok('silentInstallBlocker: a standard account WITH the updater task → nothing stops it',
    (await U.silentInstallBlocker({ platform: 'win32', adminRequired: true, run: run(standard), task: async () => true })) === null);
  ok('…without the task → blocked as before (an administrator\'s password)',
    /not an administrator/.test(await U.silentInstallBlocker({ platform: 'win32', adminRequired: true, run: run(standard), task: async () => false })));
  ok('…a task probe that throws counts as no task',
    /not an administrator/.test(await U.silentInstallBlocker({ platform: 'win32', adminRequired: true, run: run(standard), task: async () => { throw new Error('x'); } })));

  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  const deps = (o = {}) => {
    const calls = [];
    const d = {
      running: '1.0.16', candidate: () => ({ version: '1.0.17', approved: true }), isServer: () => true, shareReady: () => true,
      blocker: async () => null,
      activity: () => ({ busy: null, lastUse: NOW - 5 * 3_600_000, lastTill: NOW - 5 * 3_600_000, lastUseWhat: null }),
      quiet: () => true, downloadedAt: () => NOW - 3_600_000, syncSince: () => null,
      flush: async (ms) => { calls.push(`flush:${ms}`); return { pushed: 0, errors: [], timedOut: false }; },
      markQuitting: () => calls.push('markQuitting'), stopNodeServer: () => calls.push('stopNodeServer'),
      record: (r) => calls.push(`record:${r.from}->${r.to}`), closeDb: () => calls.push('closeDb'),
      quitAndInstall: (s, f) => calls.push(`quitAndInstall:${s},${f}`), log: (l) => calls.push(`log:${l}`), note() {},
      viaTask: async (v) => { calls.push(`viaTask:${v}`); return { ok: true }; },
      installOnQuit: (on) => calls.push(`installOnQuit:${on}`), quit: () => calls.push('quit'),
      now: () => NOW, ...o,
    };
    return { d, calls };
  };
  const a = deps();
  const ra = await U.createIdleInstaller(a.d).tick();
  const steps = a.calls.filter((c) => !c.startsWith('log:'));
  ok('with the task: flush → ask the task (it checks the download) → record → stop serving → close the database → install-on-quit off → quit',
    ra.install === true && JSON.stringify(steps) === JSON.stringify(['flush:60000', 'viaTask:1.0.17', 'record:1.0.16->1.0.17', 'markQuitting', 'stopNodeServer', 'closeDb', 'installOnQuit:false', 'quit']),
    JSON.stringify(steps));
  ok('…no double install: electron-updater\'s quitAndInstall is never called, and install-on-quit is off before the quit',
    !a.calls.some((c) => c.startsWith('quitAndInstall')) && a.calls.indexOf('installOnQuit:false') < a.calls.indexOf('quit'));

  const b = deps({ viaTask: async (v) => { b.calls.push(`viaTask:${v}`); return { ok: false, reason: 'the updater task refused it: the official release list could not be reached over HTTPS' }; } });
  const inst = U.createIdleInstaller(b.d);
  const rb = await inst.tick();
  ok('the task refuses (offline) → a refusal leaves everything running: nothing recorded, stopped, closed or quit',
    rb.install === false && !b.calls.some((c) => /^(record|markQuitting|stopNodeServer|closeDb|quit|installOnQuit|quitAndInstall)/.test(c)) && inst.installing() === false,
    JSON.stringify(b.calls));
  ok('…the reason is logged in a plain sentence (it installs when ZapTill is closed)', b.calls.some((c) => /^log:idle install of 1\.0\.17: the updater task refused it.*installs when it is next closed/.test(c)));
  b.calls.length = 0;
  const rb2 = await inst.tick();
  ok('…and it is not asked again every minute (blocked for the next hours, the reason shown)',
    rb2.install === false && !b.calls.includes('viaTask:1.0.17') && /updater task refused it/.test(rb2.reason), rb2.reason);

  const c = deps({ viaTask: async () => null });
  await U.createIdleInstaller(c.d).tick();
  ok('no task on this machine (viaTask → null) → electron-updater as before (quitAndInstall(true, true))',
    c.calls.at(-1) === 'quitAndInstall:true,true' && !c.calls.includes('quit'), JSON.stringify(c.calls));
  const e = deps({ viaTask: async () => { throw new Error('boom'); } });
  const re = await U.createIdleInstaller(e.d).tick();
  ok('a task call that throws is a refusal (ZapTill keeps running)', re.install === false && !e.calls.includes('closeDb'));
}

console.log('\n4. Install on close and "Install now" — the task, else the old way, never both\n');
{
  const base = { platform: 'win32', taskKnown: true, taskInstallStarted: false, closeTaskDone: false, quitAndInstallCalled: false,
    installOnQuit: true, state: 'downloaded', version: '1.0.17', installerPath: 'C:\\u\\pending\\ZapTill-1.0.17.exe' };
  ok('closing with a download and the task → hand 1.0.17 to the task', U.closeInstallPlan(base) === '1.0.17');
  ok('no task (null or false) → the old way', U.closeInstallPlan({ ...base, taskKnown: false }) === null && U.closeInstallPlan({ ...base, taskKnown: null }) === null);
  ok('already handed over (the idle install / Install now) → nothing more', U.closeInstallPlan({ ...base, taskInstallStarted: true }) === null);
  ok('electron-updater already installing (quitAndInstall) → nothing more', U.closeInstallPlan({ ...base, quitAndInstallCalled: true }) === null);
  ok('the close had its turn (the task refused) → the quit goes through to electron-updater', U.closeInstallPlan({ ...base, closeTaskDone: true }) === null);
  ok('install-on-quit off (a withdrawn version, A503) → nothing', U.closeInstallPlan({ ...base, installOnQuit: false }) === null);
  ok('nothing downloaded / no installer file / not Windows → nothing',
    U.closeInstallPlan({ ...base, state: 'idle' }) === null && U.closeInstallPlan({ ...base, installerPath: null }) === null && U.closeInstallPlan({ ...base, platform: 'linux' }) === null);
  const src = fs.readFileSync(path.join(desktop, 'src/main/autoUpdate.ts'), 'utf8');
  ok('installUpdateNow: the task first (relaunch), else quitAndInstall(false, true) — the close path told to stand aside',
    /export async function installUpdateNow[\s\S]*?installThroughTask\(current\.version, true(, \d[\d_]*)?\)[\s\S]*?closeTaskDone = true;[\s\S]*?autoUpdater\.quitAndInstall\(false, true\)/.test(src));
  ok('a task install turns electron-updater\'s install-on-quit off (no double install)', /taskInstallStarted = true;\s*\n\s*autoUpdater\.autoInstallOnAppQuit = false;/.test(src));
  ok('will-quit: held only for the task\'s answer, then the quit goes on either way', /app\.on\('will-quit'[\s\S]*?e\.preventDefault\(\);[\s\S]*?\.finally\(\(\) => app\.quit\(\)\)/.test(src));
}

console.log('\n5. The installer registers the tasks right (static: build/installer.nsh, electron-builder.config.js)\n');
{
  const nsh = fs.readFileSync(path.join(desktop, 'build/installer.nsh'), 'utf8');
  const inst = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'));
  const un = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  ok('LF line endings kept', !nsh.includes('\r'));
  ok('"ZapTill Updater": SYSTEM (S-1-5-18), HighestAvailable, no trigger',
    /schtasks \/Create \/TN "ZapTill Updater" \/XML "\$2\\updater-task\.xml" \/F/.test(inst)
    && /<UserId>S-1-5-18<\/UserId><RunLevel>HighestAvailable<\/RunLevel>/.test(inst) && /<Triggers \/>/.test(inst));
  ok('…its action: PowerShell, -NoProfile -ExecutionPolicy Bypass -File the fixed script in "%ProgramFiles%\\ZapTill Updater", nothing else',
    /<Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe<\/Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "\$2\\zaptill-update\.ps1"<\/Arguments>/.test(inst)
    && /StrCpy \$2 "\$PROGRAMFILES64\\ZapTill Updater"/.test(inst));
  const sd = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)';
  ok('…security descriptor: SYSTEM and Administrators full, signed-in users read + run only (not write)',
    inst.split(`<SecurityDescriptor>${sd}</SecurityDescriptor>`).length === 3 && !/\(A;;(GA|GW|FA|FW)[^)]*;;;(AU|BU|WD|IU)\)/.test(inst));
  ok('"ZapTill Relaunch": the INTERACTIVE group (S-1-5-4), least privilege — the user\'s session, never SYSTEM',
    /schtasks \/Create \/TN "ZapTill Relaunch" \/XML/.test(inst) && /<GroupId>S-1-5-4<\/GroupId><RunLevel>LeastPrivilege<\/RunLevel>/.test(inst)
    && /<Command>"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"<\/Command>/.test(inst));
  ok('the script is written from the installer\'s own payload into the admin-only folder (not copied from the install folder)',
    /SetOutPath "\$2"\s*\n\s*File "\$\{PROJECT_DIR\}\\updater\\zaptill-update\.ps1"/.test(inst));
  ok('the folder: owner Administrators; SYSTEM + Administrators full, Users read; inheritance removed; request\\ the only place users write',
    /icacls "\$2" \/setowner \*S-1-5-32-544/.test(inst)
    && /icacls "\$2" \/inheritance:r \/grant:r \*S-1-5-18:\(OI\)\(CI\)F \*S-1-5-32-544:\(OI\)\(CI\)F \*S-1-5-32-545:\(OI\)\(CI\)RX'/.test(inst)
    && /icacls "\$2\\request" \/grant \*S-1-5-32-545:\(OI\)\(CI\)\(IO\)M/.test(inst));
  ok('prod flavour only (the dev build never self-updates)', (nsh.match(/!if "\$\{PRODUCT_NAME\}" == "ZapTill"/g) ?? []).length === 2);
  ok('uninstall: both tasks deleted — on a real uninstall only (an update runs the old uninstaller from inside the task)',
    /\$\{ifNot\} \$\{isUpdated\}[\s\S]*schtasks \/Delete \/TN "ZapTill Updater" \/F[\s\S]*schtasks \/Delete \/TN "ZapTill Relaunch" \/F[\s\S]*\$\{endIf\}/.test(un));
  ok('…never a recursive delete of request\\ (users write there — a planted link)', !/RMDir \/r "[^"]*request/.test(un));
  const cfg = fs.readFileSync(path.join(desktop, 'electron-builder.config.js'), 'utf8');
  ok('electron-builder ships the script (extraResources updater/zaptill-update.ps1); nsis stays per machine',
    /extraResources: \[\{ from: 'updater', to: 'updater', filter: \['zaptill-update\.ps1'\] \}\]/.test(cfg) && /perMachine: true/.test(cfg));
  const ps = fs.readFileSync(path.join(desktop, 'updater/zaptill-update.ps1'), 'utf8');
  ok('the script: ASCII only (Windows PowerShell 5.1 reads it without a BOM)', !/[^\x00-\x7F]/.test(ps));
  ok('…reads no environment variable a user could set, and never passes --force-run', !/\$env:/i.test(ps) && !/'--force-run'/.test(ps.replace(/^#.*$/gm, '')));
  ok('…the official feed hard-coded (github oweyahillary/swiftpos, tag v<version>), TLS 1.2+, certificate checks on',
    /\$FeedBase = 'https:\/\/github\.com\/oweyahillary\/swiftpos\/releases\/download'/.test(ps) && /'\/v' \+ \$version \+ '\/latest\.yml'/.test(ps)
    && /Tls12/.test(ps) && /ServerCertificateValidationCallback = \$null/.test(ps));
  ok('…the work folder: SYSTEM + Administrators only, inheritance removed, made afresh',
    /icacls\.exe \$Work \/inheritance:r \/grant:r @grants/.test(ps) && /\$grants = @\('\*S-1-5-18:\(OI\)\(CI\)F', '\*S-1-5-32-544:\(OI\)\(CI\)F'\)/.test(ps)
    && /Remove-Item -LiteralPath \$Work -Recurse -Force/.test(ps));
  ok('…test mode is refused when it runs as SYSTEM (the task)', /if \(\$Test -and \$me\.User\.Value -eq 'S-1-5-18'\)/.test(ps));
}

console.log('\n6. The PowerShell script, for real, in its test mode (never installs)\n');
if (process.platform !== 'win32') {
  console.log('  SKIPPED (not Windows): the PowerShell cases run on Windows only');
} else {
  const script = process.env.A509_SCRIPT || path.join(desktop, 'updater', 'zaptill-update.ps1');
  const ymlFor = (version, file, buf, sizeOverride) => {
    const sha = crypto.createHash('sha512').update(buf).digest('base64');
    const size = sizeOverride ?? buf.length;
    // As electron-builder writes it (checked against the published v1.0.15 latest.yml).
    return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha}\n    size: ${size}\npath: ${file}\nsha512: ${sha}\nreleaseDate: '2026-10-15T07:42:17.641Z'\n`;
  };
  const good = crypto.randomBytes(300_000);
  const evil = Buffer.concat([good.subarray(0, 299_000), Buffer.alloc(1_000, 0x41)]);   // same size, other bytes
  const runCase = (o) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a509ps-'));
    fs.mkdirSync(path.join(root, 'request')); fs.mkdirSync(path.join(root, 'dl'));
    const inst = path.join(root, 'dl', 'ZapTill-1.0.17.exe');
    fs.writeFileSync(inst, o.installer ?? good);
    fs.writeFileSync(path.join(root, 'install-dir.txt'), path.join(root, 'app'));
    const feed = path.join(root, 'latest.yml');
    fs.writeFileSync(feed, o.yml ?? ymlFor('1.0.17', 'ZapTill-1.0.17.exe', good));
    const req = { id: 'case-1', version: '1.0.17', installerPath: inst, relaunch: true, ...(o.req ?? {}) };
    fs.writeFileSync(path.join(root, 'request', 'update-request.json'), JSON.stringify(req));
    let swap = null;
    if (o.swapWith) { swap = path.join(root, 'swap.bin'); fs.writeFileSync(swap, o.swapWith); }
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TestRoot', root, '-TestFeedFile', feed,
      '-TestInstalledVersion', o.installed ?? '1.0.16', ...(swap ? ['-TestSwapWith', swap] : [])];
    const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8').replace(/^\uFEFF/, ''); } catch { return null; } };
    const status = (() => { try { return JSON.parse(read('updater-status.json')); } catch { return null; } })();
    const wouldRun = (() => { try { return JSON.parse(read('would-run.json')); } catch { return null; } })();
    let acl = '';
    if (fs.existsSync(path.join(root, 'work'))) acl = spawnSync('icacls.exe', [path.join(root, 'work')], { encoding: 'utf8' }).stdout;
    const copy = wouldRun ? (() => { try { return fs.readFileSync(wouldRun.exe); } catch { return null; } })() : null;
    const res = { code: r.status, log: read('updater.log') ?? '', status, wouldRun, acl, copy, root, err: r.stderr };
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the work folder is ours */ }
    return res;
  };
  const refusedWith = (r, re) => r.code !== 0 && r.status?.state === 'refused' && r.status?.id === 'case-1' && re.test(r.status.reason) && !r.wouldRun;

  const g = runCase({});
  ok('a good installer → it would run the CHECKED COPY with exactly --updated /S (never --force-run), relaunch asked',
    g.code === 0 && g.wouldRun && JSON.stringify(g.wouldRun.args) === JSON.stringify(['--updated', '/S'])
    && g.wouldRun.exe.endsWith('\\work\\ZapTill-1.0.17.exe') && g.wouldRun.relaunch === true && g.status?.state === 'done',
    JSON.stringify({ code: g.code, w: g.wouldRun, s: g.status, err: g.err }));
  ok('…the installer unpacks into the private work folder (TEMP), not C:\\Windows\\Temp', g.wouldRun?.temp?.endsWith('\\work\\tmp'));
  ok('…the work folder: no inherited rights, SYSTEM + Administrators full, no Users / Everyone',
    /NT AUTHORITY\\SYSTEM:\(OI\)\(CI\)\(F\)/.test(g.acl) && /BUILTIN\\Administrators:\(OI\)\(CI\)\(F\)/.test(g.acl)
    && !/\(I\)/.test(g.acl) && !/BUILTIN\\Users|Everyone|Authenticated Users/.test(g.acl), g.acl);
  ok('…the log says it in plain sentences', /matches the official release list \(size and SHA-512\)/.test(g.log) && /would run the checked installer/.test(g.log), g.log);

  const h = runCase({ installer: evil });
  ok('a mismatched hash is refused (nothing run)', refusedWith(h, /does not match the checksum/), JSON.stringify({ c: h.code, s: h.status }));
  const s = runCase({ yml: ymlFor('1.0.17', 'ZapTill-1.0.17.exe', good, 300_001) });
  ok('a size mismatch is refused', refusedWith(s, /not the size/), JSON.stringify(s.status));
  const dn = runCase({ installed: '1.0.18' });
  ok('a downgrade is refused (1.0.17 asked, 1.0.18 installed)', refusedWith(dn, /not newer than the installed 1\.0\.18/), JSON.stringify(dn.status));
  const eq = runCase({ installed: '1.0.17' });
  ok('the same version is refused (no re-install)', refusedWith(eq, /not newer/), JSON.stringify(eq.status));
  const bv = runCase({ req: { version: '1.0.17 -X' } });
  const bv2 = runCase({ req: { version: '1.0' } });
  ok('a version that is not plain semver is refused', refusedWith(bv, /not a plain version/) && refusedWith(bv2, /not a plain version/), JSON.stringify([bv.status, bv2.status]));
  const other = runCase({ yml: ymlFor('1.0.18', 'ZapTill-1.0.18.exe', good) });
  ok('a release list for another version is refused', refusedWith(other, /not for 1\.0\.17/), JSON.stringify(other.status));
  const unc = runCase({ req: { installerPath: '\\\\attacker\\share\\ZapTill-1.0.17.exe' } });
  const rel = runCase({ req: { installerPath: 'C:\\x\\..\\..\\Windows\\ZapTill.exe' } });
  const ads = runCase({ req: { installerPath: 'C:\\x\\y.txt:z.exe' } });
  ok('an installer path that is not a plain local path (UNC, .., a stream) is refused before it is touched',
    refusedWith(unc, /not a plain local file path/) && refusedWith(rel, /not a plain local file path/) && refusedWith(ads, /not a plain local file path/),
    JSON.stringify([unc.status, rel.status, ads.status]));
  const sw = runCase({ swapWith: evil });
  ok('the installer swapped for another file right after the copy changes nothing — the COPY is hashed and run',
    sw.code === 0 && sw.wouldRun && sw.copy && crypto.createHash('sha512').update(sw.copy).digest('base64') === crypto.createHash('sha512').update(good).digest('base64'),
    JSON.stringify({ c: sw.code, s: sw.status }));
  const garbage = (() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a509ps-'));
    fs.mkdirSync(path.join(root, 'request'));
    fs.writeFileSync(path.join(root, 'request', 'update-request.json'), '{ not json');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TestRoot', root, '-TestFeedFile', 'x', '-TestInstalledVersion', '1.0.16'], { encoding: 'utf8', windowsHide: true });
    const log = fs.readFileSync(path.join(root, 'updater.log'), 'utf8');
    fs.rmSync(root, { recursive: true, force: true });
    return { code: r.status, log };
  })();
  ok('a request that is not JSON is refused, and its content is not echoed into the log', garbage.code !== 0 && /could not be read/.test(garbage.log) && !/not json/.test(garbage.log), garbage.log);
  const outside = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true });
  ok('run by a user outside the task (not SYSTEM, no test mode) → refused, nothing written', outside.status === 2 && /only as the ZapTill Updater task/.test(outside.stderr)
    && !fs.existsSync(path.join(path.dirname(script), 'updater.log')), outside.stderr);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(fail ? 1 : 0);
