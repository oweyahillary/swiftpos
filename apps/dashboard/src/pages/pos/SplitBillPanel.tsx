/**
 * SplitBillPanel — "Split the bill" on the web POS (A151; owner decision 2026-11-04: one design for both POS): evenly
 * per person or by item per guest — the choosing is @zaptill/ui BillSplit, the same piece as the desktop POS's. Below
 * the shares, each person's method (cash, M-Pesa, card — what the branch takes) and, for M-Pesa, the code or the M-Pesa
 * prompt; Charge pays the ONE order in full with one payment per person (PaymentModal.handleSplitCharge → the cloud's
 * reconcile guard), never sub-orders. On account is not offered: it is one customer's account, not each person's share.
 * Replaces EvenSplitPanel and ByItemSplitPanel.
 */
import { useState } from 'react';
import BillSplit, { type BillLine, type SplitWay } from '@zaptill/ui/BillSplit';
import type { PaymentLeg, PaymentMethod } from './SplitPaymentPanel';
import MpesaStkPanel from './MpesaStkPanel';
import { BILL_SPLIT_LOOK } from './paymentLooks';

const METHODS: { id: PaymentMethod; label: string; icon: string }[] = [
  { id: 'cash',  label: 'Cash',   icon: '💵' },
  { id: 'mpesa', label: 'M-Pesa', icon: '📱' },
  { id: 'card',  label: 'Card',   icon: '💳' },
];

interface Part { method: PaymentMethod; reference: string; prompted: boolean; prompting: boolean }
const blank = (method: PaymentMethod): Part => ({ method, reference: '', prompted: false, prompting: false });
const uid = () => Math.random().toString(36).slice(2, 8);
const fmt = (a: number, c: string) => `${c} ${a.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function SplitBillPanel({ total, lines, currency, enabledMethods, initialWay, onConfirm, onCancel }: {
  total: number;
  lines: BillLine[];
  currency: string;
  /** A429: the methods the branch takes; absent = all three. */
  enabledMethods?: string[];
  initialWay?: SplitWay;
  onConfirm: (legs: PaymentLeg[]) => void;
  onCancel?: () => void;
}) {
  const methods = METHODS.filter((m) => !enabledMethods || enabledMethods.includes(m.id));
  const first = methods[0]?.id ?? 'cash';
  // One entry per person, by position (a person added later starts on the first method).
  const [parts, setParts] = useState<Part[]>([]);
  const part = (i: number) => parts[i] ?? blank(first);
  const setPart = (i: number, patch: Partial<Part>) => setParts((prev) => {
    const out = [...prev];
    while (out.length <= i) out.push(blank(first));
    out[i] = { ...out[i], ...patch };
    return out;
  });

  return (
    <BillSplit total={total} lines={lines} initialWay={initialWay} format={(n) => fmt(n, currency)} look={BILL_SPLIT_LOOK}>
      {(shares, ready) => {
        const charge = () => onConfirm(shares.flatMap((sh, i) => (sh.amount > 0 ? [{
          id: uid(), method: part(i).method, amount: sh.amount,
          reference: part(i).method === 'mpesa' ? (part(i).reference || undefined) : undefined,
          prompted: part(i).method === 'mpesa' && part(i).prompted,
        }] : [])));
        return (
          <>
            <div className="space-y-2">
              {shares.map((sh, i) => (
                <div key={i} className={`rounded-xl p-3 border ${sh.amount > 0 ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-900/40 border-gray-800 opacity-50'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-300">{sh.who}</span>
                    <span className="text-sm font-semibold text-white">{fmt(sh.amount, currency)}</span>
                  </div>
                  {sh.amount > 0 && (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        {methods.map((m) => (
                          <button key={m.id} type="button" onClick={() => setPart(i, { method: m.id })}
                            className={`py-2 rounded-lg text-xs font-medium border transition-colors ${part(i).method === m.id
                              ? 'bg-action-500/10 border-action-500 text-action-400'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'}`}>
                            {m.icon} {m.label}
                          </button>
                        ))}
                      </div>
                      {part(i).method === 'mpesa' && (part(i).prompting ? (
                        <div className="mt-2">
                          <MpesaStkPanel total={sh.amount} currency={currency}
                            onSuccess={(ref, prompted) => setPart(i, { reference: ref, prompted, prompting: false })}
                            onCancel={() => setPart(i, { prompting: false })} />
                        </div>
                      ) : (
                        <div className="mt-2 flex gap-2">
                          <input value={part(i).reference} placeholder="M-Pesa code (optional)"
                            onChange={(e) => setPart(i, { reference: e.target.value.toUpperCase(), prompted: false })}
                            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600" />
                          {!part(i).prompted && (
                            <button type="button" onClick={() => setPart(i, { prompting: true })} data-testid="split-stk"
                              className="px-3 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-200">Send prompt</button>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm text-gray-400">Total</span>
              <span className="text-sm font-semibold text-white">{fmt(total, currency)}</span>
            </div>
            <div className="flex gap-2">
              {onCancel && (
                <button type="button" onClick={onCancel} className="flex-1 py-3 rounded-xl bg-gray-800 text-gray-300 text-sm font-medium">Cancel</button>
              )}
              <button type="button" onClick={charge} disabled={!ready || parts.some((p) => p.prompting)}
                className="flex-[2] py-3 rounded-xl bg-action-600 text-white text-sm font-bold disabled:opacity-40">
                {ready ? `Charge ${fmt(total, currency)} · ${shares.filter((x) => x.amount > 0).length} ways` : 'Put items on at least 2 guests'}
              </button>
            </div>
          </>
        );
      }}
    </BillSplit>
  );
}
