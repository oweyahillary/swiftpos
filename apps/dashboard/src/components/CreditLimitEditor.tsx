import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { limitFromInput, limitRequest } from '../lib/creditLimit';
import { useSetsLimits } from '../hooks/useSetsLimits';   // A585, A587

/**
 * CreditLimitEditor — A567: a customer's credit limit on their own profile (Customers › a customer). Someone with
 * customers.credit gives or changes it there; the cloud records who approved it and when. Without the key: the limit is
 * shown (when they may read credit), never a box.
 * A585 (owner, 2026-10-23: "credit limit — the owner for now"): the OWNER only — anyone else sees the limit and the line
 * "Only the owner or a manager sets credit limits." (the cloud refuses them too). On the dashboard (the owner and partners) only
 * the owner edits: partners are refused; managers set limits on the web POS manager screen (A585 owner change).
 * A587 (owner, 2026-10-24): a partner too, with ONE of their branches picked (not "All my branches" — the line says to
 * pick one); the cloud records the branch.
 */
export default function CreditLimitEditor({ customerId, currency }: { customerId: string; currency: string }) {
  const { setsLimits: mayCredit, line } = useSetsLimits();   // A585: the owner; A587: a partner at one of their branches
  const [limit, setLimit] = useState<number | null>(null);
  const [balance, setBalance] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    setLimit(null); setMsg(null);
    api.get<{ customer: { credit_limit: number; credit_balance: number } }>(`/api/credit/customer/${customerId}`)
      .then(({ customer }) => {
        if (!live) return;
        setLimit(Number(customer.credit_limit) || 0); setBalance(Number(customer.credit_balance) || 0);
        setText(String(Number(customer.credit_limit) || 0));
      })
      .catch(() => { if (live) setLimit(null); });
    return () => { live = false; };
  }, [customerId]);

  const save = async () => {
    const r = limitFromInput(text);
    if (r.ok === false) { setMsg({ kind: 'err', text: r.error }); return; }
    setBusy(true); setMsg(null);
    try {
      const req = limitRequest(customerId, r.value);
      const saved = await api.patch<{ credit_limit: number; credit_balance: number }>(req.path, req.body);
      setLimit(Number(saved.credit_limit) || 0); setBalance(Number(saved.credit_balance) || 0);
      setMsg({ kind: 'ok', text: r.value > 0 ? `Credit limit set to ${money(r.value, currency)}. They now show in Credit Accounts and at the points of sale.` : 'Credit limit removed.' });
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Could not save the credit limit.' }); }
    finally { setBusy(false); }
  };

  if (limit === null && !mayCredit) return null;
  return (
    <div className="px-5 py-4 border-b border-gray-800/60" data-testid="customer-credit-limit">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-400 font-medium">Credit limit</p>
        {limit !== null && balance > 0 && <p className="text-xs text-yellow-400">Owes {money(balance, currency)}</p>}
      </div>
      {mayCredit ? (
        <div className="flex items-end gap-2">
          <input type="number" min={0} value={text} onChange={e => setText(e.target.value)} placeholder="0 = no credit"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-swift" />
          <button onClick={() => void save()} disabled={busy || limit === null}
            className="px-4 py-2 bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 text-sm font-bold rounded-lg">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <>
          <p className="text-white text-sm">{limit ? money(limit, currency) : 'No credit'}</p>
          <p className="text-xs text-gray-500 mt-1" data-testid="owner-sets-limits">{line}</p>
        </>
      )}
      {msg && <p className={`text-xs mt-2 ${msg.kind === 'ok' ? 'text-gray-300' : 'text-red-400'}`}>{msg.text}</p>}
    </div>
  );
}
