// SwiftPOS eTIMS — public API.
//
// The rest of the app only calls these three functions. They are non-blocking
// with respect to the sale: callers fire-and-forget (.catch) exactly like
// fireWebhook(). Eligibility (provider on + business flag + branch registered)
// is resolved here; if ineligible the invoice is recorded as 'skipped' so there
// is still an audit row, and nothing is transmitted.

import { supabase } from '../supabase';
import { encryptSecret, decryptSecret } from '../crypto';
import { etimsEnabledGlobally, getProvider } from './provider';
import { transmit } from './queue';
import type { EtimsInvoiceDTO, EtimsInvoiceType, EtimsBranchConfig, EtimsLine } from './types';

// ── Eligibility ──────────────────────────────────────────────────────────────
async function getBranchConfig(branchId: string): Promise<EtimsBranchConfig | null> {
  const { data } = await supabase
    .from('etims_branch_config').select('*').eq('branch_id', branchId).maybeSingle();
  if (!data) return null;
  return {
    id: data.id, businessId: data.business_id, branchId: data.branch_id,
    environment: data.environment, mode: data.mode, bhfId: data.bhf_id,
    deviceSerial: data.device_serial, cmcKey: data.cmc_key ? safeDecrypt(data.cmc_key) : null, sdcId: data.sdc_id,
    lastInvoiceNo: data.last_invoice_no, status: data.status,
  };
}

// Decrypt without throwing — a key/format problem shouldn't crash the order flow;
// the provider will simply get a null/blank key and the transmission will fail
// into the retry queue where it's visible.
function safeDecrypt(v: string): string | null {
  try { return decryptSecret(v); } catch { return null; }
}

async function businessFlagEnabled(businessId: string): Promise<boolean> {
  const { data } = await supabase
    .from('feature_flags').select('enabled')
    .eq('business_id', businessId).eq('key', 'etims_enabled').maybeSingle();
  return !!data?.enabled;
}

// ── DTO builder (also reused by the retry worker) ────────────────────────────
export async function buildInvoiceDTO(
  orderId: string,
  invoiceType: EtimsInvoiceType,
): Promise<EtimsInvoiceDTO | null> {
  const { data: order } = await supabase
    .from('orders')
    .select('id, business_id, branch_id, subtotal, vat_amount, discount_amount, total, customer_name, customer_phone')
    .eq('id', orderId)
    .single();
  if (!order) return null;

  const branch = await getBranchConfig(order.branch_id);
  if (!branch) return null;

  const { data: biz } = await supabase
    .from('businesses').select('tax_pin').eq('id', order.business_id).single();

  const { data: items } = await supabase
    .from('order_items')
    .select('product_id, product_name, quantity, unit_price, subtotal')
    .eq('order_id', orderId);

  // Pull tax_type + class code for the catalogue products on this order.
  const productIds = (items ?? []).map((i: any) => i.product_id).filter(Boolean);
  const taxMap = new Map<string, { taxType: string; itemClassCode: string | null }>();
  if (productIds.length) {
    const { data: prods } = await supabase
      .from('products').select('id, tax_type, kra_item_class_code').in('id', productIds);
    (prods ?? []).forEach((p: any) =>
      taxMap.set(p.id, { taxType: p.tax_type ?? 'B', itemClassCode: p.kra_item_class_code ?? null }));
  }

  const lines: EtimsLine[] = (items ?? []).map((i: any) => {
    const tax = (i.product_id && taxMap.get(i.product_id)) || { taxType: 'B', itemClassCode: null };
    return {
      name: i.product_name,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unit_price),
      lineTotal: Number(i.subtotal),
      taxType: tax.taxType,
      itemClassCode: tax.itemClassCode,
    };
  });

  // Credit notes reference the original signed sale's KRA receipt + invoice number.
  let originalReceiptNo: string | null = null;
  let originalInvoiceNo: number | null = null;
  if (invoiceType === 'credit') {
    const { data: orig } = await supabase
      .from('etims_invoices')
      .select('kra_receipt_no, invoice_no')
      .eq('order_id', orderId).eq('invoice_type', 'sale').eq('status', 'signed')
      .maybeSingle();
    originalReceiptNo = orig?.kra_receipt_no ?? null;
    originalInvoiceNo = orig?.invoice_no ?? null;
  }

  return {
    invoiceType,
    invoiceNo: branch.lastInvoiceNo + 1,
    sellerPin: biz?.tax_pin ?? '',
    branch,
    buyerName: order.customer_name ?? null,
    buyerPhone: order.customer_phone ?? null,
    lines,
    subtotal: Number(order.subtotal),
    vatAmount: Number(order.vat_amount),
    discountAmount: Number(order.discount_amount),
    total: Number(order.total),
    originalReceiptNo,
    originalInvoiceNo,
  };
}

// ── Internal: create the ledger row + transmit ───────────────────────────────
async function fiscalise(orderId: string, invoiceType: EtimsInvoiceType): Promise<void> {
  const { data: order } = await supabase
    .from('orders').select('business_id, branch_id').eq('id', orderId).single();
  if (!order) return;

  // Ineligible → record a 'skipped' audit row, transmit nothing.
  const eligible =
    etimsEnabledGlobally() &&
    (await businessFlagEnabled(order.business_id)) &&
    (await getBranchConfig(order.branch_id))?.status === 'registered';

  if (!eligible) {
    await supabase.from('etims_invoices').insert({
      business_id: order.business_id, branch_id: order.branch_id, order_id: orderId,
      invoice_type: invoiceType, status: 'skipped',
    });
    return;
  }

  const dto = await buildInvoiceDTO(orderId, invoiceType);
  if (!dto) return;

  // Reserve our per-branch invoice number (read-increment; swap for an RPC if
  // concurrent fiscalisation within one branch becomes a real risk).
  await supabase
    .from('etims_branch_config')
    .update({ last_invoice_no: dto.invoiceNo, updated_at: new Date().toISOString() })
    .eq('branch_id', dto.branch.branchId);

  const { data: row } = await supabase
    .from('etims_invoices')
    .insert({
      business_id: order.business_id, branch_id: order.branch_id, order_id: orderId,
      invoice_type: invoiceType, status: 'pending', invoice_no: dto.invoiceNo,
      request_payload: dto as any,
    })
    .select('id')
    .single();

  if (row) await transmit(row.id, dto);
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function fiscaliseInvoice(orderId: string): Promise<void> {
  return fiscalise(orderId, 'sale');
}

export async function fiscaliseCreditNote(orderId: string): Promise<void> {
  return fiscalise(orderId, 'credit');
}

export async function registerBranch(branchId: string): Promise<{ ok: boolean; error?: string }> {
  const branch = await getBranchConfig(branchId);
  if (!branch) return { ok: false, error: 'No eTIMS config for this branch' };

  const { data: biz } = await supabase
    .from('businesses').select('tax_pin').eq('id', branch.businessId).single();

  try {
    const r = await getProvider().registerBranch(branch, biz?.tax_pin ?? '');
    await supabase.from('etims_branch_config').update({
      bhf_id: r.bhfId, device_serial: r.deviceSerial,
      cmc_key: r.cmcKey ? encryptSecret(r.cmcKey) : null, sdc_id: r.sdcId,
      status: 'registered', registered_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('branch_id', branchId);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'registration failed' };
  }
}
