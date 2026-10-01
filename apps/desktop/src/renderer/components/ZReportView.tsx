import { forwardRef } from 'react';
import type { ZReport } from '../lib/posApi';
import { zBackupNote } from '../lib/syncNotice';
import { confirmationPrintLines } from '../../shared/shiftConfirm';
import { kitchenVoidText } from '../../shared/kitchenLines';

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
      lineHeight: '1.6', background: '#fff', padding: '16px 14px', borderRadius: '3px',
    }}>
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
          <span style={{ textTransform: 'uppercase' }}>{m.method === 'mpesa' ? 'M-PESA' : m.method === 'glovo' ? 'GLOVO' : m.method} ({m.orders})</span>
          <span>{money(m.amount)}</span>
        </div>
      ))}
      {rule}
      {row('Orders', String(totals.orderCount))}
      {row('Gross sales', money(totals.grossSales))}
      {/* A349: refunds, what was kept, the taxes in it (CTL where levied) and tips — the shift's money in full. */}
      {(totals.refunds ?? 0) > 0 && row('− Refunds', money(totals.refunds!))}
      {(totals.refunds ?? 0) > 0 && row('= Net sales', money(totals.netSales ?? totals.grossSales - totals.refunds!))}
      {totals.vat != null && row('incl. VAT', money(totals.vat))}
      {totals.ctlLevied && row('incl. CTL', money(totals.ctl ?? 0))}
      {(totals.tips ?? 0) > 0 && row('Tips (in payments)', money(totals.tips!))}
      {/* 0.6.27: delivery fees — on top of the bills, not sales; the method the customer paid with carries them. */}
      {(totals.deliveryFees ?? 0) > 0 && row('Delivery fees (in payments)', money(totals.deliveryFees!))}
      {row('Voids', String(totals.voidCount))}

      {rule}
      <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>CASH RECONCILIATION</p>
      {row('Opening float', money(shift.opening_float))}
      {row('+ Cash sales', money(totals.cashSales))}
      {row('+ Float in', money(totals.floatIn - (totals.riderReturned ?? 0)))}
      {row('− Float out', money(totals.floatOut - (totals.riderPayouts ?? 0)))}
      {/* 0.6.27: the riders' fees, paid in cash from this drawer (net of any put back by a void). */}
      {((totals.riderPayouts ?? 0) > 0) && row('− Paid to riders', money((totals.riderPayouts ?? 0) - (totals.riderReturned ?? 0)))}
      {/* 0.6.11: expenses were always taken off expected cash but never shown, so the lines did not add up. */}
      {totals.expenses != null && row('− Expenses', money(totals.expenses))}
      {/* A342: the web POS's own shift on this till — counted in this drawer, closed with it. */}
      {(totals.foreign?.siblings?.count ?? 0) > 0 && row('+ Web shift on this till', money(totals.foreign!.siblings!.expected))}
      {row('= Expected cash', money(shift.expected_cash), { bold: true })}
      {isClosed && row('Counted cash', money(shift.closing_float))}
      {isClosed && variance != null && row(
        variance === 0 ? 'Variance' : variance > 0 ? 'Variance (over)' : 'Variance (short)',
        money(variance),
        { bold: true, size: '14px' },
      )}

      {/* 0.6.27: expenses paid by M-Pesa etc. — not from the drawer; they come off that method's expected total. */}
      {Object.keys(totals.expensesByMethod ?? {}).length > 0 && (
        <>
          {rule}
          <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>EXPENSES NOT FROM THE DRAWER</p>
          {Object.entries(totals.expensesByMethod!).map(([m, v]) => row(`− ${m === 'mpesa' ? 'M-PESA' : m.toUpperCase()}`, money(v)))}
        </>
      )}

      {(report.expenseLines?.length ?? 0) > 0 && (
        <>
          {rule}
          <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>EXPENSES ({report.expenseLines!.length})</p>
          {report.expenseLines!.map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>{e.label ?? e.description}{e.paid_by_name ? ` (${e.paid_by_name})` : ''}</span><span>{money(e.amount)}</span>
            </div>
          ))}
        </>
      )}

      {/* 0.6.28: items sent to the kitchen and taken back — why, made or not, who approved. */}
      {(report.kitchenVoids?.lines.length ?? 0) > 0 && (
        <>
          {rule}
          <p data-testid="z-kitchen-voids" style={{ fontWeight: 'bold', marginBottom: '4px' }}>KITCHEN VOIDS ({report.kitchenVoids!.lines.length})</p>
          {report.kitchenVoids!.lines.map((v) => (
            <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>{kitchenVoidText(v)}</span><span>{money(v.amount)}</span>
            </div>
          ))}
          {row('Total voided', money(report.kitchenVoids!.summary.value))}
          {report.kitchenVoids!.summary.cookedValue > 0 && row('Of which already made', money(report.kitchenVoids!.summary.cookedValue))}
        </>
      )}

      {/* A363: never close a day without seeing what is still only on this till. */}
      {zBackupNote(report.notBackedUp) && (
        <>
          {rule}
          <p data-testid="z-not-backed-up" style={{ fontWeight: 'bold' }}>{zBackupNote(report.notBackedUp)}</p>
        </>
      )}

      {/* A365: the manager's confirmation — who, when, each method's recount; or that it awaits a manager. */}
      {report.confirmation && (
        <>
          {rule}
          <div data-testid="z-confirmation">
            {confirmationPrintLines(report.confirmation, (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
              .map((l, i) => <p key={i} style={i === 0 ? { fontWeight: 'bold' } : undefined}>{l}</p>)}
          </div>
        </>
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
