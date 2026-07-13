// SwiftPOS eTIMS — transmission + status management.
//
// transmit() is the single choke point that talks to the provider and moves an
// etims_invoices row through its lifecycle. It NEVER throws to its caller — a
// fiscalisation problem must never block or fail a completed sale. Failures are
// persisted as status='failed' for the retry worker; an unconfigured provider
// is persisted as status='skipped'.

import { supabase } from '../supabase';
import { getProvider } from './provider';
import { EtimsNotConfiguredError, type EtimsInvoiceDTO } from './types';

export async function transmit(etimsRowId: string, dto: EtimsInvoiceDTO): Promise<void> {
  const provider = getProvider();
  try {
    await supabase
      .from('etims_invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', etimsRowId);

    const result = dto.invoiceType === 'credit'
      ? await provider.sendCreditNote(dto)
      : await provider.sendInvoice(dto);

    await supabase
      .from('etims_invoices')
      .update({
        status:           'signed',
        kra_receipt_no:   result.receiptNo,
        kra_internal_data: result.internalData,
        kra_signature:    result.signature,
        qr_payload:       result.qrPayload,
        response_payload: result.raw as any,
        signed_at:        new Date().toISOString(),
        error:            null,
      })
      .eq('id', etimsRowId);
  } catch (err: any) {
    const skipped = err instanceof EtimsNotConfiguredError;
    // Bump retry_count on real failures only.
    const { data: row } = await supabase
      .from('etims_invoices').select('retry_count').eq('id', etimsRowId).single();
    await supabase
      .from('etims_invoices')
      .update({
        status:      skipped ? 'skipped' : 'failed',
        error:       skipped ? null : (err?.message ?? 'transmission failed'),
        retry_count: skipped ? (row?.retry_count ?? 0) : (row?.retry_count ?? 0) + 1,
      })
      .eq('id', etimsRowId);
    if (!skipped) console.error('[etims] transmission failed:', err?.message);
  }
}

// Retry worker entry point (wire to a cron later, like dailySummary). Reprocesses
// failed/sent rows that never reached 'signed'. Rebuilds the DTO via the lazy
// import to avoid a circular dependency with index.ts.
export async function processPending(maxBatch = 50): Promise<{ retried: number }> {
  const { data: rows } = await supabase
    .from('etims_invoices')
    .select('id, order_id, invoice_type')
    .in('status', ['failed', 'sent'])
    .lt('retry_count', 5)
    .order('created_at', { ascending: true })
    .limit(maxBatch);

  if (!rows?.length) return { retried: 0 };

  const { buildInvoiceDTO } = await import('./index');
  let retried = 0;
  for (const r of rows) {
    const dto = await buildInvoiceDTO(r.order_id, r.invoice_type as 'sale' | 'credit');
    if (dto) { await transmit(r.id, dto); retried++; }
  }
  return { retried };
}
