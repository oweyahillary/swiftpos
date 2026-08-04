/**
 * printKOT — desktop port of the dashboard's Kitchen Order Ticket printer.
 *
 * A KOT goes to the kitchen when items are sent. It shows the order/table
 * number large, the items routed to that station, and NO prices/VAT/payment.
 *
 * Routing is by category: only items whose category has is_kitchen set appear
 * here, so drinks, sauces, cole slaw and bought-in burger bread stay off the
 * fryer station's ticket. Combos are expanded and then filtered the same way —
 * a Kanka Combo prints its burger and tenders but not its Coca-Cola.
 *
 * Prints natively and silently to PrinterSettings.kitchenPrinterName, or falls
 * back to the print dialog when none is set.
 */

import type { TicketLine } from './ticketLines';
import type { PrinterSettings } from '../hooks/usePrinterSettings';
import { posApi } from './posApi';
import { buildThermalDocument, printDocument } from './printReceipt';

export interface KOTContext {
  orderNumber: string;
  tableNumber?: string;
  orderType:   string;   // 'dine_in' | 'takeaway' | 'retail'
  staffName?:  string;
  notes?:      string;
  /**
   * Which station this copy is for — printed in the header.
   *
   * With several stations a branch can have three tickets for one order landing
   * in three places. Without the name on the paper they are indistinguishable,
   * and the first person to pick one up cannot tell whether they are holding the
   * grill's copy or the bar's.
   */
  stationName?: string;
}

// ─── KOT HTML builder (same layout as the dashboard) ─────────────────────────

// Product names and order notes are user-authored — and since the CSV import
// landed, client-authored. Unescaped, a name like "Burger <200g>" swallowed the
// rest of the ticket, so the kitchen simply never saw the items after it.
// printDispatcher has always escaped; this did not.
const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

// A dashed/solid separator. Previously written as a self-closing <p ... />,
// which is not valid HTML — the parser treats it as an UNCLOSED <p>, so every
// rule silently nested the rest of the ticket one level deeper.
const rule = (style: string) => `<p style="border-top:${style};margin:4px 0;"></p>`;


export function buildKOTHtml(items: TicketLine[], ctx: KOTContext, paperWidth: 58 | 80): string {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' });

  let html = `<div style="font-family:'Courier New',monospace;font-size:${paperWidth === 58 ? '11px' : '13px'};line-height:1.6;color:#000;">`;

  html += `<div style="text-align:center;margin-bottom:6px;">`;
  // The station's own name when there is one, so three tickets for one order
  // landing at three stations can be told apart on the paper.
  html += `<p style="font-size:${paperWidth === 58 ? '18px' : '22px'};font-weight:bold;letter-spacing:2px;">${
    ctx.stationName ? esc(ctx.stationName.toUpperCase()) : 'KITCHEN'}</p>`;
  html += `</div>`;
  html += rule('1px dashed #000');

  html += `<div style="margin-bottom:6px;">`;
  html += `<div style="display:flex;justify-content:space-between;font-size:${paperWidth === 58 ? '14px' : '17px'};font-weight:bold;">`;
  html += `<span>ORDER</span><span>${esc(ctx.orderNumber)}</span>`;
  html += `</div>`;
  if (ctx.tableNumber) {
    html += `<div style="display:flex;justify-content:space-between;font-size:${paperWidth === 58 ? '13px' : '16px'};font-weight:bold;">`;
    html += `<span>TABLE</span><span>${esc(ctx.tableNumber)}</span>`;
    html += `</div>`;
  }
  const typeDisplay = ctx.orderType === 'dine_in' ? 'DINE IN'
    : ctx.orderType === 'takeaway' ? 'TAKEAWAY'
    : ctx.orderType === 'delivery' ? 'DELIVERY'
    : 'RETAIL';
  html += `<p style="font-size:11px;margin-top:2px;">${typeDisplay} · ${dateStr} ${timeStr}</p>`;
  if (ctx.staffName) html += `<p style="font-size:10px;color:#444;">Cashier: ${esc(ctx.staffName)}</p>`;
  html += `</div>`;
  html += rule('2px solid #000');

  html += `<div style="margin:6px 0;">`;
  for (const line of items) {
    html += `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">`;
    html += `<span style="font-size:${paperWidth === 58 ? '13px' : '15px'};font-weight:bold;flex:1;padding-right:8px;">${esc(line.name)}</span>`;
    html += `<span style="font-size:${paperWidth === 58 ? '16px' : '20px'};font-weight:bold;">x${line.quantity}</span>`;
    html += `</div>`;
    // Spice/modifiers sit on the parent line — one all-or-nothing choice per
    // combo, so repeating it against each component would be noise at best and
    // wrong at worst for components that don't come spicy.
    if (line.qualifier) {
      html += `<p style="font-size:11px;padding-left:10px;color:#333;">- ${esc(line.qualifier)}</p>`;
    }
    // Prep detail from the product description, ITEMIZED — one line per item,
    // same indented style as combo components below. Flat products only
    // (a combo's ticket already lists exactly what to make). Kitchen ticket
    // only; the packer's ticket stays item names.
    for (const nl of line.noteLines ?? []) {
      html += `<p style="font-size:12px;padding-left:10px;">- ${esc(nl)}</p>`;
    }
    // Already filtered to cooked components by kitchenOnly().
    for (const c of line.components) {
      html += `<p style="font-size:12px;padding-left:10px;">${c.quantity}: ${esc(c.name)}</p>`;
    }
  }
  html += `</div>`;
  html += rule('1px dashed #000');

  if (ctx.notes) {
    html += `<p style="font-size:11px;font-weight:bold;">NOTE: ${esc(ctx.notes)}</p>`;
    html += rule('1px dashed #000');
  }

  html += `<p style="font-size:10px;color:#666;text-align:center;">Printed ${timeStr}</p>`;
  html += `</div>`;
  return html;
}

// ─── Print ────────────────────────────────────────────────────────────────────

export interface PrintOutcome {
  printed: boolean;
  /** Present when nothing was printed. Plain language — it reaches the cashier. */
  reason?: string;
}

export async function printKOT(
  items: TicketLine[],
  ctx: KOTContext,
  settings: PrinterSettings,
): Promise<PrintOutcome> {
  if (!settings.kitchenEnabled) {
    return { printed: false, reason: 'Kitchen printing is switched off in printer settings' };
  }
  if (items.length === 0) {
    // Nothing on this order is cooked. Almost always means no category has the
    // Kitchen box ticked — previously this returned silently and the caller
    // announced "Sent 3 items to kitchen", so the cashier walked away believing
    // an order had been fired that the kitchen never saw.
    return { printed: false, reason: 'Nothing on this order is marked for the kitchen — check the Kitchen box on the category' };
  }

  // No printer bound means the feature is not set up on this till yet — the
  // same convention the dispatcher ticket already uses. It previously fell
  // through to browserPrint(), which threw a print dialog at the cashier; on a
  // freshly installed till that is the DEFAULT state (kitchenEnabled true,
  // kitchenPrinterName ''), so the first Send to kitchen on install day opened
  // a dialog nobody asked for. Report it instead, so the cashier is told to set
  // a printer rather than left dismissing a window mid-service.
  if (!settings.kitchenPrinterName) {
    return { printed: false, reason: 'No kitchen printer set — choose one under 🖨 printer settings' };
  }

  const html = buildKOTHtml(items, ctx, settings.paperWidth);
  const title = `KOT ${ctx.orderNumber}`;
  const doc = buildThermalDocument(html, settings, title, 1);

  // Same dispatch path as the receipt: named printer, then OS default. No
  // on-screen preview — a kitchen ticket shown on the till screen helps nobody
  // in the kitchen, and pretending otherwise is what caused the old code to
  // return { printed: true } after printing nothing at all.
  const res = await printDocument(doc, settings.paperWidth, settings.kitchenPrinterName, title);

  return res.ok
    ? { printed: true }
    : { printed: false, reason: 'Kitchen printer did not respond — the ticket has NOT printed' };
}
