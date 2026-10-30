// IPC: shifts — open, cash in / out, close, a manager confirming one, other tills' shifts, Z-reports and history.
// Registered from ipcHandlers.ts (D10); two register functions so the channels register in the order they always did.
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { getOpenShift } from '../syncEngine';
import { CASH_MOVEMENT_REASON_REQUIRED, DRAWER_COUNT_WARNING, cashMovementNeedsApprover, looksLikeDrawerCount } from '@zaptill/core/posFeatures';   // A594
import { signedIn as sessionPerson, personCan, mayMoveMoney } from '../tillAccess';
import { getDeviceConfig, getPosFeatures } from '../deviceConfig';
import { openShift, addFloat, closeShift, currentShiftReport, computeZReport, forceCloseShift, listShifts, awaitingConfirmation, confirmShift, shiftCloseRights, blindClose, blindReport, confirmView } from '../shiftService';
import { kitchenCloseBlock } from '../kitchenService';
import { type IpcShared } from './shared';

/** Opening, moving money on and closing a shift; a manager confirming one (here or another till's). */
export function registerShiftHandlers(ctx: IpcShared) {
  const { handle, requireKey, fetchForeignCash, pushNow, identifyConfirmer, signedInConfirmer, payoutApprover, SHIFTS_REFUSED, manageFetch } = ctx;

  handle('shift:forceClose', async (_e, { reason }: { reason: string }) => {
    // Audit 2026-10-14: enforced HERE, not only by hiding the button. A490: shifts.force_close (the owner always).
    requireKey(['shifts.force_close'], 'Only someone who may force-close a drawer can do that.');
    const z = forceCloseShift(String(reason ?? ''));
    pushNow();
    return z;
  });

  handle('shift:open', async (_event, { opening_float, drawer_label }: { opening_float: number; drawer_label?: string }) => {
    openShift(Number(opening_float) || 0, drawer_label);
    logLine('shift', `open float ${Number(opening_float) || 0}${drawer_label ? ` (${drawer_label})` : ''}`);
    pushNow();
    return currentShiftReport();
  });

  handle('shift:float', async (_event, { type, amount, reason, pin, countAck }: { type: 'float_in' | 'float_out'; amount: number; reason?: string; pin?: string; countAck?: boolean }) => {
    // A594 (owner, 2026-10-26: "turn off that option for cashiers by default unless allowed"): every cash in / cash out
    // gives a reason; a person without "Record cash in" (shifts.cash_movements) needs a manager — signed in, or their PIN on
    // the spot — for a cash in too (a cash out always did, A388).
    const why = String(reason ?? '').trim();
    if (!why) throw new Error(CASH_MOVEMENT_REASON_REQUIRED);
    if (!(Number(amount) > 0)) throw new Error('Enter an amount greater than zero');
    // A594: a cash in of what the drawer should hold (or its cash sales) is a count typed in the wrong place — said before
    // anything is written, and recorded only once the person confirms it is a real cash in (countAck). The figure itself
    // is never sent back (a cashier's close stays blind).
    if (type === 'float_in' && countAck !== true) {
      const r = currentShiftReport();
      if (r && looksLikeDrawerCount(Number(amount), { openingFloat: r.shift.opening_float, cashSales: r.totals.cashSales, expected: r.totals.expectedCash })) {
        throw new Error(DRAWER_COUNT_WARNING);
      }
    }
    // 0.6.37 (A388): a cash-out needs a manager — signed in, or their PIN on the spot. A594: so does a cash in by anyone who
    // may not record one on their own (A453 refused them outright; now a manager approves on the spot instead).
    // shifts.cash_movements is "Record cash in" (A594); on a map from before the catalogue, A453's switch rule (mayMoveMoney).
    const mayCashIn = mayMoveMoney(sessionPerson(), getPosFeatures().cashier_no_money_out);
    const approver = cashMovementNeedsApprover(type, mayCashIn) ? await payoutApprover(pin) : null;
    addFloat(type, Number(amount), why.slice(0, 200), approver);
    logLine('shift', `${type === 'float_in' ? 'cash in' : 'pay-out'} ${Number(amount)}${approver ? ` approved by ${approver.name ?? approver.id}` : ''}${countAck === true ? ' (confirmed: not a drawer count)' : ''}`);
    pushNow();
    return currentShiftReport();
  });

  handle('shift:close', async (_event, { closing_float, notes, declared }: { closing_float: number; notes?: string; declared?: Record<string, number> }) => {
    // Returns the final Z-report. Throws (with .variance/.expected_cash) if a
    // variance note is required — the renderer surfaces that message.
    // A334: a shared drawer's web cash is part of what the cashier counted.
    // A365: `declared` — the cashier's figure for every payment method; the shift then awaits a manager.
    // 0.6.28: with 'kitchen_void_approval', not while an order sent to the kitchen on this shift is unpaid.
    const openShiftId = currentShiftReport()?.shift.id;
    const kitchenBlock = openShiftId ? kitchenCloseBlock(openShiftId) : null;
    if (kitchenBlock) throw new Error(kitchenBlock);
    const z = closeShift(Number(closing_float), notes, await fetchForeignCash(currentShiftReport()?.shift.id), declared ?? null);
    logLine('shift', `close float ${Number(closing_float) || 0}`);
    pushNow();
    return blindClose() ? blindReport(z) : z;   // 0.6.27: a blind close hands back no figures
  });

  handle('shift:awaiting', async () => awaitingConfirmation());

  // A366: may the signed-in person close the open shift (its owner or a manager)? The screen asks first; closeShift
  // enforces it regardless.
  handle('shift:closeRights', async () => ({ ...shiftCloseRights(getOpenShift()), blind: blindClose() }));
  handle('shift:canConfirm', async () => signedInConfirmer() !== null);

  handle('shift:confirm', async (_event, payload) => {
    const { shiftId, pin, counts, reasons } = assertPayload<{ shiftId: string; pin?: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { shiftId: { t: 'string', min: 1 }, pin: { t: 'string', optional: true }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    const signedIn = signedInConfirmer();
    if (!signedIn && !String(pin ?? '').trim()) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    const confirmer = signedIn && !String(pin ?? '').trim() ? signedIn : await identifyConfirmer(String(pin));
    const c = confirmShift(shiftId, confirmer, counts, reasons ?? null);   // 0.6.27: reasons
    logLine('shift', `A365 shift ${shiftId} confirmed by ${confirmer.name ?? confirmer.id}${c.self ? ' (self-confirmed)' : ''}` +
      `${c.lines.some((l) => l.mismatch) ? ' — recount differs from the cashier' : ''}`);
    pushNow();
    return c;
  });

  // 0.6.27: may the confirm screen show the cashier's figures ('confirm_shows_cashier_figures')?
  // A452: the expected figures only to a manager signed in here — never to the cashier whose shift it is (blind close).
  handle('shift:confirmView', async (_event, shiftId: string) => {
    const v = confirmView(String(shiftId));
    return signedInConfirmer() ? v : { ...v, expected: null, cash: null };   // A527: the cash lines carry the expected figure
  });
  // ── A433 (owner, 2026-10-10: "yes if they have logged in as the manager, and under sales report it should cover all
  // tills"): another till's shifts, from the cloud, with the manager's own sign-in (manageFetch — never the till's
  // session, A415). This till's own shifts keep the local calls above (they work offline and push as before).
  handle('manager:branchShifts', async () => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    const own = getDeviceConfig()?.device_id ?? null;
    const rows = await manageFetch('/api/shifts?limit=60', 'GET') as any[];
    return (rows ?? []).map((s) => ({
      id: s.id, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at ?? null,
      cashier_name: s.cashier_name ?? null, expected_cash: s.expected_cash ?? null, cash_variance: s.cash_variance ?? null,
      till: s.terminal_code || (s.device_id ? 'POS' : 'Web POS'),
      this_till: !!own && s.device_id === own,
      awaiting: !!s.awaiting_confirmation,
    }));
  });
  handle('manager:remoteZReport', async (_e, shiftId: string) => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    const z = await manageFetch(`/api/shifts/${encodeURIComponent(String(shiftId))}/zreport`, 'GET');
    const session = getLocalDb().prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as any;
    return { ...z, businessName: session?.business_name ?? '', currency: session?.currency ?? 'KES' };
  });
  handle('shift:remoteConfirmView', async (_e, shiftId: string) => {
    requireKey(['shifts.confirm'], 'Only someone who confirms drawers sees that.');   // A490: it carries the expected figures
    return manageFetch(`/api/shifts/${encodeURIComponent(String(shiftId))}/confirm-view`, 'GET');
  });
  handle('shift:remoteConfirm', async (_event, payload) => {
    const { shiftId, pin, counts, reasons } = assertPayload<{ shiftId: string; pin?: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { shiftId: { t: 'string', min: 1 }, pin: { t: 'string', optional: true }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    const me = signedInConfirmer();
    if (!me && !String(pin ?? '').trim()) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    // manager-confirm: a person's sign-in only (never the device token), and never `confirmed_by` — that is the holding
    // till's replay of its OWN shift. The cloud takes the signed-in manager, or the PIN.
    const r = await manageFetch(`/api/shifts/${encodeURIComponent(shiftId)}/manager-confirm`, 'POST', {
      confirmed_methods: counts, ...(reasons ? { confirm_reasons: reasons } : {}), ...(String(pin ?? '').trim() ? { pin: String(pin).trim() } : {}),
    });
    logLine('shift', `A433 shift ${shiftId} (another till) confirmed on the cloud by ${r?.confirmer_name ?? me?.name ?? 'a manager'}`);
    return {
      shift_id: shiftId, confirmed_by: r?.confirmed_by ?? me?.id ?? '', confirmed_by_name: r?.confirmer_name ?? me?.name ?? null,
      confirmed_at: r?.confirmed_at ?? new Date().toISOString(), self: !!r?.confirm_self, lines: r?.lines ?? [],
    };
  });
}

/** A shift's Z-report and the shift history. */
export function registerShiftReportHandlers(ctx: IpcShared) {
  const { handle, requireKey, fetchForeignCash, SHIFTS_REFUSED } = ctx;

  // A490: any shift's report — reports.shifts or shifts.confirm. A cashier gets their OWN shift's report, blind when
  // their close is (the same report shift:close hands them).
  handle('shift:zreport', async (_event, shiftId: string) => {
    const me = sessionPerson();
    if (!me) throw new Error('Sign in to see a shift report.');
    const seesAny = personCan(me, 'reports.shifts', 'shifts.confirm');
    if (!seesAny) {
      const row = getLocalDb().prepare(`SELECT cashier_id, opened_by FROM shifts WHERE id = ?`).get(String(shiftId)) as { cashier_id?: string | null; opened_by?: string | null } | undefined;
      if (!row || (row.cashier_id !== me.staffId && row.opened_by !== me.staffId)) throw new Error(SHIFTS_REFUSED);
    }
    const z = computeZReport(shiftId, await fetchForeignCash(shiftId));   // A334
    return !seesAny && blindClose() ? blindReport(z) : z;
  });

  // 0.6.11 (owner: "I should be able to print previous shift reports") — this till's shifts, newest first.
  // Each opens through shift:zreport above, which already rebuilds any shift's report from local data. A490: the list of
  // every shift is reports.shifts / shifts.confirm.
  handle('shift:history', async () => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    return listShifts(60);
  });
}
