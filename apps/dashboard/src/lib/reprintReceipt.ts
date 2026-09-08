/**
 * reprintReceipt — reprint an existing order's customer receipt as a DUPLICATE,
 * using the SAME renderer that printed it at the till (renderReceiptEscPos). Not a
 * new design — it re-renders the stored order (GET /api/orders/:id) with the
 * shared `reprint` marker so the ticket carries a "Duplicate Print" header + a
 * RePrint timestamp, then sends the bytes to the branch receipt printer via the
 * bridge. Prints only where the bridge is connected (i.e. on the till). (A261)
 */
import { renderReceiptEscPos } from './escposRenderer';
import { buildReceiptBusinessConfig } from './buildReceiptOrder';
import { getQZStatus, printBytesToServer } from './localPrintServer';
import { api } from './api';
import type { BranchPrinter } from './printKOT';

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);

/** Map the stored order (GET /api/orders/:id) into the ReceiptOrder shape. */
function toReceiptOrder(o: any) {
  const lines = (o.order_items ?? []).map((it: any) => {
    const attrs = (it.order_item_variants ?? []).map((v: any) => ({
      group: v.group_name ?? '', option: v.option_name ?? v.name ?? '',
      count: 1, priceDelta: cents(v.price_adjustment ?? 0),
    }));
    const units: any[] = [];
    if (attrs.length) units.push({
      productId: it.product_name, name: it.product_name, quantity: 1, portions: 1,
      priceDelta: 0, chosen: true, attributes: attrs, stationIds: [],
    });
    for (const m of it.order_item_modifiers ?? []) units.push({
      productId: m.name, name: m.name, quantity: 1, portions: 1,
      priceDelta: cents(m.price ?? 0), chosen: true, attributes: [], stationIds: [],
    });
    return {
      name: it.product_name, quantity: Number(it.quantity) || 1,
      unitPrice: cents(it.unit_price), lineTotal: cents(it.subtotal),
      stationIds: [], units,
    };
  });
  return {
    billNumber:  o.order_number,
    orderType:   o.order_type ?? 'counter',
    cashierName: o.cashier_name ?? 'Reprint',
    soldAt:      o.created_at,
    tableNumber: o.table_number ?? undefined,
    lines,
    payments:    (o.payments ?? []).map((p: any) => ({ label: p.method, amount: cents(p.amount) })),
    changeGiven: cents(o.change_given ?? o.change ?? 0),
    total:       cents(o.total),
    kotCount:    0,
  };
}

export async function reprintOrderReceipt(orderId: string): Promise<{ ok: boolean; message: string }> {
  if (getQZStatus() !== 'connected') {
    return { ok: false, message: 'Print server not connected on this device — open the till to reprint.' };
  }

  let order: any;
  try { order = await api.get<any>(`/api/orders/${orderId}`); }
  catch (e: any) { return { ok: false, message: e?.message ?? 'Could not load the order.' }; }

  const [business, settings, printers] = await Promise.all([
    api.get<any>('/api/business').catch(() => ({ name: 'Receipt' })),
    api.get<{ key: string; value: string }[]>('/api/business/settings').catch(() => [] as { key: string; value: string }[]),
    api.get<BranchPrinter[]>(`/api/printers?branch_id=${order.branch_id}`).catch(() => [] as BranchPrinter[]),
  ]);

  const receipt = (printers ?? []).find(p => p.enabled && !!p.printer_name && (p.is_default_receipt || p.type === 'receipt'));
  if (!receipt) return { ok: false, message: 'No receipt printer is configured for this branch.' };

  const map: Record<string, string> = {};
  for (const s of settings ?? []) map[s.key] = s.value;
  const biz = buildReceiptBusinessConfig(business, undefined, 0, {
    branchName: order.branch_name ?? undefined,
    header:     map['receipt_header'] || undefined,
    footerText: map['receipt_footer'] || undefined,
  });

  try {
    const bytes = renderReceiptEscPos(toReceiptOrder(order), biz as any, receipt.paper_width, { at: new Date(), count: 1 });
    await printBytesToServer(`printer:${receipt.printer_name}`, bytes);
    return { ok: true, message: `Duplicate receipt sent to ${receipt.printer_name}.` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Reprint failed.' };
  }
}
