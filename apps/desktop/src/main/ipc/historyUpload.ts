// IPC: A602 — "going online later": the history upload's progress and the owner's two choices (how far back, quiet hours).
//
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6): new sales first; the history as a bulk backfill in
// quiet hours, back as far as the owner chooses. The rules are historyUpload.ts; who may is the Backup panel's (A600).
//
//   historyUpload:status       the owner, a manager (settings.business | shifts.close_branch) or a technician
//   historyUpload:setSettings  the same — { window?: '3m' | '12m' | 'all', quietFrom?: 'HH:MM', quietTo?: 'HH:MM' }
import { assertPayload } from '../ipcValidate';
import { logLine } from '../logFile';
import { assertMayBackup } from '../backupService';
import { getActiveSession, logTechAction } from '../techService';
import { historyUploadStatus, setHistorySettings, HISTORY_WINDOWS, minutesOf } from '../historyUpload';
import { type IpcShared } from './shared';

export function registerHistoryUploadHandlers(ctx: IpcShared) {
  const { handle } = ctx;

  handle('historyUpload:status', async () => {
    assertMayBackup();
    return historyUploadStatus();
  });

  handle('historyUpload:setSettings', async (_e, payload) => {
    const p = assertPayload<{ window?: string; quietFrom?: string; quietTo?: string }>({
      window: { t: 'string', optional: true }, quietFrom: { t: 'string', optional: true }, quietTo: { t: 'string', optional: true },
    }, payload ?? {});
    assertMayBackup();
    if (p.window !== undefined && !HISTORY_WINDOWS.includes(p.window as never)) throw new Error('Choose the last 3 months, the last 12 months or everything.');
    for (const t of [p.quietFrom, p.quietTo]) if (t !== undefined && minutesOf(t) === null) throw new Error('Quiet hours are a time like 22:00.');
    const s = setHistorySettings(p);
    logLine('sync', `history upload settings changed on this POS: ${s.window}, ${s.quietFrom}–${s.quietTo}`);
    if (getActiveSession()) { try { logTechAction('history.settings', { window: s.window, quietFrom: s.quietFrom, quietTo: s.quietTo }); } catch { /* */ } }
    return historyUploadStatus();
  });
}
