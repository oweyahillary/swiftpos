// A380 — the branch server's backups go where the technician chooses (a USB drive, a second disk).
// Owner, 2026-10-03: "the server holds the hotel data for ever right?" … "we add the backup folder setting later";
// 2026-10-13: "A380 is okay we can build it".
//
// RUNS the real compiled dist/main/maintenance.js on a real SQLite file (electron shimmed): a folder is proven by writing
// a backup there at once; a folder that cannot be written keeps the old one; the database's own disk is named; a failed
// backup is tried again within the hour and never shown as a recent backup.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/backup-folder.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - setBackupDir not restoring the previous folder on failure → "a folder that cannot be written keeps the old one" fails
//   - a failure writing last_backup_at again                     → "a failed backup is not shown as a backup" fails
//   - onDatabaseDisk treating a share as local                   → "a network share is another machine" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a380-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.11', on() {} },
  ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
L.getLocalDb();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server' });
const M = require(path.join(dist, 'maintenance.js'));

console.log('\nChoosing the backup folder\n');
{
  const st = M.maintenanceStatus();
  ok('by default the backups sit beside the database — and the screen says it is the same disk',
    st.backup_dir === path.join(userData, 'backups') && st.same_disk === true && st.custom_dir === false, JSON.stringify(st));
}
const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-usb-'));
{
  const r = await M.setBackupDir(usb, new Date('2026-10-13T20:00:00Z'));
  const files = fs.readdirSync(usb).filter((f) => /^swiftpos-.*\.db$/.test(f));
  ok('a chosen folder is proven at once: a backup is written there now', r.ok && files.length === 1 && r.dir === path.resolve(usb), JSON.stringify(r));
  ok('…and the nightly backups go there from now on', M.snapshotDir() === path.resolve(usb) && M.maintenanceStatus().custom_dir === true);
}
{
  const notAFolder = path.join(usb, 'a-file.txt');
  fs.writeFileSync(notAFolder, 'x');
  const r = await M.setBackupDir(path.join(notAFolder, 'inside'), new Date('2026-10-13T20:05:00Z'));
  ok('a folder that cannot be written keeps the old one — and says why', r.ok === false && M.snapshotDir() === path.resolve(usb)
    && /Could not write a backup to/.test(r.error ?? '') && /the backups stay in/.test(r.error ?? ''), JSON.stringify(r));
}
{
  const r = await M.setBackupDir(null, new Date('2026-10-13T20:10:00Z'));
  ok('"Use the default" goes back beside the database (with a backup there now)', r.ok && M.snapshotDir() === path.join(userData, 'backups'), JSON.stringify(r));
}

console.log('\nThe same disk, and another machine\n');
{
  // Read off the path as given — on Linux (CI) path.resolve turned \\nas\backups into a folder under the current one.
  ok('a network share is another machine — not the database\'s disk', M.onDatabaseDisk('\\\\nas\\backups') === false && M.onDatabaseDisk('//nas/backups') === false);
  const otherRoot = process.platform === 'win32' ? (L.getDbPath().toUpperCase().startsWith('Z:') ? 'Y:\\backups' : 'Z:\\backups') : '/mnt/no-such-usb/backups';
  ok('a folder on another drive is not the database\'s disk', process.platform === 'win32' ? M.onDatabaseDisk(otherRoot) === false : true);
  ok('a folder beside the database is', M.onDatabaseDisk(path.join(userData, 'backups')) === true);
}

console.log('\nA failed backup\n');
{
  const goodAt = M.getState('last_backup_at');
  const blocker = path.join(userData, 'blocked');
  fs.writeFileSync(blocker, 'x');
  M.setState('backup_dir', path.join(blocker, 'inside'));   // a folder that cannot be made
  const failed = await M.takeSnapshot(new Date('2026-10-14T02:00:00Z'));
  ok('a failed backup is not shown as a backup (the last good one stays the last backup)',
    failed.ok === false && M.getState('last_backup_at') === goodAt && /FAILED/.test(M.getState('last_backup_status') ?? ''), M.getState('last_backup_at'));
  const soon = await M.snapshotIfDue(new Date('2026-10-14T02:30:00Z'));
  ok('…tried again within the hour, not the next night', soon === null);
  M.setState('backup_dir', null);
  // The last good backup was over 20 h ago by then.
  const later = await M.snapshotIfDue(new Date('2026-10-14T21:00:00Z'));
  ok('…and after the hour it backs up again', later?.ok === true, JSON.stringify(later));
}

console.log('\nThe Tech page\n');
{
  const tech = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'TechPage.tsx'), 'utf8');
  ok('it warns while the backups are on the database\'s disk, and offers "Choose backup folder…"',
    /data-testid="backup-same-disk"/.test(tech) && /data-testid="choose-backup-dir"/.test(tech));
  const ipc = fs.readFileSync(path.join(here, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  ok('only a technician signed in may change it (and it is logged)',
    /handle\('tech:setBackupDir'[\s\S]{0,300}if \(!getActiveSession\(\)\) throw new Error\('Tech session required'\);[\s\S]{0,200}logTechAction\('backup\.dir'/.test(ipc));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
