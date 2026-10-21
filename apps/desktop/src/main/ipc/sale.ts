// IPC: a sale (order:create) and its tickets — kitchen exclusions, production tickets, reprints.
// Registered from ipcHandlers.ts (D10).
import { cleanOffer, type Offer } from '../offers';   // A445
import { kitchenExclusions, kitchenExclusionsState, setKitchenExclusions, clearKitchenExclusionsOverride } from '../escposBridge';
import { expectStringArray } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { applyOffers } from '../offers';   // A494: the offer discount a sale claims, re-checked on the till's own offers
import { syncPush, createLocalOrder } from '../syncEngine';
import { tillBranchId } from '../deviceConfig';   // A446
import { signedIn as sessionPerson, signedInCan, personCan } from '../tillAccess';
import { historyScope } from '../shiftService';
import { markKitchenPaid } from '../kitchenService';
import { sellRefusal, isOpenBill } from '../sellGate';
import { receiptPayloadFromDetail } from '../orderDetail';
import { openBills, type IpcShared } from './shared';
import { prepareCreditSale, pullCreditCustomers } from '../creditSale';   // A552

/** A sale and its tickets: kitchen exclusions, reprints and order:create. */
export function registerSaleHandlers(ctx: IpcShared) {
  const { handle, queueThermal, STATIONS_REFUSED, readOrderDetail } = ctx;

  // ── Orders ──────────────────────────────────────────────

  /**
   * Queue thermal tickets for an order payload.
   *
   * Shared by order:create (the receipt, at payment) and escpos:printProduction
   * (the kitchen and dispatch tickets, when the order is SENT). Splitting the
   * two moments is the point: queuing all three together meant the kitchen only
   * saw an order after the customer had paid for it, so nothing was cooking
   * while they settled the bill.
   *
   * NEVER THROWS. It runs after the money is taken and the order is committed;
   * a printer problem must not turn a completed sale into an error on screen.
   */
  /** A456: how many receipts this sale prints (the till's Copies setting, carried on the sale): 1 or 2. */
  function receiptCopies(payload: any): 1 | 2 {
    return Number(payload?.receipt_copies) === 2 ? 2 : 1;
  }

  /**
   * Kitchen and dispatch tickets, at the moment the order is sent.
   *
   * Called from Send to kitchen, before any money is taken. The renderer sets
   * kot_sent on the payload it later passes to order:create so the same tickets
   * are not produced twice.
   */
  /**
   * The exclusion list this terminal's printer applies, and where it came from.
   *
   * `terms` is the EFFECTIVE list (override if set, else the synced cloud
   * baseline); `source` says which; `cloudTerms` carries the baseline so the
   * setup screen can show "the dashboard says X" while a local override is in
   * force. `terms` is kept as the first field so the older PrintersTab caller,
   * which destructured `{ terms }`, keeps working unchanged.
   *
   * "Local is final" lives one layer down, in escposBridge: the printer path
   * calls kitchenExclusions() directly, which already resolves the override.
   */
  handle('escpos:kitchenExclusions', () => {
    try { return kitchenExclusionsState(); }
    catch { return { terms: [] as string[], source: 'cloud' as const, cloudTerms: [] as string[] }; }
  });
  handle('escpos:setKitchenExclusions', (_e, terms: unknown) => {
    if (!signedInCan('stations.manage')) return { ok: false, error: STATIONS_REFUSED, terms: kitchenExclusions() };
    // D7 reference adoption: validate at the boundary. A malformed payload is a
    // clean rejection, not a silent coerce-to-empty that would wipe the list.
    const v = expectStringArray(terms, 'terms');
    if (!v.ok) return { ok: false, error: v.error, terms: kitchenExclusions() };
    try {
      const saved = setKitchenExclusions(v.value);
      return { ok: true, terms: saved };
    } catch {
      return { ok: false, error: 'write failed', terms: kitchenExclusions() };
    }
  });

  /**
   * Drop the local override and follow the cloud baseline again. Returns the
   * baseline that is now in force so the screen can repaint without a round trip.
   */
  handle('escpos:clearKitchenExclusions', () => {
    if (!signedInCan('stations.manage')) return { ok: false, error: STATIONS_REFUSED, terms: kitchenExclusions() };
    try { return { ok: true, terms: clearKitchenExclusionsOverride() }; }
    catch { return { ok: false, error: 'write failed', terms: kitchenExclusions() }; }
  });

  handle('escpos:printProduction', (_e, payload: any) => {
    // `skipped` reaches the renderer so the cashier is told which station
    // produced nothing. Previously this returned a bare { ok: true } and the
    // information was discarded here — D8.
    const { skipped, failed } = queueThermal(payload, ['kitchen', 'dispatch']);
    // A349: a ticket that could not be produced is named alongside the stations with no printer.
    return { ok: true, skipped: [...skipped, ...failed.map((f) => `${f} (could not be produced)`)] };
  });

  /**
   * The last order this terminal rang, kept so the receipt can be reprinted.
   *
   * In memory only, and only the payload needed to render a receipt. A restart
   * clears it, which is correct — reprinting yesterday's last sale from a
   * screen that says "Payment successful" would be worse than not offering it.
   */
  let lastOrderPayload: any = null;
  let reprintCount = 0;
  /** A490: who rang it — "print my receipt now" stays the cashier's own; anyone else's last sale is a reprint. */
  let lastOrderBy: string | null = null;

  handle('escpos:reprintReceipt', () => {
    if (!lastOrderPayload) return { ok: false, error: 'nothing to reprint' };
    // A490: sales.reprint — unless it is the sale the person signed in just completed.
    const me = sessionPerson();
    if (!me || (me.staffId !== lastOrderBy && !personCan(me, 'sales.reprint'))) return { ok: false, error: 'Reprinting a receipt needs the reprint permission.' };
    reprintCount += 1;
    // Marked as a duplicate on the paper itself. An unmarked second copy of a
    // receipt is the thing an auditor cannot tell from a second sale.
    const r = queueThermal(lastOrderPayload, ['receipt'], { at: new Date(), count: reprintCount });
    if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
    return { ok: true };
  });

  // Reprint any recent order from Order History (A94). Replays the stored payload
  // through the same path as the original — byte-identical, marked "Duplicate
  // Print". Only orders created on THIS terminal (after the feature shipped) have
  // a stored payload; anything else reports honestly rather than printing wrong.
  handle('escpos:reprintReceiptForOrder', async (_e, orderId: string) => {
    // 0.6.27: History's Reprint is for managers when the client has 'cashier_no_reprint' on — refused here too.
    const scope = historyScope();
    if (!scope.canReprint) return { ok: false, error: 'Reprinting is for managers on this till.' };
    const NOT_YOURS = 'This sale is not yours.';
    const row = getLocalDb()
      .prepare('SELECT payload FROM receipt_payloads WHERE order_id = ?')
      .get(orderId) as { payload?: string } | undefined;
    // A444: no stored receipt (another till's sale, the web's, or older than the last 200) — rebuilt from the order
    // itself: this till's records, else the cloud's.
    let payload: any = null;
    if (row?.payload) {
      // A494: a person who sees only their own sales in History (ownOnly) reprints only their own — as order:detail.
      if (scope.ownOnly) {
        const o = getLocalDb().prepare(`SELECT cashier_id FROM orders WHERE id = ?`).get(String(orderId)) as { cashier_id?: string | null } | undefined;
        if (!scope.staffId || (o?.cashier_id ?? null) !== scope.staffId) return { ok: false, error: NOT_YOURS };
      }
      try { payload = JSON.parse(row.payload); } catch { return { ok: false, error: 'Could not rebuild this receipt.' }; }
    } else {
      const found = await readOrderDetail(String(orderId)).catch((e: any) => ({ error: e?.message ?? String(e) }));
      if ('error' in found) return { ok: false, error: found.error };
      if (scope.ownOnly && (!scope.staffId || found.cashierId !== scope.staffId)) return { ok: false, error: NOT_YOURS };   // A494
      payload = receiptPayloadFromDetail(found.detail);
    }
    try {
      const r = queueThermal(payload, ['receipt'], { at: new Date(), count: 1 });
      if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not rebuild this receipt.' };
    }
  });

  /** A494: what this till's offers (pulled with the menu) take off a sale's lines — timing not re-checked (the cart's clock
   *  decided it, as the cloud's check of a sale does), so a sale rung on the minute an offer ended is never refused. */
  function tillOfferDiscount(orderPayload: any): { total: number; applied: Array<{ offer_id: string; name: string; amount: number }> } {
    const none = { total: 0, applied: [] };
    try {
      const rows = getLocalDb().prepare(`SELECT data FROM offers`).all() as Array<{ data: string }>;
      const offers = rows.flatMap((r) => { try { const c = cleanOffer(JSON.parse(r.data)); return c.ok ? [(c as { offer: Offer }).offer] : []; } catch { return []; } });
      if (!offers.length) return none;
      const items: any[] = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
      const lines = items.map((i, n) => {
        const q = Number(i?.quantity) || 0;
        return { key: String(n), product_id: i?.product?.id ?? null, category_id: i?.product?.category_id ?? i?.product?.categories?.id ?? null,
          unit_price: q > 0 ? (Number(i?.lineTotal) || 0) / q : 0, quantity: q };
      });
      const r = applyOffers(lines, offers, { ignoreTiming: true, branchId: tillBranchId() });
      return { total: r.total, applied: r.applied };
    } catch { return none; }
  }

  handle('order:create', async (_event, orderPayload: any) => {
    // A519: paying a bill already open is never refused (finish what was started); a sale nobody opened needs "Sell".
    const refusedSale = sellRefusal('pay', sessionPerson(), isOpenBill(getLocalDb(), orderPayload?.order_number, openBills));
    if (refusedSale) { logLine('sale', `A519: refused a sale — ${sessionPerson()?.staffId ?? 'nobody'} has no Sell on this till`); throw new Error(refusedSale); }
    // A490: a discount given by hand needs sales.discount — the till is the authority here (offline too; the cloud never
    // refuses a till's sale for it). What offers took off is not the person's discount. Nothing else about selling asks.
    // A494: what the offers took is re-checked on THIS till's offers (the same engine the cart and the cloud use) — the
    // screen's figure is not trusted: a claimed offer discount above what the till's offers give is a hand discount.
    const claimed = Math.max(0, Number(orderPayload?.offer_discount) || 0);
    let offerOff = claimed;
    if (claimed > 0) {
      const till = tillOfferDiscount(orderPayload);
      if (claimed > till.total + 0.01) {
        logLine('sale', `A494: the screen claimed ${claimed} off for offers; this till's offers give ${till.total}`);
        offerOff = till.total;
        // The sale records what the till's offers gave, and which (the excess is part of the hand discount).
        if (till.total > 0) { orderPayload.offer_discount = till.total; orderPayload.offers = till.applied; }
        else { delete orderPayload.offer_discount; delete orderPayload.offers; }
      }
    }
    const manual = (Number(orderPayload?.discount_amount) || 0) - offerOff;
    if (manual > 0.004 && !signedInCan('sales.discount')) throw new Error('Your role does not give discounts. Remove the discount, or ask someone who may.');
    // A552: a sale on account — the customer (this till's list), the limit and the approver (A511) checked HERE; the
    // screen's credit fields are dropped and the PIN never leaves this process. No leg on account: nothing changes.
    const me = sessionPerson();
    const credit = await prepareCreditSale(orderPayload, {
      asker: me ? { id: me.staffId, name: me.name, roleName: me.roleName, permissions: me.permissions } : null,
    });
    const askedNumber = orderPayload?.order_number ?? null;   // A503 (E1): A500 may renumber the sale
    const orderId = createLocalOrder(orderPayload);
    markKitchenPaid(orderPayload?.order_number);   // 0.6.28: its sent lines are paid for
    if (askedNumber && askedNumber !== orderPayload?.order_number) markKitchenPaid(askedNumber);
    // A299: event summary — id, total, method, item count. No line-item detail
    // or customer data (the DB + cloud are the record; this is the trail).
    logLine('sale', `created ${orderId} ${orderPayload?.total ?? '?'} `
      + `${orderPayload?.payments?.[0]?.method ?? orderPayload?.payment_method ?? ''} `
      + `x${orderPayload?.items?.length ?? 0}`.replace(/\s+/g, ' ').trim());
    lastOrderPayload = orderPayload;
    lastOrderBy = sessionPerson()?.staffId ?? null;   // A490
    reprintCount = 0;
    // Push-only flush — the old syncAll here re-pulled the entire catalogue
    // (N+1 variant/modifier fetches) on every single sale.
    syncPush().catch(console.error);
    // A552: after a sale on account, the customer's balance is read again once the sale has gone up (best-effort).
    if (credit) setTimeout(() => { void pullCreditCustomers().catch(() => false); }, 15_000).unref?.();

    // AFTER the order is committed and AFTER the sync flush is scheduled, and
    // never awaited. The spool owns delivery; the sale does not wait on a
    // printer and cannot fail because of one.
    //
    // A restaurant order that already went to the kitchen gets ONLY the receipt
    // here — its production tickets were queued when it was sent, which is the
    // whole reason the split exists. A counter sale has no send step, so it
    // gets everything at once, which is correct there.
    const printed = queueThermal(
      orderPayload,
      orderPayload?.kot_sent ? ['receipt'] : ['kitchen', 'dispatch', 'receipt'],
    );
    // A456 (owner, 2026-10-12: "if i want to be printing 2 copies of a receipt that feature does not exist in the desktop
    // till"): the till's Copies setting reached only the Windows-printer route; a thermal receipt printed once. The
    // second copy (the merchant's) is queued after the first — the receipt only, never a second kitchen ticket.
    if (receiptCopies(orderPayload) === 2) {
      const second = queueThermal(orderPayload, ['receipt']);
      printed.failed.push(...second.failed.filter((x) => !printed.failed.includes(x)));
    }

    // A349: a ticket that could not be produced reaches the sale screen (a missing printer is not a failure — that is
    // "skipped", and a till with no receipt printer would otherwise be nagged on every sale).
    return { orderId, orderNumber: orderPayload?.order_number ?? null, printFailed: printed.failed };
  });
}
