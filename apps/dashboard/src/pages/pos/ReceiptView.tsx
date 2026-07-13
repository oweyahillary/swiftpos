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
  currency: string;
  payments: PaymentLine[];
  tendered: number;
  change: number;
  tip?: number;
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
    business, branchName, orderNumber, cart, total, subtotal, vatAmount, currency,
    payments, tendered, change, tip = 0,
    loyaltyDiscount = 0, promoDiscount = 0, promoName, customerName,
    footerMessage = 'Thank you for your business!',
    etims = null,
  },
  ref,
) => {
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

  return (
    <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: '12px', color: '#000', lineHeight: '1.6' }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '10px' }}>
        <p style={{ fontSize: '15px', fontWeight: 'bold' }}>{business.name.toUpperCase()}</p>
        {branchName && branchName !== business.name && (
          <p style={{ fontSize: '11px' }}>{branchName}</p>
        )}
        {business.address && <p style={{ fontSize: '11px' }}>{business.address}</p>}
        {business.phone && <p style={{ fontSize: '11px' }}>Tel: {business.phone}</p>}
        {business.tax_pin && <p style={{ fontSize: '11px' }}>PIN: {business.tax_pin}</p>}
        <p style={{ fontSize: '11px', marginTop: '4px' }}>{dateStr}  {timeStr}</p>
        <p style={{ fontSize: '11px' }}>Order: {orderNumber}</p>
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
      {line('Subtotal', `${currency} ${fmtMoney(subtotal)}`)}
      {line(vatLabel, `${currency} ${fmtMoney(vatAmount)}`)}
      {promoDiscount > 0 && line(`${promoName ?? 'Promo discount'}`, `- ${currency} ${fmtMoney(promoDiscount)}`, false, '#92400e')}
      {loyaltyDiscount > 0 && line('Loyalty discount', `- ${currency} ${fmtMoney(loyaltyDiscount)}`, false, '#065f46')}
      <div style={{ borderTop: '1px solid #000', marginTop: '4px', paddingTop: '4px' }}>
        {line('TOTAL', `${currency} ${fmtMoney(total)}`, true)}
        {tip > 0 && line('Tip', `${currency} ${fmtMoney(tip)}`)}
        {tip > 0 && line('TOTAL PAID', `${currency} ${fmtMoney(total + tip)}`, true)}
      </div>

      {divider()}

      {/* Payment(s) */}
      {isSplit ? (
        <>
          <p style={{ fontWeight: 'bold', marginBottom: '3px' }}>Split payment</p>
          {payments.map((p, i) => (
            <div key={i}>
              {line(fmtMethod(p.method), `${currency} ${fmtMoney(p.amount)}`)}
              {p.reference && line('  Ref', p.reference)}
            </div>
          ))}
        </>
      ) : (
        <>
          {line('Payment', fmtMethod(payments[0]?.method ?? 'cash'))}
          {cashPayment && (
            <>
              {line('Tendered', `${currency} ${fmtMoney(tendered)}`)}
              {line('Change', `${currency} ${fmtMoney(change)}`)}
            </>
          )}
          {payments[0]?.reference && line('Ref', payments[0].reference)}
        </>
      )}

      {divider()}

      {divider()}

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
        {business.tax_pin && (
          <p style={{ fontSize: '10px', marginTop: '2px' }}>VAT Reg: {business.tax_pin}</p>
        )}
        <p style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>Powered by SwiftPOS</p>
      </div>
    </div>
  );
});

ReceiptView.displayName = 'ReceiptView';
export default ReceiptView;
