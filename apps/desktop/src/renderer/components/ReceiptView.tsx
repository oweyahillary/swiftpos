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
  currency: string;
  payments: PaymentLeg[];
  orderType?: string;      // 'dine_in' | 'takeaway' — shown for restaurants
  tableNumber?: string;
  footerMessage?: string;  // from printer settings
}

const METHOD_LABEL: Record<string, string> = { cash: 'CASH', mpesa: 'M-PESA', card: 'CARD', credit: 'ON ACCOUNT' };

const ReceiptView = forwardRef<HTMLDivElement, Props>((
  { businessName, orderNumber, cart, subtotal, discountAmount, tipAmount, total, vatAmount, currency, payments, orderType, tableNumber, footerMessage },
  ref
) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  const net = (subtotal - discountAmount) - vatAmount;
  const totalChange = payments.reduce((s, p) => s + (p.change_given ?? 0), 0);

  const row = (label: React.ReactNode, value: React.ReactNode, style: React.CSSProperties = {}) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', ...style }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );

  return (
    <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: '12px', color: '#000', lineHeight: '1.6' }}>
      <div style={{ textAlign: 'center', marginBottom: '12px' }}>
        <p style={{ fontSize: '16px', fontWeight: 'bold' }}>{businessName.toUpperCase()}</p>
        <p>{dateStr} {timeStr}</p>
        <p>Order: {orderNumber}</p>
        {orderType && (
          <p>
            {orderType === 'dine_in' ? 'DINE IN' : orderType === 'takeaway' ? 'TAKEAWAY' : orderType.toUpperCase()}
            {tableNumber ? ` · TABLE ${tableNumber}` : ''}
          </p>
        )}
      </div>

      <p style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

      {cart.map((item, index) => (
        <div key={index} style={{ marginBottom: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ flex: 1 }}>
              {item.product.name} {item.isFuel
                ? `${item.quantity.toFixed(2)} L`
                : `x${item.quantity}`}
            </span>
            <span>{currency} {item.lineTotal.toLocaleString()}</span>
          </div>
          {item.selectedVariants.map((v: any) => (
            <div key={v.optionId} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '12px', color: '#555' }}>
              <span>{v.groupName}: {v.optionName}</span>
              <span>{v.priceAdjustment === 0 ? 'incl.' : `+${currency} ${(v.priceAdjustment * item.quantity).toLocaleString()}`}</span>
            </div>
          ))}
          {item.selectedModifiers.map((m: any) => (
            <div key={m.optionId} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '12px', color: '#555' }}>
              <span>+ {m.optionName}</span>
              <span>{m.price === 0 ? 'free' : `+${currency} ${(m.price * item.quantity).toLocaleString()}`}</span>
            </div>
          ))}
        </div>
      ))}

      <p style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

      {discountAmount > 0 && (
        <>
          {row('Subtotal', `${currency} ${subtotal.toLocaleString()}`)}
          {row('Discount', `-${currency} ${discountAmount.toLocaleString()}`)}
        </>
      )}
      {row('Net', `${currency} ${net.toFixed(2)}`)}
      {row('VAT (16%)', `${currency} ${vatAmount.toFixed(2)}`)}
      {tipAmount > 0 && row('Tip', `${currency} ${tipAmount.toLocaleString()}`)}
      {row('TOTAL', `${currency} ${total.toLocaleString()}`, { fontWeight: 'bold', fontSize: '14px', margin: '4px 0' })}

      <p style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

      {payments.map((p, i) => (
        <div key={i}>
          {row(
            METHOD_LABEL[p.method] ?? p.method.toUpperCase(),
            `${currency} ${p.amount.toLocaleString()}`
          )}
          {p.method === 'cash' && p.amount_tendered > p.amount && (
            <>
              {row('  Tendered', `${currency} ${p.amount_tendered.toLocaleString()}`, { color: '#555' })}
            </>
          )}
          {p.reference && row('  Ref', p.reference, { color: '#555' })}
        </div>
      ))}
      {totalChange > 0 && row('Change', `${currency} ${totalChange.toLocaleString()}`)}

      <p style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />
      <div style={{ textAlign: 'center', marginTop: '8px' }}>
        <p>{footerMessage || 'Thank you for your business!'}</p>
        <p style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>Powered by SwiftPOS</p>
      </div>
    </div>
  );
});

ReceiptView.displayName = 'ReceiptView';
export default ReceiptView;
