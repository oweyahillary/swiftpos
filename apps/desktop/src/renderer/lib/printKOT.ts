/**
 * printKOT — desktop port of the dashboard's Kitchen Order Ticket printer.
 *
 * A KOT goes to the kitchen when items are sent. It shows the order/table
 * number large, the items routed to that station, and NO prices/VAT/payment.
 *
 * Adapted for the desktop: the dashboard routes across a branch_printers
 * table (per-category kitchen/bar/expeditor stations); the desktop till has
 * no such table yet, so this version prints ONE kitchen ticket — natively
 * and silently via the main process to PrinterSettings.kitchenPrinterName
 * (no QZ Tray needed), or the print-dialog fallback when none is set. The
 * dashboard's category routing slots back in once branch printers sync down.
 */

import type { CartItem } from './cart';
import type { PrinterSettings } from '../hooks/usePrinterSettings';
import { posApi } from './posApi';
import { browserPrint, buildThermalDocument } from './printReceipt';

export interface KOTContext {
  orderNumber: string;
  tableNumber?: string;
  orderType:   string;   // 'dine_in' | 'takeaway' | 'retail'
  staffName?:  string;
  notes?:      string;
}

// ─── KOT HTML builder (same layout as the dashboard) ─────────────────────────

export function buildKOTHtml(items: CartItem[], ctx: KOTContext, paperWidth: 58 | 80): string {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' });

  let html = `<div style="font-family:'Courier New',monospace;font-size:${paperWidth === 58 ? '11px' : '13px'};line-height:1.6;color:#000;">`;

  html += `<div style="text-align:center;margin-bottom:6px;">`;
  html += `<p style="font-size:${paperWidth === 58 ? '18px' : '22px'};font-weight:bold;letter-spacing:2px;">KITCHEN</p>`;
  html += `</div>`;
  html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;

  html += `<div style="margin-bottom:6px;">`;
  html += `<div style="display:flex;justify-content:space-between;font-size:${paperWidth === 58 ? '14px' : '17px'};font-weight:bold;">`;
  html += `<span>ORDER</span><span>${ctx.orderNumber}</span>`;
  html += `</div>`;
  if (ctx.tableNumber) {
    html += `<div style="display:flex;justify-content:space-between;font-size:${paperWidth === 58 ? '13px' : '16px'};font-weight:bold;">`;
    html += `<span>TABLE</span><span>${ctx.tableNumber}</span>`;
    html += `</div>`;
  }
  const typeDisplay = ctx.orderType === 'dine_in' ? 'DINE IN' : ctx.orderType === 'takeaway' ? 'TAKEAWAY' : 'RETAIL';
  html += `<p style="font-size:11px;margin-top:2px;">${typeDisplay} · ${dateStr} ${timeStr}</p>`;
  if (ctx.staffName) html += `<p style="font-size:10px;color:#444;">Cashier: ${ctx.staffName}</p>`;
  html += `</div>`;
  html += `<p style="border-top:2px solid #000;margin:4px 0;"/>`;

  html += `<div style="margin:6px 0;">`;
  for (const item of items) {
    html += `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">`;
    html += `<span style="font-size:${paperWidth === 58 ? '13px' : '15px'};font-weight:bold;flex:1;padding-right:8px;">${item.product.name}</span>`;
    html += `<span style="font-size:${paperWidth === 58 ? '16px' : '20px'};font-weight:bold;">x${item.quantity}</span>`;
    html += `</div>`;
    for (const v of item.selectedVariants) {
      html += `<p style="font-size:11px;padding-left:10px;color:#333;">↳ ${v.groupName}: ${v.optionName}</p>`;
    }
    for (const m of item.selectedModifiers) {
      html += `<p style="font-size:11px;padding-left:10px;color:#333;">+ ${m.optionName}</p>`;
    }
  }
  html += `</div>`;
  html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;

  if (ctx.notes) {
    html += `<p style="font-size:11px;font-weight:bold;">NOTE: ${ctx.notes}</p>`;
    html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;
  }

  html += `<p style="font-size:10px;color:#666;text-align:center;">Printed ${timeStr}</p>`;
  html += `</div>`;
  return html;
}

// ─── Print ────────────────────────────────────────────────────────────────────

export async function printKOT(
  items: CartItem[],
  ctx: KOTContext,
  settings: PrinterSettings,
): Promise<void> {
  if (!settings.kitchenEnabled || items.length === 0) return;

  const html = buildKOTHtml(items, ctx, settings.paperWidth);

  // Native silent print to the configured kitchen printer — no QZ needed.
  if (settings.kitchenPrinterName) {
    try {
      const res = await posApi.print.html({
        html: buildThermalDocument(html, settings, `KOT ${ctx.orderNumber}`, 1),
        deviceName: settings.kitchenPrinterName,
        paperWidthMm: settings.paperWidth,
        copies: 1,            // KOTs always 1 copy
      });
      if (res.ok) return;
      console.warn('[printKOT] Native print failed, falling back to dialog:', res.error);
    } catch (err: any) {
      console.warn('[printKOT] Native print error, falling back to dialog:', err?.message);
    }
  }

  browserPrint(html, settings, `KOT ${ctx.orderNumber}`, 1);
}
