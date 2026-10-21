import { forwardRef } from 'react';
import type { CartItem } from '../../lib/cart';
import type { Business } from '../../types';

interface PaymentLine {
  method: string;
  amount: number;
  reference?: string;
}

interface Props {
  business: Business;
  branchName?: string;
  orderNumber: string;
  cart: CartItem[];
  total: number;
  subtotal: number;
  vatAmount: number;
  /** A349: the catering levy inside the bill, and its rate (0 = not levied → no line). */
  ctlAmount?: number;
  ctlRate?: number;
  currency: string;
  payments: PaymentLine[];
  tendered: number;
  change: number;
  tip?: number;
  /** 0.6.27: the delivery fee on top of the bill. */
  deliveryFee?: number;
  /** 0.6.33: a free delivery — "Delivery: FREE" (the shop pays the rider). */
  deliveryFree?: boolean;
  loyaltyDiscount?: number;
  promoDiscount?: number;
  promoName?: string;
  customerName?: string;
  footerMessage?: string;
  /** KRA eTIMS fiscal data — present only once the invoice is signed.
   *  When absent, no fiscal block renders (non-fiscalised installs unchanged). */
  etims?: {
    receiptNo?: string | null;     // KRA curRcptNo
    internalData?: string | null;  // intrlData
    signature?: string | null;     // rcptSign
    qrPayload?: string | null;     // QR content/URL
  } | null;
  /**
   * A538: the client's "Compact receipt layout" switch (admin portal › posFeatures `receipt_compact_layout`) — the
   * compact lines A534 gave this browser-printed receipt. Off (the standard again, owner 2026-10-21: "go back to the old
   * layout"): every line as it was before A534. (A534 had it the other way round, keyed by `receipt_classic_layout`.)
   */
  compact?: boolean;
  /**
   * A547 (A539 on the browser receipt): how a customer pays by M-Pesa — the receipt_pay the thermal receipt prints
   * (A450). The classic layout names it in the payment block's heading: "Payment Details: Buy Goods - 123456".
   */
  pay?: { label?: string | null; number?: string | null } | null;
  /** A547 (A540): the cent the tax split loses, shown as "Round Off" only when it is really there — never "0.00". */
  roundOff?: number;
}

function fmtMoney(n: number) {
  return n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMethod(method: string) {
  if (method === 'mpesa') return 'M-PESA';
  return method.toUpperCase();
}

const ReceiptView = forwardRef<HTMLDivElement, Props>((
  {
    business, branchName, orderNumber, cart, total, subtotal, vatAmount, ctlAmount = 0, ctlRate = 0, currency,
    payments, tendered, change, tip = 0, deliveryFee = 0, deliveryFree = false,
    loyaltyDiscount = 0, promoDiscount = 0, promoName, customerName,
    footerMessage = 'Thank you for your business!',
    etims = null,
    compact = false,
    pay = null,
    roundOff = 0,
  },
  ref,
) => {
  // A534 (owner, 2026-10-20: "add all of them since effort is small"; A530: "I feel the receipt is too long wasting
  // paper"): the browser-printed receipt (a Windows / non-thermal printer, the dialog fallback) follows the thermal
  // receipt's compact rules — layout only: the date and the order share a line, phone and PIN share a line, no Subtotal
  // when it equals the total (no discount), no "Split payment" heading, the cash line carries what was tendered, the
  // footer does not repeat the PIN, and no doubled rule. A538 (owner, 2026-10-21: "it feels congested everywhere" — "go
  // back to the old layout"): those rules only with `compact` (receipt_compact_layout); the standard is every line as before.
  // Guard against a transient null business during the modal→receipt transition
  // (a rapid double-click could render this before business context resolves).
  if (!business) return <div ref={ref} />;

  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });

  // VAT rate from business settings — default 16%
  const vatRate     = business.vat_rate ?? 16;
  const vatLabel    = `VAT (${vatRate}%)`;
  const isSplit     = payments.length > 1;
  const cashPayment = payments.find(p => p.method === 'cash');

  const line = (label: string, value: string, bold = false, color?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px', ...(bold ? { fontWeight: 'bold' } : {}), ...(color ? { color } : {}) }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );

  const divider = () => <p style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />;

  // A547 (A539, owner 2026-10-21: "payment details: Pay bill/buygood - 892984 / ------ / mpesa/cash/card"): the classic
  // block as the thermal receipt prints it — the heading names the number customers pay to, a rule, the payments, CHANGE.
  const payNumber = pay?.number?.trim() || '';
  const payHeading = payNumber ? `Payment Details: ${pay?.label?.trim() || 'Buy Goods'} - ${payNumber}` : 'Payment Details:';
  const showRoundOff = Math.abs(roundOff) >= 0.005;   // A540: no "Round Off: 0.00"

  return (
    <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: '12px', color: '#000', lineHeight: '1.6' }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '10px' }}>
        <p style={{ fontSize: '15px', fontWeight: 'bold' }}>{business.name.toUpperCase()}</p>
        {branchName && branchName !== business.name && (
          <p style={{ fontSize: '11px' }}>{branchName}</p>
        )}
        {business.address && <p style={{ fontSize: '11px' }}>{business.address}</p>}
        {compact ? (
          (business.phone || business.tax_pin) && (
            <p style={{ fontSize: '11px' }}>
              {[business.phone ? `Tel: ${business.phone}` : '', business.tax_pin ? `PIN: ${business.tax_pin}` : ''].filter(Boolean).join(' · ')}
            </p>
          )
        ) : (
          <>
            {business.phone && <p style={{ fontSize: '11px' }}>Tel: {business.phone}</p>}
            {business.tax_pin && <p style={{ fontSize: '11px' }}>PIN: {business.tax_pin}</p>}
          </>
        )}
        {compact ? (
          <p style={{ fontSize: '11px', marginTop: '4px' }}>{dateStr} {timeStr} · Order: {orderNumber}</p>
        ) : (
          <>
            <p style={{ fontSize: '11px', marginTop: '4px' }}>{dateStr}  {timeStr}</p>
            <p style={{ fontSize: '11px' }}>Order: {orderNumber}</p>
          </>
        )}
        {customerName && <p style={{ fontSize: '11px' }}>Customer: {customerName}</p>}
      </div>

      {divider()}

      {/* Items */}
      {cart.map((item, index) => (
        <div key={index} style={{ marginBottom: '5px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ flex: 1, paddingRight: '8px' }}>{item.product.name} x{item.quantity}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{currency} {fmtMoney(item.lineTotal)}</span>
          </div>

          {/* Variants */}
          {item.selectedVariants.map(v => (
            <div key={v.optionId} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '10px', color: '#555', fontSize: '11px' }}>
              <span>{v.groupName}: {v.optionName}</span>
              <span>{v.priceAdjustment === 0 ? 'incl.' : `+${currency} ${fmtMoney(v.priceAdjustment * item.quantity)}`}</span>
            </div>
          ))}

          {/* Modifiers */}
          {item.selectedModifiers.map(m => (
            <div key={m.optionId} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '10px', color: '#555', fontSize: '11px' }}>
              <span>+ {m.optionName}</span>
              <span>{m.price === 0 ? 'free' : `+${currency} ${fmtMoney(m.price * item.quantity)}`}</span>
            </div>
          ))}
        </div>
      ))}

      {divider()}

      {/* Totals */}
      {(!compact || promoDiscount > 0 || loyaltyDiscount > 0) && line('Subtotal', `${currency} ${fmtMoney(subtotal)}`)}
      {promoDiscount > 0 && line(`${promoName ?? 'Promo discount'}`, `- ${currency} ${fmtMoney(promoDiscount)}`, false, '#92400e')}
      {loyaltyDiscount > 0 && line('Loyalty discount', `- ${currency} ${fmtMoney(loyaltyDiscount)}`, false, '#065f46')}
      {/* A349: the taxes INSIDE the total (after any discount) — the figures the cloud stores for this sale. */}
      {line(`incl. ${vatLabel}`, `${currency} ${fmtMoney(vatAmount)}`)}
      {ctlRate > 0 && line(`incl. CTL (${ctlRate}%)`, `${currency} ${fmtMoney(ctlAmount)}`)}
      <div style={{ borderTop: '1px solid #000', marginTop: '4px', paddingTop: '4px' }}>
        {showRoundOff && line('Round Off', `${currency} ${fmtMoney(roundOff)}`)}
        {line('TOTAL', `${currency} ${fmtMoney(total)}`, true)}
        {tip > 0 && line('Tip', `${currency} ${fmtMoney(tip)}`)}
        {deliveryFee > 0 && line('Delivery fee', `${currency} ${fmtMoney(deliveryFee)}`)}
        {deliveryFree && line('Delivery', 'FREE')}
        {(tip > 0 || deliveryFee > 0) && line('TOTAL PAID', `${currency} ${fmtMoney(total + tip + deliveryFee)}`, true)}
      </div>

      {divider()}

      {/* Payment(s) */}
      {compact && isSplit ? (
        <>
          {payments.map((p, i) => (
            <div key={i}>
              {line(fmtMethod(p.method), `${currency} ${fmtMoney(p.amount)}`)}
              {p.reference && line('  Ref', p.reference)}
            </div>
          ))}
        </>
      ) : compact ? (
        <>
          {/* A534: the method and the amount on one line (cash: what was tendered), then the change only when there is some */}
          {line(fmtMethod(payments[0]?.method ?? 'cash'), `${currency} ${fmtMoney(cashPayment && tendered > 0 ? tendered : (payments[0]?.amount ?? total))}`)}
          {cashPayment && change > 0 && line('Change', `${currency} ${fmtMoney(change)}`)}
          {payments[0]?.reference && line('Ref', payments[0].reference)}
        </>
      ) : (
        <>
          {/* A547: the thermal receipt's block — "Payment Details: <Buy Goods|Paybill> - <number>", a rule, each payment
              (a lone cash payment carries what was tendered), CHANGE when there is some. No till line after them. */}
          <p style={{ fontWeight: 'bold', marginBottom: '3px' }} data-testid="payment-details">{payHeading}</p>
          {divider()}
          {payments.length === 0 && line(fmtMethod('cash'), `${currency} ${fmtMoney(total)}`)}
          {payments.map((p, i) => (
            <div key={i}>
              {line(fmtMethod(p.method), `${currency} ${fmtMoney(!isSplit && p.method === 'cash' && tendered > 0 ? tendered : p.amount)}`)}
              {p.reference && line('  Ref', p.reference)}
            </div>
          ))}
          {cashPayment && change > 0 && line('CHANGE', `${currency} ${fmtMoney(change)}`)}
        </>
      )}

      {divider()}

      {!compact && divider()}

      {/* KRA eTIMS fiscal block — renders only when the invoice is signed */}
      {etims && (etims.receiptNo || etims.signature) && (
        <>
          <div style={{ textAlign: 'center', marginBottom: '4px' }}>
            <p style={{ fontSize: '10px', fontWeight: 'bold' }}>KRA eTIMS</p>
            {etims.receiptNo && (
              <p style={{ fontSize: '10px' }}>SCU Receipt No: {etims.receiptNo}</p>
            )}
            {etims.internalData && (
              <p style={{ fontSize: '9px', wordBreak: 'break-all' }}>Internal Data: {etims.internalData}</p>
            )}
            {etims.signature && (
              <p style={{ fontSize: '9px', wordBreak: 'break-all' }}>Receipt Signature: {etims.signature}</p>
            )}
          </div>
          {etims.qrPayload && (
            <div style={{ textAlign: 'center', margin: '6px 0' }}>
              {/* Dependency-free QR via Google Chart API. Swap the base URL if you
                  prefer a self-hosted/offline generator. */}
              <img
                alt="KRA eTIMS QR"
                src={`https://chart.googleapis.com/chart?cht=qr&chs=120x120&chld=M|0&chl=${encodeURIComponent(etims.qrPayload)}`}
                style={{ width: '120px', height: '120px' }}
              />
            </div>
          )}
          {divider()}
        </>
      )}

      {/* Footer */}
      <div style={{ textAlign: 'center', marginTop: '6px' }}>
        <p>{footerMessage}</p>
        {!compact && business.tax_pin && (
          <p style={{ fontSize: '10px', marginTop: '2px' }}>VAT Reg: {business.tax_pin}</p>
        )}
        <p style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>Powered by ZapTill</p>
      </div>
    </div>
  );
});

ReceiptView.displayName = 'ReceiptView';
export default ReceiptView;
