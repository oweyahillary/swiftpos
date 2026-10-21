// IPC: A545 credit sales a manager confirms (creditConfirm.ts). Registered from ipcHandlers.ts (D10).
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import * as creditConfirm from '../creditConfirm';   // A545
import { NO_CONNECTION_MESSAGE } from '../offlineSession';
import { type IpcShared } from './shared';

/** A545: credit sales a manager confirms. */
export function registerCreditHandlers(ctx: IpcShared) {
  const { handle, requireKey, creditOffline, manageFetch } = ctx;

  // ── A545: credit sales a manager confirms (Manager › Sales › Credit sales; creditConfirm.ts) ──────────────────────────
  // Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that
  // it was done." customers.credit — the same key the cloud checks. A manager signed in here decides AS THEMSELVES (A433):
  // online with their own sign-in (manageFetch); offline the decision is kept and the sync sends it later (the till's
  // own sign-in naming who). The list is the cloud's; the last one read is kept for offline.
  const CREDIT_REFUSED = 'Your role does not confirm sales on account.';
  handle('credit:list', async () => {
    requireKey(['customers.credit'], CREDIT_REFUSED);
    const db = getLocalDb();
    try {
      const r = await manageFetch('/api/credit/sales?state=open', 'GET') as { rows?: creditConfirm.CreditSaleView[] } | null;
      creditConfirm.writeCache(db, r?.rows ?? []);
      return { online: true, saved_at: null, rows: creditConfirm.overlay(r?.rows ?? [], creditConfirm.readPending(db)), refused: creditConfirm.readRefused(db) };
    } catch (e: any) {
      if (!creditOffline()) throw e;
      const c = creditConfirm.readCache(db);
      return { online: false, saved_at: c?.at ?? null, message: e?.message ?? NO_CONNECTION_MESSAGE,
        rows: creditConfirm.overlay(c?.rows ?? [], creditConfirm.readPending(db)), refused: creditConfirm.readRefused(db) };
    }
  });
  handle('credit:decide', async (_e, payload) => {
    const { orderId, decision, reason } = assertPayload<{ orderId: string; decision: 'confirm' | 'dispute'; reason?: string }>(
      { orderId: { t: 'string', min: 1 }, decision: { t: 'string', min: 1 }, reason: { t: 'string', optional: true } }, payload);
    requireKey(['customers.credit'], CREDIT_REFUSED);
    const problem = creditConfirm.decisionProblem({ decision, reason });
    if (problem) throw new Error(problem);
    const db = getLocalDb();
    const me = db.prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as { staff_id: string | null; staff_name: string | null } | undefined;
    if (!me?.staff_id) throw new Error('Not signed in');
    const why = String(reason ?? '').trim().slice(0, 300);
    try {
      // Both paths written out (tests/desktop-writes-allowed reads each against MANAGER_WRITES).
      const r = await manageFetch(decision === 'dispute' ? `/api/credit/sales/${encodeURIComponent(orderId)}/dispute` : `/api/credit/sales/${encodeURIComponent(orderId)}/confirm`,
        'POST', decision === 'dispute' ? { reason: why } : {});
      creditConfirm.applyToCache(db, orderId, { state: decision === 'confirm' ? 'confirmed' : 'disputed', decided_by_name: r?.decided_by_name ?? me.staff_name,
        decided_at: r?.decided_at ?? new Date().toISOString(), dispute_reason: decision === 'dispute' ? why : null });
      logLine('manage', `A545 credit sale ${orderId} ${decision}ed by ${me.staff_name ?? me.staff_id}`);
      return { state: 'saved' as const };
    } catch (e: any) {
      if (!creditOffline()) throw e;
      creditConfirm.queueDecision(db, { order_id: orderId, decision, reason: why, by: me.staff_id, by_name: me.staff_name ?? null, at: new Date().toISOString() });
      logLine('manage', `A545 credit sale ${orderId} ${decision}ed by ${me.staff_name ?? me.staff_id} — kept on this till until the cloud is back`);
      return { state: 'pending' as const, message: 'Saved on this till — it goes to the cloud when the connection is back.' };
    }
  });
  // The Close Day / Close Branch notice: how many credit sales wait for a manager. NEVER blocks a close — a count only.
  // The cloud's count with the person's own sign-in when it answers (whoever closes the day may read it), else the saved list.
  handle('credit:awaiting', async () => {
    const db = getLocalDb();
    try {
      const r = await manageFetch('/api/credit/sales/count', 'GET') as { awaiting?: number } | null;
      const n = Math.max(0, Number(r?.awaiting) || 0) - creditConfirm.readPending(db).length;
      return { count: Math.max(0, n), notice: creditConfirm.awaitingSentence(Math.max(0, n)), saved: false };
    } catch {
      const c = creditConfirm.readCache(db);
      const n = creditConfirm.awaitingCount(c?.rows ?? [], creditConfirm.readPending(db));
      return { count: n, notice: creditConfirm.awaitingSentence(n), saved: true };
    }
  });
  handle('credit:dismiss', async (_e, orderId: string) => {
    requireKey(['customers.credit'], CREDIT_REFUSED);
    creditConfirm.dismissRefused(getLocalDb(), String(orderId));
    return { ok: true as const };
  });
}
