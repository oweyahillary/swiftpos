/**
 * batchStore.ts — A413: write a batch when stock is received (product restock, ingredient add, goods-received note).
 *
 * Receiving never fails because of a batch: the stock has already moved when this runs, so a batch that cannot be
 * written (bad date, migration 126 not applied yet) is logged and reported back, never thrown.
 */
import { supabase } from './supabase';
import { cleanExpiry, cleanBatchNo } from './batches';

export interface ReceivedBatch {
  businessId: string; branchId: string;
  kind: 'product' | 'ingredient'; itemId: string;
  quantity: number;                       // in the unit the branch holds the item in (pieces for a by-piece product)
  expiry?: unknown; batchNo?: unknown;
  source: 'restock' | 'grn' | 'manual' | 'transfer'; sourceRef?: string | null;
  by: { id: string | null; name: string };
}

/** True when the person gave an expiry date or a batch number — otherwise nothing is recorded. */
export function wantsBatch(expiry: unknown, batchNo: unknown): boolean {
  return (expiry !== undefined && expiry !== null && String(expiry).trim() !== '') || !!cleanBatchNo(batchNo);
}

export async function recordReceivedBatch(b: ReceivedBatch): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const expiry = cleanExpiry(b.expiry, today);
  if (expiry === 'bad') return { ok: false, error: 'The expiry date is not a real date (YYYY-MM-DD).' };
  if (!(b.quantity > 0)) return { ok: false, error: 'Nothing was received.' };
  const { data, error } = await supabase.from('stock_batches').insert({
    business_id: b.businessId, branch_id: b.branchId, item_kind: b.kind,
    product_id: b.kind === 'product' ? b.itemId : null, ingredient_id: b.kind === 'ingredient' ? b.itemId : null,
    batch_no: cleanBatchNo(b.batchNo), expiry_date: expiry, quantity_received: Math.round(b.quantity * 1000) / 1000,
    source: b.source, source_ref: b.sourceRef ?? null, created_by: b.by.id, created_by_name: b.by.name,
  }).select('id').single();
  if (error || !data) {
    console.error('[batches] batch not recorded:', error?.message ?? 'no row');
    return { ok: false, error: 'The stock was received, but its expiry date could not be saved — add it on Stock › Expiry.' };
  }
  return { ok: true, id: (data as { id: string }).id };
}
