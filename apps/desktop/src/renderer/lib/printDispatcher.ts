/**
 * printDispatcher — the packing ticket.
 *
 * Modelled on the incumbent system's "MASTER KOT": every line on the order,
 * combos expanded into components, quantities prominent, and NO prices. The
 * packer works from this to assemble the bag, so it lists drinks and sauces
 * that never go near the kitchen.
 *
 * Prices are deliberately absent. This sheet goes into the bag and gets handled
 * by whoever is packing; the priced document is the customer receipt.
 */

import type { PrinterSettings } from '../hooks/usePrinterSettings';
import type { TicketLine } from './ticketLines';
import { totalQty } from './ticketLines';
import { posApi } from './posApi';
import { browserPrint, buildThermalDocument } from './printReceipt';

export interface DispatcherContext {
  orderNumber: string;
  billNumber?: string;
  stationName?: string;
  orderType: string;          // 'dine_in' | 'takeaway' | 'retail'
  tableNumber?: string;
  staffName?: string;
  deliveryPerson?: string;
  notes?: string;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export function buildDispatcherHtml(
  lines: TicketLine[],
  ctx: DispatcherContext,
  paperWidth: 58 | 80,
  heading = 'DISPATCH',
): string {
  const now = new Date();
  const stamp = `${now.toLocaleDateString('en-KE')} ${now.toLocaleTimeString('en-KE', { hour12: false })}`;
  const base = paperWidth === 58 ? 11 : 13;
  const rule = (style: string) => `<p style="border-top:${style};margin:4px 0;"></p>`;

  const typeDisplay =
    ctx.orderType === 'dine_in' ? 'DINE IN'
      : ctx.orderType === 'takeaway' ? 'TAKEAWAY'
      : ctx.orderType === 'delivery' ? 'DELIVERY'
      : 'COUNTER';

  let html = `<div style="font-family:'Courier New',monospace;font-size:${base}px;line-height:1.55;color:#000;">`;

  if (ctx.stationName) {
    html += `<p style="font-size:${base - 1}px;">Station: ${esc(ctx.stationName)}</p>`;
  }
  html += `<p style="text-align:center;font-size:${base + 4}px;font-weight:bold;letter-spacing:2px;">&laquo; ${esc(heading)} &raquo;</p>`;
  html += rule('1px dashed #000');

  const meta = (l: string, v: string) =>
    `<div style="display:flex;justify-content:space-between;"><span>${esc(l)}</span><span>${esc(v)}</span></div>`;

  html += meta('Type:', typeDisplay);
  if (ctx.tableNumber) html += meta('Table:', ctx.tableNumber);
  // Packers need to know a bag is going out rather than over the counter.
  if (ctx.orderType === 'delivery') html += meta('Delivery Boy:', ctx.deliveryPerson || '—');
  if (ctx.billNumber) html += meta('Bill No:', ctx.billNumber);
  html += meta('Order:', ctx.orderNumber);
  if (ctx.staffName) html += meta('Cashier:', ctx.staffName);
  html += meta('Date:', stamp);
  html += rule('1px dashed #000');

  html += `<div style="display:flex;font-weight:bold;font-size:${base}px;">`;
  html += `<span style="width:44px;">Qty</span><span>Item</span></div>`;
  html += rule('1px solid #000');

  for (const line of lines) {
    html += `<div style="display:flex;align-items:baseline;margin-top:5px;">`;
    html += `<span style="width:44px;font-size:${base + 3}px;font-weight:bold;">${line.quantity}</span>`;
    html += `<span style="font-size:${base + 1}px;font-weight:bold;flex:1;">${esc(line.name)}`;
    // Spice and any modifiers ride on the parent line — one all-or-nothing
    // choice, stated once, rather than stamped onto components that may not
    // even come in that form.
    if (line.qualifier) html += ` <span style="font-weight:normal;">(${esc(line.qualifier)})</span>`;
    html += `</span></div>`;

    if (line.components.length) {
      html += `<div style="padding-left:44px;font-size:${base - 1}px;">`;
      for (const c of line.components) {
        // "3: Chicken Burger" — quantity PER combo, not multiplied by the combo
        // count. Matches the incumbent ticket the staff already read.
        html += `<div>${c.quantity}: ${esc(c.name)}</div>`;
      }
      html += `</div>`;
    }
  }

  html += rule('1px solid #000');
  html += `<div style="display:flex;justify-content:space-between;font-weight:bold;">`;
  html += `<span>Total Qty:</span><span>${totalQty(lines)}</span></div>`;

  if (ctx.notes) {
    html += rule('1px dashed #000');
    html += `<p style="font-weight:bold;font-size:${base}px;">NOTE: ${esc(ctx.notes)}</p>`;
  }

  html += `</div>`;
  return html;
}

export async function printDispatcher(
  lines: TicketLine[],
  ctx: DispatcherContext,
  settings: PrinterSettings,
  heading = 'DISPATCH',
): Promise<void> {
  // No printer configured means the feature is simply off — same convention as
  // the kitchen ticket. A site without a packing station never sees it, and
  // nothing has to be conditionally compiled out.
  if (lines.length === 0) return;

  const html = buildDispatcherHtml(lines, ctx, settings.paperWidth, heading);
  const title = `${heading} ${ctx.orderNumber}`;

  if (settings.dispatcherPrinterName) {
    try {
      const res = await posApi.print.html({
        html: buildThermalDocument(html, settings, title, 1),
        deviceName: settings.dispatcherPrinterName,
        paperWidthMm: settings.paperWidth,
        copies: 1,
      });
      if (res.ok) return;
      console.warn('[printDispatcher] Native print failed, falling back to dialog:', res.error);
    } catch (err: any) {
      console.warn('[printDispatcher] Native print error, falling back to dialog:', err?.message);
    }
    browserPrint(html, settings, title, 1);
  }
  // Silent no-op when unconfigured — deliberately NOT falling back to a dialog,
  // which would throw a print window at a cashier who never asked for one.
}
