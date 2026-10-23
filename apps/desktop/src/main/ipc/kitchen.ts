// IPC: 0.6.28 sends to the kitchen and kitchen voids (kitchenService.ts). Registered from ipcHandlers.ts (D10).
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { getOpenShift } from '../syncEngine';
import { signedIn as sessionPerson } from '../tillAccess';
import { getPosFeatures } from '../deviceConfig';
import { recordKitchenSend, recordKitchenVoid, openKitchenOrders } from '../kitchenService';
import { voidReasonLabel } from '../kitchenLines';
import { sellRefusal, isOpenBill } from '../sellGate';
import { openBills, type IpcShared } from './shared';

/** 0.6.28: sends to the kitchen, and kitchen voids. */
export function registerKitchenHandlers(ctx: IpcShared) {
  const { handle, queueThermal, pushNow, identifyConfirmer, signedInConfirmer } = ctx;

  // ── 0.6.28: Send to kitchen is recorded; sent items come back only as a recorded kitchen void ────────────────────
  // Owner, 2026-10-01: a sent order cancelled after the customer paid in cash — "the cashier pockets the money". Every
  // sent item ends paid (order:create → markKitchenPaid) or voided here. See kitchenService.ts.
  handle('kitchen:sent', async (_event, payload) => {
    const { order_number, lines, order_type, table_number } = assertPayload<{
      order_number: string; lines: unknown; order_type?: string; table_number?: string;
    }>({ order_number: { t: 'string', min: 1 }, lines: { t: 'any' }, order_type: { t: 'string', optional: true },
         table_number: { t: 'string', optional: true } }, payload);
    const refusedSend = sellRefusal('kitchen', sessionPerson(), isOpenBill(getLocalDb(), order_number, openBills));   // A519
    if (refusedSend) throw new Error(refusedSend);
    return { recorded: recordKitchenSend(order_number, lines, { order_type: order_type ?? null, table_number: table_number ?? null }) };
  });

  /**
   * Take sent items back. With 'kitchen_void_approval' a manager approves: a manager signed in on this till as
   * themselves, or a manager's PIN (node → cloud → this till's saved sign-ins, as shift:confirm). Without the switch the
   * cashier may — it is still recorded, and the kitchen still gets the VOID ticket.
   */
  handle('kitchen:void', async (_event, payload) => {
    const p = assertPayload<{ order_number: string; lines: unknown; reason: string; note?: string; cooked?: boolean;
                              pin?: string; order_type?: string; table_number?: string }>({
      order_number: { t: 'string', min: 1 }, lines: { t: 'any' }, reason: { t: 'string', min: 1 },
      note: { t: 'string', optional: true }, cooked: { t: 'boolean', optional: true }, pin: { t: 'string', optional: true },
      order_type: { t: 'string', optional: true }, table_number: { t: 'string', optional: true },
    }, payload);
    let approver: { id: string; name: string | null } | null = null;
    if (getPosFeatures().kitchen_void_approval) {
      const signedIn = signedInConfirmer();
      if (!signedIn && !String(p.pin ?? '').trim()) throw new Error('A manager must approve this. Enter a manager’s PIN.');
      approver = signedIn && !String(p.pin ?? '').trim() ? signedIn : await identifyConfirmer(String(p.pin));
    }
    const v = recordKitchenVoid(p, approver);
    // The VOID ticket: the same stations the items went to, under a VOID banner, so the kitchen stops cooking them.
    const printed = queueThermal({
      order_number: p.order_number, order_type: p.order_type ?? 'retail', table_number: p.table_number,
      items: v.lines.map((l) => (l.item && typeof l.item === 'object')
        ? { ...(l.item as object), quantity: l.qty, lineTotal: l.unit_price * l.qty }
        : { product: { id: l.product_id, name: l.product_name }, quantity: l.qty, unitPrice: l.unit_price,
            lineTotal: l.unit_price * l.qty, selectedVariants: [], selectedModifiers: [] }),
      kitchen_void: { by: approver?.name ?? '', reason: voidReasonLabel(v.reason) },
    }, ['kitchen', 'dispatch']);
    logLine('sale', `kitchen void #${p.order_number} ${v.lines.map((l) => `${l.qty}x ${l.product_name}`).join(', ')} ` +
      `${v.total} — ${v.reason}${v.cooked ? ' (cooked)' : ''}${approver ? ` approved by ${approver.name ?? approver.id}` : ''}`);
    pushNow();
    return { ok: true, total: v.total, approvedBy: approver?.name ?? null,
             skipped: [...printed.skipped, ...printed.failed.map((f) => `${f} (could not be produced)`)] };
  });

  /** Sent orders not yet paid: `shift` — this shift's (End Shift lists them); `all` — every one (recovery). */
  handle('kitchen:open', async () => {
    const shiftId = getOpenShift()?.id ?? null;
    return { all: openKitchenOrders(), shift: shiftId ? openKitchenOrders(shiftId) : [] };
  });
}
