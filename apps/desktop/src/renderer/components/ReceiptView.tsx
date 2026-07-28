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
  const row = (label: React.ReactNode, value: React.ReactNode, style: React.CSSProperties = {}) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', ...style }}>
      <span>{label}</span><span>{value}</span>
    </div>
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

      <div style={{ display: 'flex', fontWeight: 'bold' }}>
        <span style={{ flex: 1 }}>Item</span>
        <span style={{ width: '34px', textAlign: 'right' }}>Qty</span>
        <span style={{ width: '72px', textAlign: 'right' }}>Amt</span>
      </div>
      {rule()}

      {cart.map((item, index) => (
        <div key={index} style={{ marginBottom: '3px' }}>
          <div style={{ display: 'flex' }}>
            <span style={{ flex: 1, paddingRight: '4px' }}>{item.product.name}</span>
            <span style={{ width: '34px', textAlign: 'right' }}>
              {item.isFuel ? item.quantity.toFixed(2) : item.quantity}
            </span>
            <span style={{ width: '72px', textAlign: 'right' }}>{money(lineNet(item.lineTotal))}</span>
          </div>
          {item.selectedVariants.map((v: any) => (
            <div key={v.optionId} style={{ paddingLeft: '10px', color: '#555' }}>{v.optionName}</div>
          ))}
          {item.selectedModifiers.map((m: any) => (
            <div key={m.optionId} style={{ paddingLeft: '10px', color: '#555' }}>+ {m.optionName}</div>
          ))}
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
      {row('Total Invoice Value:', moneyBig(total), { fontWeight: 'bold' })}
      {rule()}

      <p style={{ fontSize: '17px', fontWeight: 'bold', margin: '4px 0' }}>
        PAY: {currency} {moneyBig(total)}
      </p>
      {rule()}

      <p style={{ fontWeight: 'bold' }}>Payment Detail:</p>
      {rule(false)}
      {payments.map((p, i) => (
        <div key={i}>
          {row(METHOD_LABEL[p.method] ?? p.method.toUpperCase(), money(p.amount))}
          {p.method === 'cash' && p.amount_tendered > p.amount &&
            row('  Tendered', money(p.amount_tendered), { color: '#555' })}
          {p.reference && row('  Ref', p.reference, { color: '#555' })}
        </div>
      ))}
      {totalChange > 0 && row('Change', money(totalChange))}
      {rule()}

      <div style={{ textAlign: 'center', marginTop: '6px' }}>
        {/* Business-level text wins: it is set once by the owner and reaches all
            tills. footerMessage is the per-device fallback for a till that has
            not synced yet. */}
        {lines(footerText).length > 0
          ? lines(footerText).map((l, i) => <p key={i}>{l}</p>)
          : <p>{footerMessage || 'Thank you, visit again!'}</p>}
        {vatRate > 0 && <p style={{ fontSize: '11px' }}>TAX RECEIPT UPON REQUEST</p>}
        <p style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>Powered by SwiftPOS</p>
      </div>
    </div>
  );
});

ReceiptView.displayName = 'ReceiptView';
export default ReceiptView;
