// IPC: the open shift and business day, the day gate, and closing the branch from its server (branchClose:*).
// Registered from ipcHandlers.ts (D10).
import { BrowserWindow } from 'electron';
import { isNodeRole } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { v4 as uuid } from 'uuid';
import { syncPush, learnBeforeLock } from '../syncEngine';
import { signedIn as sessionPerson, signedInCan, mayMoveMoney } from '../tillAccess';
import { getDeviceConfig, getPosFeatures } from '../deviceConfig';
import { currentShiftReport, getStaleShift, blindClose, blindReport } from '../shiftService';
import { checkDayGate, getOpenDay, getDayCloseSummary, closeDay, mayCloseDay, mayCloseBranch, getConflictedShifts, retryConflictedShift, businessDateNow } from '../dayService';
import { branchCloseOverview, createCloseInstruction, executeCloseDay, createConfirmInstruction, executeConfirmShift, type PeerDayState } from '../branchClose';
import { executeShiftMoney, createShiftMoneyInstruction, cancelShiftMoneyInstruction, SHIFT_MONEY_CLOSED, type ShiftMoneyPayload } from '../branchClose';   // A465
import { forgetTill } from '../branchClose';   // F4
import { hideTill, peerIsStale, unresolvedBlockers } from '../branchClose';   // A521
import { ownOpenShift } from '../shiftService';   // A465
import { TILL_OFF_NOTE, type IpcShared } from './shared';

/** The open shift and day, the day gate, and closing the branch from its server (branchClose:*). */
export function registerDayCloseHandlers(ctx: IpcShared) {
  const { handle, requireKey, fetchForeignCash, pushNow, signedInConfirmer } = ctx;

  // ── Shifts (offline cash-up + Z-report) ─────────────────────

  // includeForeign (A334): the close screen and the manager report add the web's cash on a shared
  // drawer. The POS sell gate calls this WITHOUT it — it must never wait on the cloud.
  handle('shift:current', async (_e, opts?: { includeForeign?: boolean }) => {
    // 0.6.27: a cashier on a blind close gets the report without its figures (blindReport).
    const view = (z: ReturnType<typeof currentShiftReport>) => (z && blindClose() ? blindReport(z) : z);
    if (!opts?.includeForeign) return view(currentShiftReport());
    const local = currentShiftReport();
    if (!local) return null;
    return view(currentShiftReport(await fetchForeignCash(local.shift.id)));
  });

  // A shift left open past ~18h. Reported, never auto-closed — see
  // forceCloseShift() for why a fabricated cash count is worse than none.
  // A490: the drawer's expected cash only to someone who may confirm drawers (shifts.confirm) — the banner still shows.
  handle('shift:stale', async () => {
    const s = getStaleShift();
    return s && !signedInCan('shifts.confirm') ? { ...s, expectedCash: null } : s;
  });

  // ── Trading day (per till) ────────────────────────────────────────────────
  // checkDayGate is what the POS screen reads to decide whether it may sell at
  // all. closeDay is manager-gated inside dayService, NOT by hiding the button:
  // a control that exists only in the UI is a suggestion.
  // Which terminal this is. Read-only identity for display: the cashier should
  // not be asked which till they are standing at when the install already knows.
  handle('device:identity', async () => {
    const cfg = getDeviceConfig();
    return {
      deviceId:     cfg?.device_id ?? null,
      terminalCode: cfg?.terminal_code ?? null,
      deviceName:   cfg?.device_name ?? null,   // A334: the join notice names the till
    };
  });

  // Fail CLOSED. If this check throws, the renderer's .catch leaves dayGate
  // null, needsShift computes false, and the till trades with no drawer until
  // the raw driver error surfaces inside the payment modal — which is exactly
  // what a missing bind in getOpenShift did in production. A gate that cannot
  // run must block and say why, using the same hard-block UI as an unclosed day.
  handle('day:gate', async () => {
    try {
      let gate = checkDayGate();
      // A523: before telling the till it is locked, ask the cloud what it closed (a drawer force-closed on the web, a day
      // closed on the web or as abandoned) — adopted here, then the gate is read again. At most once a minute, at most
      // a few seconds' wait; offline the lock shows at once. An old day with nothing left to count already closed itself
      // inside checkDayGate (autoCloseEmptyDay).
      if (gate.needsManager && gate.staleDay && await learnBeforeLock()) gate = checkDayGate();
      return gate;
    }
    catch (err: any) {
      return {
        canTrade: false,
        needsManager: true,
        reason: `This POS cannot verify its trading day (${err?.message ?? 'internal error'}). ` +
                'Restart the app; if this persists, contact support.',
      };
    }
  });
  handle('day:current', async () => getOpenDay());

  // ── Central day close (Phase 4) — node-side manager screen ────────────────
  // A490: Close Branch is shifts.close_day — its overview (every till's figures) too.
  // A520: Close Branch is its own right, shifts.close_branch (a supervisor closes a till's day, not the branch). The
  // overview — every till's figures — is also read by the server's expense form (RecordExpenseForm), so close_day still
  // reads it; closing anything from it is close_branch.
  const CLOSE_REFUSED = 'Only someone who may close the branch can do this (Close the branch, in Roles and permissions).';
  handle('branchClose:overview', async () => {
    if (!mayCloseBranch() && !mayCloseDay()) return { error: CLOSE_REFUSED };
    try { return branchCloseOverview(); }
    catch (err: any) { return { error: err?.message ?? 'Could not read the branch state' }; }
  });
  handle('branchClose:closeTill', async (_e, { device_id, counted_cash, notes }:
    { device_id: string; counted_cash: number; notes?: string }) => {
    try {
      if (!mayCloseBranch()) return { ok: false, error: CLOSE_REFUSED };   // A520
      const cfg = getDeviceConfig();
      const staff = getLocalDb().prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as any;
      const payload = {
        business_date: businessDateNow(),
        counted_cash: Number(counted_cash),
        notes,
        closed_by_staff_id: staff?.staff_id ?? null,
        closed_by_name: staff?.staff_name ?? null,
      };
      if (device_id === cfg?.device_id) {
        // The node is a normal till; its own day closes directly — no
        // instruction, no poll, and any refusal surfaces immediately.
        const r = executeCloseDay(payload);
        return r.ok ? { ok: true, self: true, summary: r.summary ?? null, already_closed: r.already_closed ?? false }
                    : { ok: false, error: r.error };
      }
      // A521 (#14): to a till that is not connected it is a close that waits for it (createCloseInstruction) — said so.
      const offline = peerIsStale(device_id);
      const { id } = createCloseInstruction(device_id, payload, staff?.staff_id ?? null);
      return { ok: true, instruction_id: id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not start the close' };
    }
  });
  // A452: a manager on the branch server confirms another till's shift — counted here, with the till's expected figures
  // on screen; the till itself records it (its own books), as when a manager confirms at that till.
  handle('branchClose:confirmShift', async (_e, payload) => {
    const { device_id, shift_id, counts, reasons } = assertPayload<{ device_id: string; shift_id: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { device_id: { t: 'string', min: 1 }, shift_id: { t: 'string', min: 1 }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    try {
      const confirmer = signedInConfirmer();
      if (!confirmer) return { ok: false, error: 'Only a manager (or the owner) signed in here can confirm a shift.' };
      const instr = { shift_id, counts, reasons: reasons ?? null, confirmer };
      if (device_id === getDeviceConfig()?.device_id) {
        const r = executeConfirmShift(instr);
        if (r.ok) pushNow();
        return r.ok ? { ok: true, self: true, summary: r.summary ?? null } : { ok: false, error: r.error };
      }
      const offline = peerIsStale(device_id);   // A521 (#13): kept for it however long it is off — and said so
      const { id } = createConfirmInstruction(device_id, instr, confirmer.id);
      logLine('branchClose', `A452 confirm of shift ${shift_id} sent to ${device_id} by ${confirmer.name ?? confirmer.id}${offline ? ' (not connected — applies when it reconnects)' : ''}`);
      return { ok: true, instruction_id: id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not confirm the shift' };
    }
  });
  // A465 (owner, 2026-10-13): a manager on the BRANCH SERVER records a cash in, cash out or expense on ANY running shift
  // of the branch. The server never writes another till's row: it queues an instruction that till collects (~15 s) and
  // records on its own books — its Z-report, its push and Close Branch stay one story. The server's own drawer: at once.
  handle('branchClose:shiftMoney', async (_e, payload) => {
    const p = assertPayload<{ device_id: string; shift_id: string; kind: 'float_in' | 'float_out' | 'expense'; amount: number;
      reason?: string; description?: string; expense_category_id?: string; category_name?: string; payment_method?: string }>({
      device_id: { t: 'string', min: 1 }, shift_id: { t: 'string', min: 1 }, kind: { t: 'enum', values: ['float_in', 'float_out', 'expense'] },
      amount: { t: 'number' }, reason: { t: 'string', optional: true }, description: { t: 'string', optional: true },
      expense_category_id: { t: 'string', optional: true }, category_name: { t: 'string', optional: true }, payment_method: { t: 'string', optional: true },
    }, payload);
    try {
      const cfg = getDeviceConfig();
      if (!isNodeRole(cfg?.device_role)) return { ok: false, error: 'Only the branch server records money on another POS\'s shift.' };
      // A manager signed in here approves it as themselves (A388); A453's manager-only switch always lets a manager through.
      // A490: approving is shifts.confirm; recording money is shifts.cash_movements (before migration 134, the switch rule).
      const me = signedInConfirmer();
      if (!me || !mayMoveMoney(sessionPerson(), getPosFeatures().cashier_no_money_out)) return { ok: false, error: 'Only a manager who may approve and record cash movements, signed in here, can do this.' };
      const amount = Math.round(Number(p.amount) * 100) / 100;
      if (!(amount > 0)) return { ok: false, error: 'Enter an amount greater than zero.' };
      if (p.kind === 'expense' && !String(p.description ?? '').trim()) return { ok: false, error: 'Description is required.' };
      const isSelf = p.device_id === cfg?.device_id;
      if (isSelf) {
        if (!ownOpenShift(p.shift_id)) return { ok: false, error: SHIFT_MONEY_CLOSED };
      } else {
        // Only to a till whose last report shows this shift open. A521 (#13, owner 2026-10-17: "never wait on an absent
        // till … queue the rest for when it reconnects"): a till that is off is no longer refused — the row waits for it
        // (no 24-h expiry; Cancel withdraws it until the till picks it up) and the manager is told it applies on reconnect.
        // A till that closed that shift meanwhile refuses it with its reason (SHIFT_MONEY_CLOSED), shown on the screen.
        const row = getLocalDb().prepare(`SELECT state, updated_at FROM node_peer_state WHERE device_id = ?`).get(p.device_id) as { state: string; updated_at: string } | undefined;
        if (!row) return { ok: false, error: 'That POS has never reported to this server — check it is on' };
        let st: PeerDayState | null = null;
        try { st = JSON.parse(row.state); } catch { /* unreadable */ }
        if (!st?.shifts) return { ok: false, error: 'That POS is on an older version — update it to record money on it from here.' };
        if (!st.shifts.some((s) => s.id === p.shift_id && s.state === 'open')) return { ok: false, error: 'That shift is no longer open on its POS.' };
      }
      const instr: ShiftMoneyPayload = {
        row_id: uuid(), shift_id: p.shift_id, kind: p.kind, amount,
        reason: p.kind === 'expense' ? null : (String(p.reason ?? '').trim().slice(0, 200) || null),
        description: p.kind === 'expense' ? String(p.description).trim().slice(0, 200) : null,
        expense_category_id: p.kind === 'expense' ? (p.expense_category_id || null) : null,
        category_name: p.kind === 'expense' ? (p.category_name ?? null) : null,
        payment_method: p.kind === 'expense' ? (p.payment_method || 'cash') : null,
        approver: me, recorded_by: me,
      };
      const what = `${p.kind === 'expense' ? 'expense' : p.kind === 'float_in' ? 'cash in' : 'cash out'} ${amount}`;
      if (isSelf) {
        const r = executeShiftMoney(instr);
        if (!r.ok) return { ok: false, error: r.error };
        pushNow();
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('shift:changedElsewhere', { id: p.shift_id, kind: p.kind });
        }
        logLine('branchClose', `A465 ${what} on this server's shift ${p.shift_id} by ${me.name ?? me.id}`);
        return { ok: true, row_id: instr.row_id, direct: true, summary: r.summary ?? null };
      }
      const offline = peerIsStale(p.device_id);   // A521
      const { id } = createShiftMoneyInstruction(p.device_id, instr, me.id);
      logLine('branchClose', `A465 ${what} on shift ${p.shift_id} sent to ${p.device_id} by ${me.name ?? me.id}${offline ? ' (not connected — applies when it reconnects)' : ''}`);
      return { ok: true, instruction_id: id, row_id: instr.row_id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not record it' };
    }
  });
  // F4 (2026-10-14): "Forget this till" — a till gone for good (replaced, moved) leaves Close Branch at once. Its history
  // stays (the branch's data). A521 (#3): named "Revoke this till" for what it does — its device key and its right to
  // reconnect go with it, so it is refused on every route until it joins again (Find my server). The screen said "it
  // comes back if it reports again"; it could not report. A till only off for a while is hidden instead (hideTill).
  handle('branchClose:forgetTill', async (_e, payload) => {
    const { device_id } = assertPayload<{ device_id: string }>({ device_id: { t: 'string', min: 1 } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) return { ok: false, error: 'Only the branch server revokes a POS.' };
    if (!mayCloseBranch()) return { ok: false, error: 'Only someone who may close the branch can revoke a POS.' };   // A520
    if (!forgetTill(device_id)) return { ok: false, error: 'That POS cannot be revoked here.' };
    logLine('branchClose', `F4/A521 till ${device_id} revoked by a manager (its device key removed — it joins again to reconnect)`);
    return { ok: true };
  });
  // A521 (#3): "Hide from Close Branch" — off the list until it next reports; its key, its right to reconnect and what
  // waits for it are kept.
  handle('branchClose:hideTill', async (_e, payload) => {
    const { device_id } = assertPayload<{ device_id: string }>({ device_id: { t: 'string', min: 1 } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) return { ok: false, error: 'Only the branch server hides a POS.' };
    if (!mayCloseBranch()) return { ok: false, error: 'Only someone who may close the branch can hide a POS.' };
    if (!hideTill(device_id)) return { ok: false, error: 'That POS cannot be hidden here.' };
    logLine('branchClose', `A521 till ${device_id} hidden from Close Branch by a manager (until it next reports)`);
    return { ok: true };
  });
  // A465: withdraw one the till has not answered yet.
  handle('branchClose:cancelShiftMoney', async (_e, payload) => {
    const { instruction_id } = assertPayload<{ instruction_id: number }>({ instruction_id: { t: 'number' } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role) || !signedInConfirmer()) return { ok: false, error: 'Only a manager on the branch server can do this.' };
    const removed = cancelShiftMoneyInstruction(instruction_id);
    if (removed) logLine('branchClose', `A465 instruction ${instruction_id} withdrawn`);
    return removed ? { ok: true } : { ok: false, error: 'The POS has already answered — it cannot be withdrawn now.' };
  });
  // A452: Close Branch — every till's day, once no drawer is open and no shift waits for a manager (owner: "when all
  // shifts are closed and confirmed they get a close branch"). No second count: each till closes with its confirmed
  // shifts' cash. The server's date is final — a till still on yesterday closes that day too.
  handle('branchClose:closeBranch', async (_e, payload) => {
    const { notes, totals_confirmed, without_tills } = assertPayload<{ notes?: string; totals_confirmed?: boolean; without_tills?: string[] }>(
      { notes: { t: 'string', optional: true }, totals_confirmed: { t: 'boolean', optional: true }, without_tills: { t: 'stringArray', optional: true } }, payload ?? {});
    try {
      if (!mayCloseBranch()) return { ok: false, error: CLOSE_REFUSED };   // A520: shifts.close_branch
      const ov = branchCloseOverview();
      // A520: one rule with the screen (branchClose.assessBranchClose). A till not heard from no longer holds the close
      // unless its last report shows money a person must deal with (a drawer open, a shift to confirm) — the KRUNCH
      // deadlock: switched-on tills locked on an old day were "not heard from" and nothing could close.
      // A521 (#1, owner 2026-10-17: "where money is involved a manager may go ahead with a clear warning naming whose cash
      // is not in tonight's totals"): another till's money no longer stops everything — the manager ticks its warning
      // (without_tills) and the branch closes without it: this terminal's own day and every other till close, and that
      // till is left a close that waits for its money (it answers "not yet" until the drawer is closed and confirmed).
      // This terminal's own money is never gone past. Nothing of another till's ever stops the server's own close.
      const { held, without } = ov.close;
      const ticked = new Set((without_tills ?? []).filter((id) => without.some((w) => w.device_id === id)));
      const blockers = unresolvedBlockers(ov.close, ticked);
      if (blockers.length) return { ok: false, error: `The branch cannot close yet: ${blockers.join('; ')}.`, blockers,
        ...(without.some((w) => !ticked.has(w.device_id)) ? { code: 'TILLS_WITH_MONEY', without: without.filter((w) => !ticked.has(w.device_id)) } : {}) };
      const heldBy = new Map(held.map((h) => [h.device_id, h]));
      // A458: then the manager confirms the day's totals per payment method (the confirmed shifts added up).
      if (totals_confirmed !== true) return { ok: false, error: 'Check the day\'s totals by payment method and tick that they are right before closing the branch.', code: 'TOTALS_NOT_CONFIRMED' };
      const staff = getLocalDb().prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as any;
      const base = { business_date: businessDateNow(), counted_cash: null, notes, closed_by_staff_id: staff?.staff_id ?? null, closed_by_name: staff?.staff_name ?? null };
      const results: Array<{ device_id: string; ok: boolean; sent?: boolean; held?: boolean; without?: boolean; skipped?: boolean; error?: string }> = [];
      // This terminal's own day first — whatever any other till's close does after it.
      for (const t of ov.tills.filter((x) => x.is_self)) {
        if (!(t.state as PeerDayState | null)?.day_open) continue;
        const r = executeCloseDay(base);
        results.push({ device_id: t.device_id, ok: r.ok, error: r.error });
      }
      for (const t of ov.tills.filter((x) => !x.is_self)) {
        const st = t.state as PeerDayState | null;
        const h = heldBy.get(t.device_id);
        if (ticked.has(t.device_id)) {
          // A521: closed WITHOUT it — a close that waits for its money (an older build is sent nothing: no `shifts`).
          if (st?.shifts) createCloseInstruction(t.device_id, { ...base, wait_for_till: true }, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, without: true, sent: !!st?.shifts, held: true });
          continue;
        }
        if (h && h.close === false) { results.push({ device_id: t.device_id, ok: true, held: true, skipped: true }); continue; }
        if (!st?.day_open) continue;
        if (h) {
          // A520: not connected — a close that waits for it (no 24-h expiry); it closes its open day(s) when it next polls.
          createCloseInstruction(t.device_id, { ...base, wait_for_till: true }, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, sent: true, held: true });
        } else {
          createCloseInstruction(t.device_id, base, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, sent: true });
        }
      }
      const dayTotals = ov.totals.methods.map((l) => `${l.method} ${l.confirmed}`).join(', ');   // A458
      logLine('branchClose', `A452 branch close by ${staff?.staff_name ?? 'a manager'} (totals confirmed: ${dayTotals || 'none'}): ${results.map((r) => `${r.device_id.slice(0, 8)}=${r.ok ? (r.without ? 'closed WITHOUT it (money waits there)' : r.skipped ? 'not sent (older build / never reported)' : r.held ? 'held for when it connects' : r.sent ? 'sent' : 'closed') : 'refused'}`).join(', ') || 'nothing open'}`);
      for (const w of without.filter((x) => ticked.has(x.device_id))) logLine('branchClose', `A521 manager ${staff?.staff_name ?? '?'} went past: ${w.warning}`);
      return { ok: results.every((r) => r.ok), results };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not close the branch' };
    }
  });
  // A490: the day's figures — reports.sales, or someone who closes the day.
  handle('day:summary', async () => {
    requireKey(['reports.sales', 'shifts.close_day'], 'Your role does not see the day’s figures.');
    return getDayCloseSummary();
  });
  // The channel keeps its name (older screens ask it); it answers "may close the day" (shifts.close_day) — A490.
  handle('day:isManager', async () => mayCloseDay());
  handle('day:conflicts', async () => getConflictedShifts());
  handle('day:retryConflict', async (_e, { shiftId }: { shiftId: string }) => {
    if (!mayCloseDay()) return { ok: false, error: 'Only someone who may close the day can retry this.' };   // A490
    try {
      const r = retryConflictedShift(String(shiftId));
      // Offer it now rather than on the next timer tick: the manager is standing
      // at the screen and the whole point of the button is to watch it clear.
      syncPush().catch(() => { /* the re-arm alone is the guarantee */ });
      return { ok: true, rearmed: r.rearmed };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not retry this shift' };
    }
  });
  handle('day:close', async (_e, { countedCash, notes }: { countedCash: number; notes?: string }) => {
    try { return { ok: true, summary: closeDay(Number(countedCash), notes) }; }
    catch (err: any) { return { ok: false, error: err?.message ?? 'Could not close the day' }; }
  });
}
