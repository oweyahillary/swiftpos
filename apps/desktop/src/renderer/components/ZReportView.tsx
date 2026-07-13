import { forwardRef } from 'react';
import type { ZReport } from '../lib/posApi';

interface Props {
  report: ZReport;
}

// Monospace, thermal-printer-friendly Z-report. Mirrors ReceiptView's inline-style
// approach so the same window.open(...).print() path renders it correctly.
const ZReportView = forwardRef<HTMLDivElement, Props>(({ report }, ref) => {
  const { shift, byMethod, totals, businessName, currency } = report;
  const money = (n: number | null | undefined) =>
    `${currency} ${(Number(n ?? 0)).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  const isClosed = shift.status === 'closed';
  const variance = shift.cash_variance;

  const row = (label: string, value: string, opts: { bold?: boolean; size?: string } = {}) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: opts.bold ? 'bold' : 'normal', fontSize: opts.size ?? '12px', margin: opts.bold ? '4px 0' : '2px 0' }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
  const rule = <p style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />;

  return (
    <div ref={ref} style={{ fontFamily: "'Courier New', monospace", fontSize: '12px', color: '#000', lineHeight: '1.6' }}>
      <div style={{ textAlign: 'center', marginBottom: '8px' }}>
        <p style={{ fontSize: '16px', fontWeight: 'bold' }}>{businessName.toUpperCase()}</p>
        <p style={{ fontSize: '14px', fontWeight: 'bold' }}>{isClosed ? 'Z-REPORT (SHIFT CLOSE)' : 'SHIFT REPORT (LIVE)'}</p>
        <p>Printed {dt(new Date().toISOString())}</p>
      </div>

      {rule}
      {row('Cashier', shift.cashier_name)}
      {row('Shift', shift.id.slice(0, 8))}
      {row('Opened', dt(shift.opened_at))}
      {row('Closed', dt(shift.closed_at))}
      {row('Status', shift.status.toUpperCase())}

      {rule}
      <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>SALES BY METHOD</p>
      {byMethod.length === 0 && <p style={{ color: '#555' }}>No sales this shift</p>}
      {byMethod.map(m => (
        <div key={m.method} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ textTransform: 'uppercase' }}>{m.method === 'mpesa' ? 'M-PESA' : m.method} ({m.orders})</span>
          <span>{money(m.amount)}</span>
        </div>
      ))}
      {rule}
      {row('Orders', String(totals.orderCount))}
      {row('Gross sales', money(totals.grossSales))}
      {row('Voids', String(totals.voidCount))}

      {rule}
      <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>CASH RECONCILIATION</p>
      {row('Opening float', money(shift.opening_float))}
      {row('+ Cash sales', money(totals.cashSales))}
      {row('+ Float in', money(totals.floatIn))}
      {row('− Float out', money(totals.floatOut))}
      {row('= Expected cash', money(shift.expected_cash), { bold: true })}
      {isClosed && row('Counted cash', money(shift.closing_float))}
      {isClosed && variance != null && row(
        variance === 0 ? 'Variance' : variance > 0 ? 'Variance (over)' : 'Variance (short)',
        money(variance),
        { bold: true, size: '14px' },
      )}

      {isClosed && shift.notes && (
        <>
          {rule}
          <p style={{ fontWeight: 'bold' }}>Notes</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{shift.notes}</p>
        </>
      )}

      {rule}
      <div style={{ textAlign: 'center', marginTop: '8px' }}>
        <p style={{ fontSize: '10px', color: '#555' }}>Powered by SwiftPOS</p>
      </div>
    </div>
  );
});

ZReportView.displayName = 'ZReportView';
export default ZReportView;
