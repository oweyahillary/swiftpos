/**
 * ReceiptView — the customer receipt.
 *
 * Laid out to match the incumbent system the staff already read, because the
 * client benchmarks against it: header block, item lines, tax breakdown, an
 * explicit PAY figure, then payment detail.
 *
 * Line amounts are shown NET of tax, with CTL and VAT added back beneath, which
 * is how the incumbent prints them even though menu prices are tax-inclusive.
 * Per-line nets are rounded independently, so their sum can land a cent away
 * from the derived total — the Round Off line absorbs exactly that, which is
 * what it exists for. The receipt therefore always foots to what was charged.
 *
 * Combos print as a single named line with no component breakdown. The
 * expansion belongs on the dispatcher and kitchen tickets; the customer bought
 * "Kanka Combo", not six things.
 */

import { forwardRef } from 'react';
import type { CartItem } from '../lib/cart';
import type { PaymentLeg } from './PaymentModal';

interface Props {
  businessName: string;
  orderNumber: string;
  cart: CartItem[];
  subtotal: number;
  discountAmount: number;
  tipAmount: number;
  total: number;
  vatAmount: number;
  vatRate: number;
  ctlAmount?: number;
  ctlRate?: number;
  currency: string;
  payments: PaymentLeg[];
  orderType?: string;
  tableNumber?: string;
  /** Owner-authored block under the business name — address, PIN, phone. */
  headerText?: string;
  /** Owner-authored block at the bottom. Falls back to footerMessage. */
  footerText?: string;
  footerMessage?: string;   // per-device fallback from printer settings
  tillNumber?: string;     // device name — which till rang the sale
  cashierName?: string;
  billNumber?: string;     // terminal-prefixed where available
  kots?: number;           // how many times this order went to the kitchen
  deliveryPerson?: string; // rider, on a delivery order
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'CASH', mpesa: 'M-PESA', card: 'CARD', credit: 'ON ACCOUNT',
};

const ReceiptView = forwardRef<HTMLDivElement, Props>((
  { businessName, orderNumber, cart, subtotal, discountAmount, tipAmount, total,
    vatAmount, vatRate, ctlAmount = 0, ctlRate = 0, currency, payments,
    orderType, tableNumber, footerMessage, headerText, footerText, tillNumber, cashierName, billNumber, kots, deliveryPerson },
  ref
) => {
  const now = new Date();
  const stamp = `${now.toLocaleDateString('en-KE')} ${now.toLocaleTimeString('en-KE', { hour12: false })}`;
  const taxed = vatRate > 0 || ctlRate > 0;
  const divisor = 1 + (vatRate + ctlRate) / 100;

  // Net per line, then summed — mirrors the incumbent's presentation.
  const lineNet = (v: number) => (taxed ? v / divisor : v);
  const netSubtotal = cart.reduce((s, i) => s + lineNet(i.lineTotal), 0) - lineNet(discountAmount);
  const totalQty = cart.reduce((s, i) => s + i.quantity, 0);

  // Absorbs per-line rounding so the printed figures always sum to `total`.
  const roundOff = total - (netSubtotal + ctlAmount + vatAmount + tipAmount);
  const totalChange = payments.reduce((s, p) => s + (p.change_given ?? 0), 0);

  const money = (v: number) => v.toFixed(2);
  // Grouped, always two decimals. The two headline figures used to go through
  // toLocaleString() with no fraction digits set, so a 1,234.50 sale printed as
  // "PAY: KES 1,234.5" on the customer's receipt while every other line on the
  // same receipt showed two.
  const moneyBig = (v: number) =>
    v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Owner text is free-form and multi-line. Split rather than using
  // white-space:pre so blank lines can't push a thermal receipt off the roll.
  const lines = (text?: string) =>
    (text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const rule = (dashed = true) => (
    <p style={{ borderTop: dashed ? '1px dashed #000' : '1px solid #000', margin: '6px 0' }} />
  );
  // Fixed-layout table, not flex.
  //
  // Flex items default to min-width:auto, so they refuse to shrink below their
  // longest word but WILL push a sibling below its content — which is how
  // "Total Invoice Value:" squeezed the amount column until 1,940.00 printed as
  // "1,940.0" on one line and "0" on the next. A currency figure broken across
  // two lines is the worst thing this receipt can do. Fixed table columns can't
  // do that, and nowrap on the value makes it impossible by construction.
  // AUTO layout, not fixed.
  //
  // A fixed 42% value column plus nowrap meant anything longer than 42% ran past
  // the column and was clipped by the ticket's overflow:hidden — which is how
  // "Eugene Oweya" printed as "Eugene Owe" and the date lost its year. Auto
  // layout gives the value exactly the width it needs and lets the LABEL give
  // way instead, since labels are short, known, and safe to shrink.
  //
  // nowrap stays on the value: that is what stops a currency figure breaking
  // across two lines, which is a far worse failure than a wrapped label.
  const row = (label: React.ReactNode, value: React.ReactNode, style: React.CSSProperties = {}) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto', ...style }}>
      <tbody><tr>
        {/* Label shrinks to its own text; the value takes what is left.
            A long value must WRAP, not overflow: with nowrap the table grows
            past the ticket width and the print head simply stops at its last
            dot, so "Eugene Oweya" arrived as "Eugene Owe" and the date lost its
            seconds. Silent truncation of a cashier name reads as a data bug,
            which is the most expensive kind of layout fault. */}
        <td style={{ padding: 0, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{label}</td>
        <td style={{ padding: 0, textAlign: 'right', paddingLeft: '6px', verticalAlign: 'top', wordBreak: 'break-word' }}>{value}</td>
      </tr></tbody>
    </table>
  );

  const typeLabel =
    orderType === 'dine_in' ? 'Dine In'
      : orderType === 'takeaway' ? 'Takeaway'
      : orderType === 'delivery' ? 'Delivery'
      : 'Counter';

  return (
      // Paper. The receipt is authored in print colours — black on white — and
      // was previously rendered straight onto the dark modal, so the preview was
      // near-black text on a near-black panel. Giving it an actual white sheet
      // both fixes readability and makes the preview look like the thing that
      // comes out of the printer.
      //
      // Safe for printing: printReceipt captures ref.innerHTML, so this root
      // element's own styles are never part of the printed document.
    <div ref={ref} style={{
      fontFamily: "'Courier New', monospace", fontSize: '12px', color: '#000',
      lineHeight: '1.55', background: '#fff', padding: '16px 14px', borderRadius: '3px',
    }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '17px', fontWeight: 'bold', letterSpacing: '1px' }}>{businessName.toUpperCase()}</p>
        {tillNumber && <p style={{ fontSize: '11px' }}>TILL {tillNumber}</p>}
        {lines(headerText).map((l, i) => (
          <p key={i} style={{ fontSize: '11px' }}>{l}</p>
        ))}
      </div>
      {rule()}

      {row('Type:', typeLabel)}
      {tableNumber && row('Table:', tableNumber)}
      {orderType === 'delivery' && row('Delivery Boy:', deliveryPerson || '—')}
      {rule()}

      {billNumber && row('Bill No.:', billNumber, { fontWeight: 'bold' })}
      {row('Order:', orderNumber)}
      {cashierName && row('Cashier:', cashierName)}
      {row('Date:', stamp)}
      {kots ? row('Kots:', kots) : null}
      {rule()}

      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontWeight: 'bold' }}>
        <tbody><tr>
          <td style={{ padding: 0 }}>Item</td>
          <td style={{ padding: 0, width: '11%', textAlign: 'right' }}>Qty</td>
          <td style={{ padding: 0, width: '27%', textAlign: 'right' }}>Amt</td>
        </tr></tbody>
      </table>
      {rule()}

      {cart.map((item, index) => (
        <div key={index} style={{ marginBottom: '3px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <tbody><tr>
              <td style={{ padding: 0, paddingRight: '4px', verticalAlign: 'top' }}>{item.product.name}</td>
              <td style={{ padding: 0, width: '11%', textAlign: 'right', verticalAlign: 'top' }}>
                {item.isFuel ? item.quantity.toFixed(2) : item.quantity}
              </td>
              <td style={{ padding: 0, width: '27%', textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top', paddingLeft: '4px' }}>
                {money(lineNet(item.lineTotal))}
              </td>
            </tr></tbody>
          </table>
          {/* CUSTOMER RECEIPT: menu item and price only.
              ────────────────────────────────────────────────────────────────
              Variant and modifier names — "Normal", "Spicy", "+ Large fries" —
              are the DESCRIPTION, and the owner's decision is that description
              belongs on the kitchen and packing tickets, not the customer's copy.
              It matches the incumbent receipt the staff already read, which
              carries no sub-lines at all.

              No prices are added anywhere here. The amount against the item is
              already the true charge: computeLineTotal folds every variant
              adjustment and modifier price into lineTotal, so the column still
              foots to the total with nothing hidden and nothing double-counted.

              Worth knowing, since it will surface at the counter one day: a
              priced upgrade now has no explanation on the paper, so a combo
              advertised at 787 prints as 847 with nothing saying why. The
              kitchen and packing tickets still carry the detail, so the answer
              exists — it is just not in the customer's hand. */}
        </div>
      ))}
      {rule()}

      {row('Total Qty:', totalQty)}
      {discountAmount > 0 && row('Discount:', `-${money(lineNet(discountAmount))}`)}
      {row('SubTotal:', money(netSubtotal))}
      {rule()}

      {ctlRate > 0 && row(`CTL (${ctlRate}%)`, money(ctlAmount))}
      {vatRate > 0 && row(`VAT (${vatRate}%)`, money(vatAmount))}
      {tipAmount > 0 && row('Tip', money(tipAmount))}
      {(ctlRate > 0 || vatRate > 0) && rule()}

      {row('Round Off:', money(roundOff))}
      {row('Total:', moneyBig(total), { fontWeight: 'bold' })}
      {rule()}

      <p style={{ fontSize: '17px', fontWeight: 'bold', margin: '4px 0' }}>
        PAY: {currency} {moneyBig(total)}
      </p>
      {rule()}

      <p style={{ fontWeight: 'bold' }}>Payment Detail:</p>
      {rule(false)}
      {payments.map((p, i) => (
        <div key={i}>
          {row(METHOD_LABEL[p.method] ?? p.method.toUpperCase(), moneyBig(p.amount))}
          {p.method === 'cash' && p.amount_tendered > p.amount &&
            row('  Tendered', moneyBig(p.amount_tendered), {})}
          {p.reference && row('  Ref', p.reference, {})}
        </div>
      ))}
      {totalChange > 0 && row('Change', moneyBig(totalChange))}
      {rule()}

      <div style={{ textAlign: 'center', marginTop: '6px' }}>
        {/* Business-level text wins: it is set once by the owner and reaches all
            tills. footerMessage is the per-device fallback for a till that has
            not synced yet. */}
        {lines(footerText).length > 0
          ? lines(footerText).map((l, i) => <p key={i}>{l}</p>)
          : <p>{footerMessage || 'Thank you, visit again!'}</p>}
        {vatRate > 0 && <p style={{ fontSize: '11px' }}>TAX RECEIPT UPON REQUEST</p>}
        <p style={{ fontSize: '10px', marginTop: '4px' }}>Powered by SwiftPOS</p>
      </div>
    </div>
  );
});

ReceiptView.displayName = 'ReceiptView';
export default ReceiptView;
