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
import { getQZStatus, getPrintToken, printBytesToServer } from './localPrintServer';

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

// ─── KOT ESC/POS builder (silent bridge path) ─────────────────────────────────
//
// The tiny print bridge is a pure byte-forwarder: it cannot render HTML, so the
// KOT must be rendered to ESC/POS in the browser (mirroring buildKOTHtml above).
// This is a small, self-contained ESC/POS text builder — deliberately NOT routed
// through shared/printing's production renderer, which models combos/portions
// (units + attributes) rather than the web cart's flat variant/modifier strings;
// forcing that mapping risked dropping a modifier from a kitchen ticket (wrong
// food). Content here matches the HTML KOT one-for-one.
//
// ESC/POS control codes used:
//   ESC @  (1b 40)       initialise
//   ESC a n(1b 61 n)     align: 0 left, 1 centre
//   ESC E n(1b 45 n)     bold on/off
//   GS ! n (1d 21 n)     char size (n = width<<4 | height; 0x11 = double both)
//   LF     (0a)          line feed
//   GS V 0 (1d 56 00)    full cut
function buildKotEscPos(items: CartItem[], ctx: KOTContext, printer: BranchPrinter): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  const raw  = (...b: number[]) => out.push(...b);
  // Strip anything outside printable ASCII — thermal heads render CP437, not UTF-8,
  // so stray unicode (curly quotes, arrows) would print as garbage. The sub-line
  // markers below are spelled in ASCII for the same reason.
  const text = (str: string) => out.push(...enc.encode(str.replace(/[^\x20-\x7e]/g, '')));
  const nl   = () => raw(0x0a);
  const line = (str = '') => { text(str); nl(); };
  const alignCenter = () => raw(0x1b, 0x61, 0x01);
  const alignLeft   = () => raw(0x1b, 0x61, 0x00);
  const boldOn      = () => raw(0x1b, 0x45, 0x01);
  const boldOff     = () => raw(0x1b, 0x45, 0x00);
  const sizeDouble  = () => raw(0x1d, 0x21, 0x11);
  const sizeNormal  = () => raw(0x1d, 0x21, 0x00);

  const cols = printer.paper_width === 58 ? 32 : 48;
  const divider = '-'.repeat(cols);
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' });
  const typeLabelMap: Record<string, string> = {
    kitchen: 'KITCHEN', bar: 'BAR', expeditor: 'EXPEDITOR', kot: 'KOT', receipt: 'ORDER',
  };
  const typeLabel = typeLabelMap[printer.type] ?? 'ORDER';
  const typeDisplay = ctx.orderType === 'dine_in' ? 'DINE IN'
    : ctx.orderType === 'takeaway' ? 'TAKEAWAY' : 'RETAIL';

  raw(0x1b, 0x40); // init

  alignCenter(); boldOn(); sizeDouble();
  line(typeLabel);
  sizeNormal(); boldOff();
  if (ctx.branchName) line(ctx.branchName);
  alignLeft();
  line(divider);

  boldOn();
  line(`ORDER  ${ctx.orderNumber}`);
  if (ctx.tableNumber) line(`TABLE  ${ctx.tableNumber}`);
  boldOff();
  line(`${typeDisplay} - ${dateStr} ${timeStr}`);
  if (ctx.staffName) line(`Cashier: ${ctx.staffName}`);
  line(divider);

  for (const item of items) {
    boldOn();
    line(`${item.quantity} x ${item.product.name}`);
    boldOff();
    for (const v of item.selectedVariants) line(`   - ${v.groupName}: ${v.optionName}`);
    for (const m of item.selectedModifiers) line(`   + ${m.optionName}`);
  }
  line(divider);

  if (ctx.notes) { boldOn(); line(`NOTE: ${ctx.notes}`); boldOff(); line(divider); }

  alignCenter();
  line(`Printed ${timeStr}`);
  alignLeft();

  nl(); nl(); nl();
  raw(0x1d, 0x56, 0x00); // full cut

  return Uint8Array.from(out);
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

    // Browser-dialog fallback (also used when the bridge is unavailable or errors).
    const browserFallback = () => printReceipt(
      buildKOTHtml(filteredItems, ctx, printer),
      { ...fallbackSettings, paperWidth: printer.paper_width, copies: 1, autoCut: true, footerMessage: '' },
      `KOT — ${printer.name}`,
    );

    // Silent path: the browser renders ESC/POS and the bridge forwards the bytes
    // (same contract as the customer receipt). Requires the bridge connected, a
    // pairing token, and a chosen OS printer name. Any failure drops to the
    // browser dialog so a kitchen ticket is never silently lost (A242).
    const useBridge =
      printer.connection_type === 'qz' &&
      getQZStatus() === 'connected' &&
      !!printer.printer_name &&
      !!getPrintToken();

    try {
      if (useBridge) {
        const bytes = buildKotEscPos(filteredItems, ctx, printer);
        await printBytesToServer(`printer:${printer.printer_name}`, bytes);
      } else {
        await browserFallback();
      }
    } catch (err: any) {
      console.error(`[KOT] bridge print to ${printer.name} failed, using browser dialog:`, err?.message);
      try { await browserFallback(); } catch { /* never block the order flow */ }
    }
  }
}
