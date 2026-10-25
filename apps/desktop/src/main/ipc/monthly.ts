// IPC: A466 the monthly pack on the till. Registered from ipcHandlers.ts (D10).
import { dialog, BrowserWindow } from 'electron';
import { assertPayload } from '../ipcValidate';
import fs from 'fs';
import path from 'path';   // A516
import { signedInCan } from '../tillAccess';
import { OFFLINE_SESSION_MESSAGE, NO_CONNECTION_MESSAGE } from '../offlineSession';
import { type IpcShared } from './shared';

/** A466: the monthly pack. */
export function registerMonthlyHandlers(ctx: IpcShared) {
  const { handle, manageFetch, transferBranch } = ctx;

  // ── A466: the monthly pack on the till (Manager › Sales › Monthly pack) ─────────────────────────────────────────────
  // Owner, 2026-10-13: "desktop app does not have some reports I added yesterday, can you add them" — A455's monthly pack.
  // The cloud builds it from every till's records (routes/reports-monthly.ts), so it is online only; the manager's own
  // PIN sign-in reads it (reports.financial) and records for the books (expenses.manage), for this till's branch.
  const MONTHLY_OFFLINE = 'The monthly pack needs a connection — it is built from every POS\'s records on the cloud.';
  const monthlyAnswer = async (fn: () => Promise<any>, refused = 'Your role does not open the monthly pack (it needs financial reports).') => {
    try { return { ok: true, data: await fn() }; }
    catch (e: any) {
      const offline = e?.message === NO_CONNECTION_MESSAGE || e?.message === OFFLINE_SESSION_MESSAGE;
      // A plain 403 (no code) is the person's permission; manageFetch words it for a change, this says which.
      const error = offline ? MONTHLY_OFFLINE : e?.status === 403 && !e?.code ? refused : (e?.message ?? MONTHLY_OFFLINE);
      return { ok: false, error, code: offline ? 'offline' : (e?.code ?? null), status: e?.status ?? null };
    }
  };
  const MONTHLY_RECORD_REFUSED = 'Your role does not record for the books (it needs expense management), or this is not your branch.';
  /** month=YYYY-MM&branch_id=… for this till's branch (or the one asked for), or why not. */
  const monthlyQuery = (month: string, branchId?: string): { q: string; branch: string } | { error: string } => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) return { error: 'Pick a month.' };
    const branch = (branchId && branchId.trim()) || transferBranch();
    if (!branch) return { error: 'This POS is not bound to a branch.' };
    return { q: `month=${month}&branch_id=${encodeURIComponent(branch)}`, branch };
  };
  // A490: reading the pack is reports.monthly_pack or expenses.manage (A481); recording for the books expenses.manage.
  const MONTHLY_READ = ['reports.monthly_pack', 'expenses.manage'];
  handle('monthly:get', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    const r = await monthlyAnswer(() => manageFetch(`/api/reports/monthly?${mq.q}`, 'GET'));
    return r.ok ? { ...r, branch_id: mq.branch } : r;
  });
  handle('monthly:export', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    const got = await monthlyAnswer(() => manageFetch(`/api/reports/monthly/export?${mq.q}`, 'GET', undefined, { binary: true }));
    if (!got.ok) return got;
    const { bytes, disposition } = got.data as { bytes: Buffer; disposition: string | null };
    // The name the cloud gave it (the web's: zaptill-monthly-<branch>-<month>.xlsx).
    const named = /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1];
    const suggested = named && /^[\w.-]+\.xlsx$/i.test(named) ? named : `zaptill-monthly-branch-${p.month}.xlsx`;
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const choice = await dialog.showSaveDialog(win!, { title: 'Save the monthly pack', defaultPath: suggested,
        filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
      if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };   // cancelling is not a failure
      const target = /\.xlsx$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.xlsx`;
      fs.writeFileSync(target, bytes);
      return { ok: true, path: target };
    } catch (e: any) { return { ok: false, error: e?.message ?? 'Could not save the file.' }; }
  });
  handle('monthly:movements', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    return monthlyAnswer(async () => (await manageFetch(`/api/reports/monthly/movements?${mq.q}`, 'GET')) ?? []);
  });
  handle('monthly:addMovement', async (_e, payload) => {
    const p = assertPayload<{ movement_date: string; method: string; kind: string; amount: number; note?: string; branch_id?: string }>(
      { movement_date: { t: 'string', min: 10 }, method: { t: 'string', min: 1 }, kind: { t: 'string', min: 1 }, amount: { t: 'number' },
        note: { t: 'string', optional: true }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan('expenses.manage')) return { ok: false, error: MONTHLY_RECORD_REFUSED };   // A490
    const branch = (p.branch_id && p.branch_id.trim()) || transferBranch();
    if (!branch) return { ok: false, error: 'This POS is not bound to a branch.' };
    // The cloud checks the rest (kind, amount, a note for other income / personal) and the person's expenses.manage.
    return monthlyAnswer(() => manageFetch('/api/reports/monthly/movements', 'POST', { branch_id: branch, movement_date: p.movement_date,
      method: p.method, kind: p.kind, amount: p.amount, note: p.note?.trim() || undefined }), MONTHLY_RECORD_REFUSED);
  });
  handle('monthly:removeMovement', async (_e, payload) => {
    const p = assertPayload<{ id: string }>({ id: { t: 'string', min: 1 } }, payload);
    if (!signedInCan('expenses.manage')) return { ok: false, error: MONTHLY_RECORD_REFUSED };   // A490
    return monthlyAnswer(() => manageFetch(`/api/reports/monthly/movements/${encodeURIComponent(p.id)}`, 'DELETE'), MONTHLY_RECORD_REFUSED);
  });
}
