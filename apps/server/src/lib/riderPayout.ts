/**
 * riderPayout.ts — 0.6.27 (a prospect's request 3): on a WEB sale with a delivery fee, the rider is paid the fee in cash
 * from that shift's drawer — recorded as a pay-out tied to the sale (float_transactions.order_id, migration 111), so
 * expected cash is the fee lower while the method the customer paid with carries it. The till records its own sales'
 * pay-outs itself (they reach the cloud as ordinary pay-outs), so this runs only for sales that did not come from a till.
 * Voiding the sale puts it back while the shift is open. Never fails the sale or the void: a failure is logged.
 */
import { supabase } from './supabase';
import { cleanDeliveryFee, riderPayoutReason } from './delivery';

export async function payRider(o: { orderId: string; orderNumber: string | null; shiftId: string | null; branchId: string;
                                    cashierId: string | null; fee: unknown; rider: string | null }): Promise<boolean> {
  const fee = cleanDeliveryFee(o.fee);
  if (fee <= 0 || !o.shiftId || !o.cashierId) return false;
  const { error } = await supabase.from('float_transactions').insert({
    shift_id: o.shiftId, branch_id: o.branchId, cashier_id: o.cashierId, type: 'float_out', amount: fee,
    reason: riderPayoutReason(o.rider, o.orderNumber), order_id: o.orderId,
  });
  if (error) { console.error('[rider-payout] the rider\'s pay-out was not recorded:', error.message); return false; }
  return true;
}

/** A voided sale's rider pay-out goes back in (a pay-in), once, while its shift is open. Returns the amount. */
export async function returnRiderPayout(orderId: string): Promise<number> {
  const { data: outs } = await supabase.from('float_transactions')
    .select('id, shift_id, branch_id, cashier_id, amount, type').eq('order_id', orderId);
  const out = (outs ?? []).find((f: any) => f.type === 'float_out');
  if (!out || (outs ?? []).some((f: any) => f.type === 'float_in')) return 0;
  const { data: shift } = await supabase.from('shifts').select('status').eq('id', out.shift_id).maybeSingle();
  if (shift?.status !== 'open') return 0;
  const { error } = await supabase.from('float_transactions').insert({
    shift_id: out.shift_id, branch_id: out.branch_id, cashier_id: out.cashier_id, type: 'float_in', amount: Number(out.amount),
    reason: 'Delivery fee back — sale voided', order_id: orderId,
  });
  if (error) { console.error('[rider-payout] the voided sale\'s rider pay-out was not put back:', error.message); return 0; }
  return Number(out.amount);
}
