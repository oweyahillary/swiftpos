/**
 * useMpesaClaims.ts — A621: the M-Pesa payments the WEB POS's payment screen has taken (POST /api/payments/c2b/claim), so
 * it can give them back when they leave the bill (the split cancelled, the payment screen closed without a sale). Taken
 * payments stay this sale's until then — no other POS can tap them. The desktop POS has its own (renderer/lib).
 */
import { useRef } from 'react';
import { api } from '../../lib/api';
import { claimRefusalText, newSaleRef, type ReceivedPayment } from '../../lib/mpesaPayments';

export function useMpesaClaims() {
  const saleRef = useRef(newSaleRef()).current;
  const held = useRef(new Set<string>());

  /** Takes a payment for this sale → the payment, or the cashier's words for why not. */
  const take = async (p: ReceivedPayment): Promise<{ payment: ReceivedPayment } | { error: string }> => {
    try {
      const r = await api.post<{ ok: true; payment: ReceivedPayment }>('/api/payments/c2b/claim', { trans_id: p.trans_id, sale_ref: saleRef });
      held.current.add(r.payment.trans_id);
      return { payment: r.payment };
    } catch (e: any) {
      return { error: claimRefusalText(e?.code, e?.message) };
    }
  };

  /** Gives back every taken payment whose code is not among `codes`. Best effort — one not given back shows as held. */
  const keepOnly = (codes: Array<string | null | undefined>) => {
    for (const transId of [...held.current]) {
      if (codes.includes(transId)) continue;
      held.current.delete(transId);
      void api.post('/api/payments/c2b/release', { trans_id: transId, sale_ref: saleRef }).catch(() => {});
    }
  };

  const giveBackAll = () => keepOnly([]);
  const isTaken = (transId: string | null | undefined) => !!transId && held.current.has(transId);

  return { take, keepOnly, giveBackAll, isTaken };
}
