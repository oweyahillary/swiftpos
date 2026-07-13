/**
 * printKOT.ts
 *
 * Kitchen Order Ticket (KOT) formatter and printer router.
 *
 * A KOT is printed to kitchen/bar/expeditor printers when an order is placed.
 * It contains:
 *   - Order number + table number (large, prominent)
 *   - Time printed
 *   - Items routed to this printer (filtered by category)
 *   - No prices, no VAT, no payment info
 *
 * Routing logic:
 *   Each printer has a category_ids filter.
 *   [] = print all items
 *   [id1, id2] = only items whose category_id is in the list
 */

import type { CartItem } from './cart';
import type { PrinterSettings } from '../hooks/usePrinterSettings';
import { printReceipt } from './printReceipt';
import { printToQZ, getQZStatus } from './localPrintServer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BranchPrinter {
  id: string;
  name: string;
  printer_name: string | null;
  type: 'receipt' | 'kitchen' | 'bar' | 'expeditor' | 'kot';
  paper_width: 58 | 80;
  category_ids: string[];      // empty = all items
  is_default_receipt: boolean;
  connection_type: 'qz' | 'browser';
  enabled: boolean;
}

export interface KOTContext {
  orderNumber: string;
  tableNumber?: string;
  orderType:   string;
  staffName?:  string;
  branchName?: string;
  notes?:      string;
}

// ─── KOT HTML builder ─────────────────────────────────────────────────────────

function buildKOTHtml(
  items: CartItem[],
  ctx: KOTContext,
  printer: BranchPrinter,
): string {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' });
  const lineWidth = printer.paper_width === 58 ? 32 : 48;
  const divider   = '-'.repeat(lineWidth);

  const printerTypeLabel: Record<string, string> = {
    kitchen:   'KITCHEN',
    bar:       'BAR',
    expeditor: 'EXPEDITOR',
    kot:       'KOT',
    receipt:   'ORDER',
  };

  const typeLabel = printerTypeLabel[printer.type] ?? 'ORDER';

  let html = `<div style="font-family:'Courier New',monospace;font-size:${printer.paper_width === 58 ? '11px' : '13px'};line-height:1.6;color:#000;">`;

  // ── Header ──
  html += `<div style="text-align:center;margin-bottom:6px;">`;
  html += `<p style="font-size:${printer.paper_width === 58 ? '18px' : '22px'};font-weight:bold;letter-spacing:2px;">${typeLabel}</p>`;
  if (ctx.branchName) {
    html += `<p style="font-size:11px;">${ctx.branchName}</p>`;
  }
  html += `</div>`;

  html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;

  // ── Order info ──
  html += `<div style="margin-bottom:6px;">`;

  // Order number — big
  html += `<div style="display:flex;justify-content:space-between;font-size:${printer.paper_width === 58 ? '14px' : '17px'};font-weight:bold;">`;
  html += `<span>ORDER</span><span>${ctx.orderNumber}</span>`;
  html += `</div>`;

  // Table if dine-in
  if (ctx.tableNumber) {
    html += `<div style="display:flex;justify-content:space-between;font-size:${printer.paper_width === 58 ? '13px' : '16px'};font-weight:bold;">`;
    html += `<span>TABLE</span><span>${ctx.tableNumber}</span>`;
    html += `</div>`;
  }

  // Order type badge
  const typeDisplay = ctx.orderType === 'dine_in' ? 'DINE IN' : ctx.orderType === 'takeaway' ? 'TAKEAWAY' : 'RETAIL';
  html += `<p style="font-size:11px;margin-top:2px;">${typeDisplay} · ${dateStr} ${timeStr}</p>`;

  if (ctx.staffName) {
    html += `<p style="font-size:10px;color:#444;">Cashier: ${ctx.staffName}</p>`;
  }

  html += `</div>`;
  html += `<p style="border-top:2px solid #000;margin:4px 0;"/>`;

  // ── Items ──
  html += `<div style="margin:6px 0;">`;

  for (const item of items) {
    // Item name + quantity — prominent
    html += `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">`;
    html += `<span style="font-size:${printer.paper_width === 58 ? '13px' : '15px'};font-weight:bold;flex:1;padding-right:8px;">${item.product.name}</span>`;
    html += `<span style="font-size:${printer.paper_width === 58 ? '16px' : '20px'};font-weight:bold;">x${item.quantity}</span>`;
    html += `</div>`;

    // Variants
    for (const v of item.selectedVariants) {
      html += `<p style="font-size:11px;padding-left:10px;color:#333;">↳ ${v.groupName}: ${v.optionName}</p>`;
    }

    // Modifiers
    for (const m of item.selectedModifiers) {
      html += `<p style="font-size:11px;padding-left:10px;color:#333;">+ ${m.optionName}</p>`;
    }
  }

  html += `</div>`;
  html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;

  // ── Notes ──
  if (ctx.notes) {
    html += `<p style="font-size:11px;font-weight:bold;">NOTE: ${ctx.notes}</p>`;
    html += `<p style="border-top:1px dashed #000;margin:4px 0;"/>`;
  }

  // ── Footer ──
  html += `<p style="font-size:10px;color:#666;text-align:center;">Printed ${timeStr}</p>`;

  html += `</div>`;
  return html;
}

// ─── Route and print KOTs ─────────────────────────────────────────────────────

/**
 * Called after a successful order to route items to the correct printers.
 *
 * @param cart         Full cart items (with product.category_id)
 * @param ctx          Order context (order number, table, etc.)
 * @param printers     All enabled printers for this branch
 * @param fallbackSettings  Used for browser-mode prints
 */
export async function printKOTs(
  cart: CartItem[],
  ctx: KOTContext,
  printers: BranchPrinter[],
  fallbackSettings: PrinterSettings,
): Promise<void> {
  // Only print to non-receipt printers (receipt is handled separately)
  const kotPrinters = printers.filter(p => p.enabled && p.type !== 'receipt');

  for (const printer of kotPrinters) {
    // Filter items for this printer
    const filteredItems = printer.category_ids.length === 0
      ? cart  // no filter = all items
      : cart.filter(item => printer.category_ids.includes(item.product.category_id ?? ''));

    if (filteredItems.length === 0) continue; // nothing to print for this printer

    const html = buildKOTHtml(filteredItems, ctx, printer);

    try {
      if (printer.connection_type === 'qz' && getQZStatus() === 'connected' && printer.printer_name) {
        // Silent QZ print
        await printToQZ(printer.printer_name, html, {
          paperWidth: printer.paper_width,
          copies:     1, // KOTs always 1 copy
          autoCut:    true,
        });
      } else {
        // Browser print fallback — opens popup per printer
        printReceipt(html, {
          ...fallbackSettings,
          paperWidth: printer.paper_width,
          copies:     1,
          autoCut:    true,
          footerMessage: '',
        }, `KOT — ${printer.name}`);
      }
    } catch (err: any) {
      console.error(`[KOT] Failed to print to ${printer.name}:`, err?.message);
      // Don't throw — a failed KOT should never block the order flow
    }
  }
}
