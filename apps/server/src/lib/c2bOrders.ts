/**
 * c2bOrders.ts — A621: an order reached the cloud (routes/orders.ts — a sale, or the payment of an open bill): the M-Pesa
 * codes on its payment legs mark those M-Pesa payments used, so they leave every POS's list and the owner's unmatched list.
 * A code typed by hand counts as much as one tapped. Never throws and never fails the sale (the sale is already safe).
 */
import { mpesaCodesOf } from './c2b';
import { markPaymentsUsed } from './c2bStore';
import { noteC2bChange } from './c2bActivity';

export async function markOrderPayments(businessId: string, orderId: string, legs: Array<{ method?: unknown; reference?: unknown }>): Promise<void> {
  const codes = mpesaCodesOf(legs);
  if (!codes.length) return;
  try {
    const branches = await markPaymentsUsed(businessId, orderId, codes);
    for (const branchId of branches) noteC2bChange(branchId);
  } catch (e: any) {
    console.error(`[c2b] A621: order ${orderId}'s M-Pesa payments were not marked used:`, e?.message ?? e);
  }
}
