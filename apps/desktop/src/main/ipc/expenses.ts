// IPC: expenses recorded at the till. Registered from ipcHandlers.ts (D10).
import { isNodeRole } from '../deviceConfig';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { readSessionTokens, readStaffTokens } from '../tokenStore';
import { cloudFetch } from '../cloudGateway';
import { getOpenShift } from '../syncEngine';
import { signedIn as sessionPerson, personCan, mayMoveMoney } from '../tillAccess';
import { getDeviceConfig, getPosFeatures } from '../deviceConfig';
import { recordExpense, listExpenses } from '../shiftService';
import { resolveRange } from '../managerReports';
import { RangeArg, type IpcShared } from './shared';

/** Expenses recorded at the till. */
export function registerExpenseHandlers(ctx: IpcShared) {
  const { handle, requireKey, signedInConfirmer, payoutApprover, manageFetch } = ctx;

  // ── Expenses (record petty-cash at the till) ──────────────────────────────

  // List categories from server (online) for the expense form
  handle('expense:categories', async () => {
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) return [];
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    if (!token) return [];
    try {
      const res = await cloudFetch(`${cfg.server_url}/api/expenses/categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  });

  // A341: a manager adds an expense type from the till — saved on the cloud (the dashboard's own route and
  // permission, expenses.manage); manageFetch gives the offline / role messages.
  handle('expense:addCategory', async (_e, { name }: { name: string }) => {
    requireKey(['expenses.manage'], 'Your role does not add expense types.');   // A490
    return manageFetch('/api/expenses/categories', 'POST', { name: String(name ?? '').trim() });
  });

  // Save expense locally (syncs up on next push pass)
  handle('expense:create', async (_event, {
    description, amount, expense_category_id, paid_by, payment_method, category_name, pin, no_drawer,
  }: { description: string; amount: number; expense_category_id?: string; paid_by?: string;
       payment_method?: string; category_name?: string; pin?: string; no_drawer?: boolean }) => {
    // 0.6.37 (A388): every expense needs a manager — signed in, or their PIN on the spot. A594: a person without
    // shifts.cash_movements is no longer refused outright (A453/A490) — the manager's approval is the check, as for a cash
    // in or a cash out (cashiers lost the key by default in A594, and still record a drawer expense with a manager's PIN).
    const approver = await payoutApprover(pin);
    // the till's own open drawer (none: paid outside any drawer). A466: on the branch server a manager may record it
    // "Not from a drawer" even while this terminal has a shift open (owner: "the manager can fail to choose a drawer").
    const outside = no_drawer === true && isNodeRole(getDeviceConfig()?.device_role) && signedInConfirmer() !== null;
    const shift = outside ? null : getOpenShift();
    // A465: the insert lives in shiftService.recordExpense — the branch server's instruction records the same way.
    const { id } = recordExpense({
      shiftId: shift?.id ?? null, description, amount, expense_category_id: expense_category_id ?? null,
      category_name: category_name ?? null, payment_method: payment_method ?? null, paid_by: paid_by ?? null, approver,
    });
    logLine('shift', `expense ${Number(amount)} approved by ${approver.name ?? approver.id}`);
    return { id, approvedBy: approver.name };
  });

  // 0.6.11 (owner: "I should be able to see expenses") — the manager's Expenses screen, by date range.
  handle('expense:range', async (_e, r?: RangeArg) => {
    requireKey(['expenses.view', 'expenses.manage'], 'Your role does not see expenses.');   // A490
    const range = resolveRange(r?.preset ?? 'today', r?.from, r?.to);
    return { ...listExpenses(range.from, range.to), label: range.label };
  });

  // Recent expenses for the current shift (for display in ShiftPanel)
  handle('expense:list', async () => {
    // A490: expenses.view — or the person recording money on this drawer (they see what they recorded on it).
    const me = sessionPerson();
    // A594: and whoever sells on it (a cashier records a drawer expense with a manager's PIN, key or not).
    if (!me || !(personCan(me, 'expenses.view', 'expenses.manage', 'orders.create') || mayMoveMoney(me, getPosFeatures().cashier_no_money_out))) return [];
    const db = getLocalDb();
    const shift = db.prepare(`SELECT id FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY created_at DESC LIMIT 1`).get(getDeviceConfig()?.device_id ?? null) as any;
    if (!shift) return [];
    return db.prepare(`
      SELECT id, description, amount, expense_category_id, paid_by, created_at, sync_status,
             expense_type_name AS category_name, COALESCE(payment_method, 'cash') AS payment_method
      FROM expenses WHERE shift_id=? ORDER BY created_at DESC
    `).all(shift.id);
  });
}
