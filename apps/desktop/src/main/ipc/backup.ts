// IPC: A600 — Manager › Settings › Backup: the nightly backup's state, "Back up now", the folder, and restore.
//
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 5): every PC backs itself up and the owner or a manager
// can see it and act on it without a technician; after the cut the PC holds the only copy of a desktop-only business's
// data. The rules are backupService.ts; the Tech page's own buttons (tech:backupNow, tech:setBackupDir) stay as they were.
//
//   backup:status            the owner, a manager (settings.business | shifts.close_branch) or a technician
//   backup:now               the same
//   backup:chooseDir         the same — Electron's folder dialog, in main
//   backup:setDir            the same — proven by writing a backup there at once (maintenance.setBackupDir)
//   backup:chooseRestoreFile the owner or a technician — Electron's file dialog, then the checks (inspectBackup)
//   backup:restore           the owner or a technician, the checked file's token and the word RESTORE; restarts ZapTill
import { app, dialog, BrowserWindow } from 'electron';
import { assertPayload } from '../ipcValidate';
import { closeLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { backupStatus, takeSnapshot, setBackupDir } from '../maintenance';
import { getActiveSession, logTechAction, closeTechReadonlyDb } from '../techService';
import {
  assertMayBackup, assertMayRestore, mayRestore, inspectBackup, stageRestore, lastRestore, restoreChooserDir,
} from '../backupService';
import { type IpcShared } from './shared';

export function registerBackupHandlers(ctx: IpcShared) {
  const { handle } = ctx;
  const win = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

  handle('backup:status', async () => {
    assertMayBackup();
    return { ...backupStatus(), can_restore: mayRestore(), last_restore: lastRestore() };
  });

  handle('backup:now', async () => {
    assertMayBackup();
    const r = await takeSnapshot();
    logLine('backup', r.ok ? `backed up now by hand: ${r.path} (${r.bytes} bytes)` : `"Back up now" FAILED: ${r.error}`);
    if (getActiveSession()) { try { logTechAction('backup.manual', { from: 'backup panel' }); } catch { /* */ } }
    return r;
  });

  handle('backup:chooseDir', async () => {
    assertMayBackup();
    const res = await dialog.showOpenDialog(win()!, { title: 'Choose the backup folder (a USB stick or a second disk)',
      properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths?.[0] ? null : res.filePaths[0];
  });

  handle('backup:setDir', async (_e, payload) => {
    const { dir } = assertPayload<{ dir: string | null }>({ dir: { t: 'any', optional: true } }, payload ?? {});
    assertMayBackup();
    if (dir != null && typeof dir !== 'string') throw new Error('Choose a folder.');
    const clean = typeof dir === 'string' && dir.trim() ? dir.trim() : null;
    logLine('backup', `backup folder set to ${clean ?? '(the default)'}`);
    if (getActiveSession()) { try { logTechAction('backup.dir', { dir: clean ?? '(default)' }); } catch { /* */ } }
    return setBackupDir(clean);
  });

  handle('backup:chooseRestoreFile', async () => {
    assertMayRestore();
    const res = await dialog.showOpenDialog(win()!, { title: 'Choose the backup to restore', defaultPath: restoreChooserDir(),
      properties: ['openFile'], filters: [{ name: 'ZapTill backups', extensions: ['db'] }, { name: 'All files', extensions: ['*'] }] });
    if (res.canceled || !res.filePaths?.[0]) return null;
    const check = inspectBackup(res.filePaths[0]);
    logLine('backup', `restore file checked: ${res.filePaths[0]} — ${check.ok ? 'can be restored' : `refused: ${check.refusal}`}`);
    return check;
  });

  handle('backup:restore', async (_e, payload) => {
    const { token, confirm } = assertPayload<{ token: string; confirm: string }>(
      { token: { t: 'string', min: 1 }, confirm: { t: 'string' } }, payload);
    assertMayRestore();
    const r = await stageRestore(token, confirm);
    if (!r.ok) return r;
    // Restart: the swap happens at the next start, before the database opens (restoreSwap.ts). Closed first, so the
    // WAL is folded into the file that is moved aside.
    setTimeout(() => {
      try { closeTechReadonlyDb(); } catch { /* */ }
      try { closeLocalDb(); } catch { /* */ }
      app.relaunch();
      app.exit(0);
    }, 1500);
    return r;
  });
}
