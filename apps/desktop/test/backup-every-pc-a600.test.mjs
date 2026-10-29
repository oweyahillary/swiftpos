// A600 — a backup on EVERY PC (a POS on its own included), a Backup panel the owner or a manager can use, and a
// safe restore. Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 5): "local backup on every PC first" —
// after the cut a desktop-only business's PC holds the only copy of its data.
// Follow-up, owner, 2026-10-28 (final): every 6 hours (03:00, 09:00, 15:00, 21:00) and right after the day is closed
// (a shift close too on a standalone POS); the 10 most recent copies kept; no copy when the drive is nearly full.
//
// RUNS the real compiled dist/main (maintenance.js, backupService.js, restoreSwap.js, dayService.js, shiftService.js,
// localDb.js and the real IPC handlers) on a real SQLite file, electron shimmed. Times are built in LOCAL time
// (new Date(y, m, d, h)), so the slot rule holds whatever the machine's time zone (Windows ignores TZ).
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/backup-every-pc-a600.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-10-28):
//   - snapshotIfDue back to the branch server only (isNodeRole gate)   → "a POS on its own (role till) backs itself up at 03:00" fails
//   - backupDueAt comparing with now − 24 h instead of the 03:00 slot  → "…and the next day's is owed from 03:00 the next day" fails
//   - inspectBackup without the business comparison                    → "another business's backup is refused" fails
//   - stageRestore without the safety copy                             → "a safety copy of the current data is taken first" fails
//   - assertMayBackup letting anyone signed in through                 → "a cashier is refused the Backup panel" fails
//   Follow-up (2026-10-28):
//   - BACKUP_SLOT_HOURS back to [3] (once a day)                       → "the 09:00 slot", "the 15:00 slot", "the 21:00 slot" fail
//   - BACKUP_FILE_RE loosened back to /^swiftpos-.*\.db$/              → "…files that are not ZapTill backups are never touched" fails
//   - the free-space guard removed from runSnapshot                    → "too little free space: no copy…" fails
//   - noteClosed('day') removed from closeDayCore                      → "a day closed on this POS: a backup at once" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a600-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.23', on() {}, isPackaged: false,
           relaunch() { global.__relaunched = true; }, exit() { global.__exited = true; } },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: { showOpenDialog: async () => global.__dialog ?? { canceled: true, filePaths: [] } },
    shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const said = async (fn) => { try { const r = await fn(); return r?.error ?? r?.refusal ?? 'OK'; } catch (e) { return e?.message ?? String(e); } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front POS' });
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Mama Shop', '2026-10-28T00:00:00Z')`).run();
const M = require(path.join(dist, 'maintenance.js'));
const B = require(path.join(dist, 'backupService.js'));
const R = require(path.join(dist, 'restoreSwap.js'));
const backupsDir = path.join(userData, 'backups');
const copies = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((f) => M.BACKUP_FILE_RE.test(f)) : []);
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);   // 2026-10-<d> h:m LOCAL time
const IDLE = 600, BUSY = 0;
const logText = () => { try { return fs.readFileSync(require(path.join(dist, 'logFile.js')).getLogPath(), 'utf8'); } catch { return ''; } };
const count = (text, re) => (text.match(new RegExp(re.source, 'g')) ?? []).length;
const waitFor = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return cond(); };

const signIn = (role, perms) => {
  const db = L.getLocalDb();
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  if (role === null) return;
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
              VALUES (1, 'u-x', 'Pat', ?, 'br-1', 'Main', ?, '', NULL, '2026-10-28T00:00:00Z')`).run(role, JSON.stringify(perms));
};
/** One maintenance_state value from another database file — opened and CLOSED (an open file cannot be deleted on Windows). */
const readKv = (file, key) => { const d = new Database(file, { readonly: true }); try { return d.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key)?.value ?? null; } finally { d.close(); } };
const fine = (...keys) => Object.fromEntries([...keys, 'catalogue.v2'].map((k) => [k, true]));

// ── 1. Every 6 hours on a POS on its own ─────────────────────────────────────────────────────────────────────────────
console.log('\nEvery 6 hours on every PC\n');
{
  ok('the slots are 03:00, 09:00, 15:00 and 21:00', JSON.stringify(M.BACKUP_SLOT_HOURS) === '[3,9,15,21]');
  ok('the current slot: 01:00 → yesterday 21:00; 09:00 sharp → 09:00; 14:59 → 09:00',
    M.lastBackupSlot(at(2, 1)).getTime() === at(1, 21).getTime() && M.lastBackupSlot(at(2, 9)).getTime() === at(2, 9).getTime()
    && M.lastBackupSlot(at(2, 14, 59)).getTime() === at(2, 9).getTime());
  ok('no backup ever: one is owed at once', M.backupDueAt(at(1, 2)) === true);
  const r = await M.snapshotIfDue(at(1, 3, 5), IDLE);
  ok('a POS on its own (role till) backs itself up at 03:00', r?.ok === true && copies().length === 1, JSON.stringify(r));
  ok('…and records the business in the copy (backup_business_id)', M.getState('backup_business_id') === 'biz-1'
    && readKv(r.path, 'backup_business_id') === 'biz-1');
  ok('…a backup since 03:00 means nothing more until 09:00 (03:30, 08:59)',
    (await M.snapshotIfDue(at(1, 3, 30), IDLE)) === null && (await M.snapshotIfDue(at(1, 8, 59), IDLE)) === null && copies().length === 1);
  ok('the 09:00 slot', (await M.snapshotIfDue(at(1, 9, 1), IDLE))?.ok === true && (await M.snapshotIfDue(at(1, 14, 59), IDLE)) === null
    && copies().length === 2);
  ok('the 15:00 slot', (await M.snapshotIfDue(at(1, 15, 1), IDLE))?.ok === true && (await M.snapshotIfDue(at(1, 20, 59), IDLE)) === null
    && copies().length === 3);
  ok('the 21:00 slot', (await M.snapshotIfDue(at(1, 21, 1), IDLE))?.ok === true && (await M.snapshotIfDue(at(1, 23, 59), IDLE)) === null
    && (await M.snapshotIfDue(at(2, 2, 59), IDLE)) === null && copies().length === 4);
  ok('…and the next day\'s 03:00 slot', (await M.snapshotIfDue(at(2, 3, 1), IDLE))?.ok === true && copies().length === 5);
  ok('a scheduled copy says so (last_backup_reason)', M.getState('last_backup_reason') === 'scheduled');
}

console.log('\nCaught up after the PC was off or busy\n');
{
  M.resetBackupWait();
  // Off from 03:01 on the 2nd until 10:00 on the 4th (seven slots missed).
  ok('switched on at 10:00 with a customer at the POS: it waits (not idle)', (await M.snapshotIfDue(at(4, 10), BUSY)) === null);
  ok('…still busy ten minutes later: still waits', (await M.snapshotIfDue(at(4, 10, 10), BUSY)) === null);
  const r = await M.snapshotIfDue(at(4, 10, 12), IDLE);
  ok('…the first quiet moment (2 minutes untouched): it backs up once', r?.ok === true && copies().length === 6, JSON.stringify(r));
  ok('…once, not once for each slot missed', (await M.snapshotIfDue(at(4, 10, 20), IDLE)) === null && copies().length === 6);
  M.resetBackupWait();
  ok('a PC never left alone (a busy 24-hour POS) waits at 15:00…', (await M.snapshotIfDue(at(4, 15, 0), BUSY)) === null
    && (await M.snapshotIfDue(at(4, 15, 20), BUSY)) === null);
  ok('…then backs up anyway after 30 minutes (it never blocks a sale)', (await M.snapshotIfDue(at(4, 15, 31), BUSY))?.ok === true
    && copies().length === 7);
  M.resetBackupWait();
  ok('"Back up now" at 20:00 satisfies the 15:00 slot', (await M.takeSnapshot(at(4, 20))).ok === true
    && M.getState('last_backup_reason') === 'manual' && (await M.snapshotIfDue(at(4, 20, 59), IDLE)) === null && copies().length === 8);
  ok('…and the 21:00 slot is owed again', (await M.snapshotIfDue(at(4, 21, 1), IDLE))?.ok === true && copies().length === 9);
}

console.log('\nThe copy runs in small steps, one at a time\n');
{
  // Enough data that the copy needs several steps (256 pages a step).
  db.exec(`CREATE TABLE IF NOT EXISTS zz_fill (b BLOB)`);
  const ins = db.prepare(`INSERT INTO zz_fill (b) VALUES (?)`);
  db.transaction(() => { for (let i = 0; i < 48; i++) ins.run(Buffer.alloc(64 * 1024, i)); })();
  let ticks = 0; let done = false;
  const t = setInterval(() => { if (!done) ticks++; }, 0);
  const p1 = M.takeSnapshot(at(7, 3));
  const p2 = M.takeSnapshot(at(7, 3));
  ok('a second "Back up now" while one runs waits for it (the same backup)', p1 === p2 && M.backupRunning() === true);
  let sold = false;
  setImmediate(() => { db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES ('sale_mid_backup', '1', 'x')`).run(); sold = true; });
  const r = await p1; done = true; clearInterval(t);
  ok('a sale written while the copy runs goes through before the copy ends (the copy yields between steps)', r.ok && sold && ticks > 0, `ticks ${ticks}`);
  db.exec(`DROP TABLE zz_fill`); db.exec('VACUUM');
}

console.log('\nThe 10 most recent copies are kept; nothing else is touched\n');
{
  // Files a person might keep in the same folder — never a ZapTill backup by its exact name.
  const foreign = ['notes.txt', 'swiftpos-old.db', 'swiftpos-2026-09-01T03-00-00-000Z.db.bak', 'my-swiftpos-2026-09-01T03-00-00-000Z.db',
    'swiftpos-2026-09-01.db', 'swiftpos-2026-09-01T03-00-00-000Z.db-journal', 'SWIFTPOS-2026-09-01T03-00-00-000Z.DB'];
  for (const f of foreign) fs.writeFileSync(path.join(backupsDir, f), 'keep me');
  ok('the owner\'s choice: 10', M.DEFAULT_SNAPSHOT_KEEP === 10 && M.snapshotKeep() === 10);
  M.setState('snapshot_keep', '30');
  ok('…a technician\'s snapshot_keep may keep fewer, never more', M.snapshotKeep() === 10);
  M.setState('snapshot_keep', '4');
  const four = M.snapshotKeep();
  M.setState('snapshot_keep', null);
  ok('…(4 kept when set to 4)', four === 4);
  for (let d = 8; d <= 26; d++) await M.snapshotIfDue(at(d, 3, 2), IDLE);
  const list = copies().sort();
  ok('after 19 more days: 10 copies', list.length === 10, String(list.length));
  ok('…the oldest went, the newest stayed', !list.some((f) => f.includes('2026-10-0')) && list.at(-1).includes(at(26, 3, 2).toISOString().slice(0, 10)), list.at(-1));
  ok('…files that are not ZapTill backups are never touched', foreign.every((f) => fs.existsSync(path.join(backupsDir, f))
    && fs.readFileSync(path.join(backupsDir, f), 'utf8') === 'keep me'));

  // A USB stick the owner chose: the same rule there.
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a600-usb-'));
  for (let i = 1; i <= 11; i++) fs.writeFileSync(path.join(usb, `swiftpos-2026-09-${String(i).padStart(2, '0')}T03-00-00-000Z.db`), 'old');
  fs.writeFileSync(path.join(usb, 'holiday.jpg'), 'photo');
  fs.writeFileSync(path.join(usb, 'swiftpos-copy.db'), 'mine');
  const r = await M.setBackupDir(usb, at(26, 4));
  const onUsb = fs.readdirSync(usb);
  ok('on a USB stick the owner chose: 10 kept there too, the oldest two gone', r.ok === true
    && onUsb.filter((f) => M.BACKUP_FILE_RE.test(f)).length === 10 && !onUsb.includes('swiftpos-2026-09-01T03-00-00-000Z.db')
    && !onUsb.includes('swiftpos-2026-09-02T03-00-00-000Z.db') && onUsb.includes('swiftpos-2026-09-03T03-00-00-000Z.db'), onUsb.join(','));
  ok('…and the owner\'s own files on it stay', onUsb.includes('holiday.jpg') && onUsb.includes('swiftpos-copy.db'));
  await M.setBackupDir(null, at(26, 4, 1));
  ok('back on the default folder: still 10 there', copies().length === 10 && M.snapshotDir() === backupsDir);
}

console.log('\nThe red warning\n');
{
  const last = new Date(M.getState('last_backup_at')).getTime();
  const longAgo = last - 30 * 86_400_000;   // this PC has been on for a month
  ok('6 hours after the last backup: no warning', M.backupStatus(new Date(last + 6 * 3_600_000), longAgo).warn === false);
  const st13 = M.backupStatus(new Date(last + 13 * 3_600_000), longAgo);
  ok('more than 12 hours on a PC that has been on: the warning (12 hours)', st13.warn === true && st13.hours_since === 13);
  ok('…but not in the first 45 minutes after it was switched on (the catch-up has not had its chance)',
    M.backupStatus(new Date(last + 13 * 3_600_000), last + 13 * 3_600_000 - 10 * 60_000).warn === false);
  const st49 = M.backupStatus(new Date(last + 49 * 3_600_000), last + 49 * 3_600_000 - 60_000);
  ok('more than 2 days: the warning even just after the start (2 days)', st49.warn === true && st49.hours_since >= 48);
  const st = M.backupStatus(new Date(last + 3_600_000));
  const used = copies().reduce((n, f) => n + fs.statSync(path.join(backupsDir, f)).size, 0);
  ok('the panel has the time, size and folder of the last backup, the copies and the space they use, and says it is on this PC\'s disk',
    st.last_backup_at && st.last_backup_bytes > 0 && st.dir === backupsDir && st.same_disk === true && st.copies === 10 && st.keep === 10
    && st.copies_bytes === used && used > 0 && st.space_short === null, JSON.stringify(st));
  const saved = M.getState('last_backup_at');
  M.setState('last_backup_at', null);
  ok('no backup ever: the warning too', M.backupStatus(new Date()).warn === true);
  M.setState('last_backup_at', saved);
}

console.log('\nNot enough free space\n');
{
  const before = M.getState('last_backup_at');
  const attempt = M.getState('last_backup_attempt_at');
  const n = copies().length;
  const logBefore = count(logText(), /\[backup\] no backup: /);
  const need = M.spaceNeeded();
  ok('what is needed: 2 × the database + 200 MB', need === 2 * M.databaseBytes() + 200 * 1024 * 1024 && M.databaseBytes() > 0);
  M.setFreeSpaceProbe(() => need - 1);
  const r = await M.snapshotIfDue(at(27, 3, 5), IDLE);
  const drive = M.driveOf(backupsDir);
  const st = M.backupStatus(at(27, 3, 6));
  ok('too little free space: no copy, and the reason', r?.ok === false && r.skipped === 'space' && copies().length === n
    && M.getState('last_backup_at') === before, JSON.stringify(r));
  ok('…the panel turns red: "Not enough free space for a backup on <drive>. Free some space or choose another folder."',
    st.space_short?.message === `Not enough free space for a backup on ${drive}. Free some space or choose another folder.`
    && st.space_short.free === need - 1 && st.space_short.need === need, JSON.stringify(st.space_short));
  ok('…not a failed attempt (no hour\'s wait)', M.getState('last_backup_attempt_at') === attempt);
  ok('…logged once', count(logText(), /\[backup\] no backup: /) === logBefore + 1);
  ok('…checked again 5 and 10 minutes later: still no copy, the log not filled', (await M.snapshotIfDue(at(27, 3, 10), IDLE))?.skipped === 'space'
    && (await M.snapshotIfDue(at(27, 3, 15), IDLE))?.skipped === 'space' && count(logText(), /\[backup\] no backup: /) === logBefore + 1 && copies().length === n);
  ok('…"Back up now" is refused with the same words', (await M.takeSnapshot(at(27, 3, 16))).error === st.space_short.message);
  M.setFreeSpaceProbe(() => 50 * 1024 ** 3);
  const r2 = await M.snapshotIfDue(at(27, 3, 20), IDLE);
  ok('space freed: the next 5-minute check backs up (not an hour later)', r2?.ok === true && M.backupStatus(at(27, 3, 21)).space_short === null
    && /\[backup\] free space on .* again/.test(logText()), JSON.stringify(r2));
  M.setFreeSpaceProbe(null);
  ok('the real drive\'s free space is read (fs.statfs)', typeof M.freeBytes(backupsDir) === 'number' && M.freeBytes(backupsDir) > 0);
  ok('the drive as a person calls it', process.platform === 'win32'
    ? M.driveOf('e:\\ZapTill backups') === 'E:' && M.driveOf('\\\\nas\\share\\zaptill') === '\\\\nas\\share'
    : M.driveOf('//nas/share/zaptill') === '//nas/share');
}

// ── 2. Rights ────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nWho may\n');
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const call = (ch, payload) => said(() => H[ch]({}, payload));
{
  signIn(null);
  ok('nobody signed in: refused', /Not signed in/.test(await call('backup:status')));
  signIn('Cashier', fine('orders.create', 'products.view'));
  const refused = [await call('backup:status'), await call('backup:now'), await call('backup:setDir', { dir: null }), await call('backup:chooseDir')];
  ok('a cashier is refused the Backup panel', refused.every((m) => m === B.BACKUP_REFUSAL), refused.join(' | '));
  ok('…and restore', (await call('backup:chooseRestoreFile')) === B.RESTORE_REFUSAL
    && (await call('backup:restore', { token: 'x', confirm: 'RESTORE' })) === B.RESTORE_REFUSAL);
  signIn('Manager', fine('shifts.close_branch', 'reports.sales'));
  const st = await H['backup:status']({});
  ok('a manager (closes the branch) sees the panel and may back up now', st?.dir === backupsDir && st.can_restore === false
    && (await call('backup:now')) === 'OK');
  ok('…but may not restore', (await call('backup:chooseRestoreFile')) === B.RESTORE_REFUSAL);
  ok('"Use the default folder" (dir null) gets past the payload check — on the Tech page too', (await call('backup:setDir', { dir: null })) === 'OK'
    && (await said(() => H['tech:setBackupDir']({}, { dir: null }))) === 'Tech session required');
  signIn('General Manager', fine('settings.business'));
  ok('someone with the business settings may too', (await H['backup:status']({}))?.can_restore === false);
  signIn('owner', {});
  ok('the owner may restore', (await H['backup:status']({}))?.can_restore === true);
  ok('the screens: Manager › Settings › Backup for the owner or a manager; the Tech page keeps its button',
    /canBackup: hasAny\('settings\.business', 'shifts\.close_branch'\)/.test(src('renderer/pages/ManagerPage.tsx'))
    && /case 'backup':\s+return (?:<>)?<BackupPanel/.test(src('renderer/pages/ManagerPage.tsx'))
    && /a\.canBackup \? \[\{ key: 'backup'/.test(src('renderer/lib/managerNav.ts'))
    && /posApi\.tech\.backupNow\(\)/.test(src('renderer/pages/TechPage.tsx')));
  const panel = src('renderer/components/BackupPanel.tsx');
  ok('the panel: last time and size, the red warning, Back up now, Choose folder, the same-disk line, RESTORE typed',
    /data-testid="backup-last"/.test(panel) && /data-testid="backup-warning"/.test(panel) && /data-testid="backup-now"/.test(panel)
    && /data-testid="backup-choose-dir"/.test(panel) && /USB stick or a second disk/.test(panel) && /Type RESTORE to confirm/.test(panel));
  ok('the panel (A600 follow-up): every 6 hours and after the day is closed, the 10 most recent kept, the space the copies use, the 12-hour and 2-day warnings, the red free-space warning',
    /Backed up every 6 hours and after the day is closed; the \{st\.keep\} most recent copies are kept\./.test(panel)
    && /'No backup in the last 12 hours'/.test(panel) && /'No backup in the last 2 days'/.test(panel)
    && /data-testid="backup-space-warning"[\s\S]{0,200}st\.space_short\.message/.test(panel) && /using \$\{size\(st\.copies_bytes\)\}/.test(panel)
    && !/every night at 3 am/.test(panel));
}

// ── 2b. A backup right after the day is closed ───────────────────────────────────────────────────────────────────────
console.log('\nA backup right after a close\n');
{
  const D = require(path.join(dist, 'dayService.js'));
  const S = require(path.join(dist, 'shiftService.js'));
  const unwire = M.wireCloseBackups();
  const lastAt = () => M.getState('last_backup_at');
  const openDay = (id, date) => db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, status, created_at)
      VALUES (?, 'biz-1', 'br-1', 'dev-T1', 'T1', ?, ?, 'open', ?)`).run(id, date, new Date().toISOString(), new Date().toISOString());
  const openShift = (id) => db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, device_id)
      VALUES (?, 'biz-1', 'br-1', 'u-x', ?, 'open', 0, ?, 'dev-T1')`).run(id, new Date(Date.now() - 3_600_000).toISOString(), new Date().toISOString());

  signIn('owner', {});
  openDay('day-a600-1', '2026-10-28');
  const before = lastAt();
  const n = copies().length;
  D.closeDay(0, 'A600 test');
  ok('a day closed on this POS: a backup at once', await waitFor(() => lastAt() !== before && M.getState('last_backup_reason') === 'day_close')
    && copies().length === Math.min(n + 1, 10), `${before} → ${lastAt()}`);
  ok('…it counts as that slot\'s backup (nothing more owed until the next slot)', M.backupDueAt(new Date()) === false);
  ok('…after the close was written (the copy holds the closed day)',
    (() => { const d = new Database(M.getState('last_backup_path'), { readonly: true }); try { return d.prepare(`SELECT status FROM business_days WHERE id='day-a600-1'`).get()?.status === 'closed'; } finally { d.close(); } })());
  ok('…and it is in the log', /\[backup\] after the day close: backed up/.test(logText()));

  // On a standalone POS (no branch server) a shift close backs up too.
  openShift('sh-a600-1');
  const b2 = lastAt();
  S.forceCloseShift('A600 test', 'u-x');
  ok('a standalone POS: a shift close backs up too', await waitFor(() => lastAt() !== b2 && M.getState('last_backup_reason') === 'shift_close'));

  // A POS with a branch server: the server holds its sales, so a shift close does not; a day close still does.
  DC.saveDeviceConfig({ node_url: 'http://192.168.1.10:4000' });
  ok('(this POS now has a branch server)', M.standalonePos() === false);
  openShift('sh-a600-2');
  const b3 = lastAt();
  S.forceCloseShift('A600 test', 'u-x');
  await new Promise((r) => setTimeout(r, 300));
  ok('…a shift close there: no extra copy', lastAt() === b3 && (await M.backupAfterClose('shift')) === null);
  openDay('day-a600-2', '2026-10-29');
  D.closeDay(0, 'A600 test');
  ok('…a day close there: a backup', await waitFor(() => lastAt() !== b3 && M.getState('last_backup_reason') === 'day_close'));
  DC.saveDeviceConfig({ node_url: null });

  // A close while a copy is running: that copy began before the close, so a fresh one follows it.
  const running = M.takeSnapshot(new Date(Date.now() + 2000));
  const after = M.backupAfterClose('day', new Date(Date.now() + 4000));
  const [r1, r2] = [await running, await after];
  ok('a close during a running copy: a fresh copy after it, not the running one', r1.ok && r2?.ok && r1.path !== r2.path, `${r1.path} | ${r2?.path}`);
  ok('the hooks: every day close (closeDayCore) and every shift close say so, after the close is written',
    /emitEvent\('day_closed'[\s\S]{0,600}\}\);\s*noteClosed\('day'\)/.test(src('main/dayService.ts'))
    && count(src('main/shiftService.ts'), /noteClosed\('shift'\)/) === 2
    && /wireCloseBackups\(\);/.test(src('main/index.ts')));
  unwire();
}

// ── 3. Restore ───────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nRestore: what is refused\n');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a600-files-'));
const good = M.getState('last_backup_path');
{
  const txt = path.join(scratch, 'notes.db'); fs.writeFileSync(txt, 'hello, this is not a database at all');
  ok('a file that is not a database is refused', B.inspectBackup(txt).refusal === 'This file is not a ZapTill backup.');

  const broken = path.join(scratch, 'swiftpos-broken.db');
  fs.copyFileSync(good, broken);
  const buf = fs.readFileSync(broken);
  for (let i = 4096 * 2; i < buf.length - 4096; i += 7) buf[i] = 0xA5;   // scribble over every page past the first two
  fs.writeFileSync(broken, buf);
  const c = B.inspectBackup(broken);
  ok('a damaged backup is refused (quick_check / integrity_check)', c.ok === false && /damaged/.test(c.refusal ?? ''), c.refusal);

  const other = path.join(scratch, 'swiftpos-other.db');
  fs.copyFileSync(good, other);
  const o = new Database(other);
  o.prepare(`UPDATE session SET business_id = 'biz-OTHER', business_name = 'Other Ltd' WHERE id = 1`).run();
  o.prepare(`UPDATE maintenance_state SET value = 'biz-OTHER' WHERE key = 'backup_business_id'`).run();
  o.close();
  const oc = B.inspectBackup(other);
  ok('another business\'s backup is refused', oc.ok === false && /another business \(Other Ltd\)/.test(oc.refusal ?? ''), oc.refusal);

  const newer = path.join(scratch, 'swiftpos-newer.db');
  fs.copyFileSync(good, newer);
  const n = new Database(newer); n.prepare(`UPDATE schema_version SET version = ? WHERE id = 1`).run(L.LOCAL_SCHEMA_VERSION + 1); n.close();
  ok('a backup from a newer ZapTill is refused', /newer ZapTill/.test(B.inspectBackup(newer).refusal ?? ''));

  // Another POS of this business.
  const twin = path.join(scratch, 'swiftpos-2026-10-20T03-00-00-000Z.db');
  fs.copyFileSync(good, twin);
  const t = new Database(twin); t.prepare(`UPDATE device_config SET device_id = 'dev-T2', device_name = 'Back POS' WHERE id = 1`).run(); t.close();
  const tw = B.inspectBackup(twin);
  ok('another POS of this business, on a PC with no sales of its own: allowed, with the warning that this PC becomes that POS',
    tw.ok === true && tw.takes_over_device === 'dev-T2' && tw.warnings.some((w) => /This PC will become that POS/.test(w))
    && tw.backup.taken_at === '2026-10-20T03:00:00.000Z', JSON.stringify(tw));
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, device_id)
              VALUES ('o-1', 'biz-1', 'br-1', 'T1-1', 100, 0, 100, ?, 'dev-T1')`).run(new Date().toISOString());
  const tw2 = B.inspectBackup(twin);
  ok('…refused once this PC has sales of its own (they would be lost)', tw2.ok === false && /1 sale of its own/.test(tw2.refusal ?? ''), tw2.refusal);
  ok('the database in use is not a backup', /in use|using now/.test(B.inspectBackup(L.getDbPath()).refusal ?? ''));
}

console.log('\nRestore: the safety copy, the word, the swap at start\n');
{
  // This PC's own backup, made before a marker is written.
  const mine = (await M.takeSnapshot(new Date())).path;
  M.setState('a600_marker', 'after-the-backup');
  signIn('owner', {});
  const c = B.inspectBackup(mine);
  ok('this PC\'s own backup can be restored', c.ok === true && c.takes_over_device === null && c.token, JSON.stringify(c));
  ok('the word RESTORE must be typed', /Type RESTORE/.test((await B.stageRestore(c.token, 'yes')).error ?? '')
    && !fs.existsSync(R.restorePlanPath()));
  signIn('Manager', fine('shifts.close_branch'));
  ok('a manager cannot stage it either (checked again in main)', (await said(() => B.stageRestore(c.token, 'RESTORE'))) === B.RESTORE_REFUSAL);
  signIn('owner', {});
  const r = await B.stageRestore(c.token, ' restore ');
  const safety = r.safety_copy;
  ok('a safety copy of the current data is taken first', r.ok === true && !!safety && fs.existsSync(safety)
    && readKv(safety, 'a600_marker') === 'after-the-backup',
    JSON.stringify(r));
  ok('…the checked copy is staged and the plan written (nothing replaced yet)', fs.existsSync(R.stagedRestorePath()) && fs.existsSync(R.restorePlanPath())
    && M.getState('a600_marker') === 'after-the-backup');
  ok('…a used check cannot be staged twice', /Choose the backup file again/.test((await B.stageRestore(c.token, 'RESTORE')).error ?? ''));

  // The next start: the database opens with the backup in place.
  L.closeLocalDb();
  const db2 = L.getLocalDb();
  ok('at the next start the backup is swapped in before the database opens', M.getState('a600_marker') === null
    && db2.prepare(`SELECT business_id FROM session WHERE id=1`).get()?.business_id === 'biz-1');
  const aside = fs.readdirSync(R.restoreDir()).find((f) => /^before-restore-/.test(f));
  ok('…the database from before is moved aside, not deleted', !!aside
    && readKv(path.join(R.restoreDir(), aside, 'swiftpos.db'), 'a600_marker') === 'after-the-backup');
  ok('…the plan is gone (it is not applied twice)', !fs.existsSync(R.restorePlanPath()) && !fs.existsSync(R.stagedRestorePath()));
  const done = B.noteRestoreDone();
  ok('…and it is recorded in the restored database', done?.applied === true && B.lastRestore()?.applied === true && /owner/.test(B.lastRestore()?.by ?? ''));
  ok('a start with nothing waiting changes nothing', R.applyPendingRestore(L.getDbPath()) === null);
}

console.log('\nRestore through the handlers\n');
{
  signIn('owner', {});
  const file = (await M.takeSnapshot(new Date(Date.now() + 1000))).path;
  global.__dialog = { canceled: false, filePaths: [file] };
  const c = await H['backup:chooseRestoreFile']({});
  ok('backup:chooseRestoreFile checks the file chosen in the dialog', c?.ok === true && !!c.token, JSON.stringify(c));
  const r = await H['backup:restore']({}, { token: c.token, confirm: 'RESTORE' });
  await new Promise((res) => setTimeout(res, 1700));
  ok('backup:restore stages it and restarts ZapTill', r.ok === true && global.__relaunched === true && global.__exited === true, JSON.stringify(r));
  const logText = (() => { try { return fs.readFileSync(require(path.join(dist, 'logFile.js')).getLogPath(), 'utf8'); } catch { return ''; } })();
  ok('every restore is in the log', /restore staged by/.test(logText) && /restore applied at start/.test(logText), logText.slice(-300));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
