/**
 * MpesaNotificationsSettings — A621: Settings › Business › Integrations › M-Pesa, below the STK details: "Payment
 * notifications" per branch. The owner's only.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." Per branch:
 *   - the switch;
 *   - Buy Goods: the STORE number (head office shortcode) Safaricom registers — not the Till number on the receipt; blank
 *     uses the STK details' shortcode;
 *   - Register with Safaricom, and the result — with the warning that a number reports its payments to ONE place;
 *   - Sandbox only: "Send a test payment", so the owner sees it reach the POS without real money.
 * Part of the online licence: without it the screen says so and offers nothing but switching off.
 * The cloud (routes/c2bSettings.ts) never sends the branch's secret token.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';

interface BranchC2b {
  id: string; name: string; enabled: boolean; storeNumber: string | null;
  mpesaType: string | null; stkShortcode: string | null; environment: string | null;
  registeredAt: string | null; registeredShortcode: string | null; registeredEnvironment: string | null; lastError: string | null;
}
interface C2bSettings { serverEnvironment: string; table: boolean; licensed: boolean; branches: BranchC2b[] }

const card = 'rounded-xl border border-gray-800 bg-gray-900';
const input = 'w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-swift';
const btn = 'rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-40';
const warn = 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300';

const envName = (e: string | null) => (e === 'production' ? 'Live' : 'Sandbox');

/** "Registered for Buy Goods store 174379 (Live) on 3 Nov 2026, 10:05" — or what is missing. */
function registrationLine(b: BranchC2b): string {
  if (!b.mpesaType) return 'Save the M-Pesa (STK push) details for this branch first — Safaricom is asked with them.';
  if (!b.registeredAt || !b.registeredShortcode) return 'Not registered with Safaricom yet.';
  return `Registered for ${b.registeredShortcode} (${envName(b.registeredEnvironment)}) on ${dateTime(b.registeredAt)}.`;
}

function BranchRow({ b, licensed, onChanged }: { b: BranchC2b; licensed: boolean; onChanged: () => Promise<void> }) {
  const [store, setStore] = useState(b.storeNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const buyGoods = b.mpesaType === 'CustomerBuyGoodsOnline';

  const run = async (work: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await work() }); await onChanged(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Something went wrong' }); }
    finally { setBusy(false); }
  };
  const save = (enabled: boolean) => run(async () => {
    await api.put(`/api/mpesa/c2b-settings/branches/${b.id}`, { enabled, store_number: buyGoods ? store : '' });
    return enabled ? 'Saved — now register with Safaricom.' : 'Payment notifications are off for this branch.';
  });
  const register = () => run(async () => {
    const r = await api.post<{ shortcode: string; environment: string }>(`/api/mpesa/c2b-settings/branches/${b.id}/register`, {});
    return `Safaricom will report payments to ${r.shortcode} (${envName(r.environment)}).`;
  });
  const testPayment = () => run(async () => {
    const r = await api.post<{ amount: number }>(`/api/mpesa/c2b-settings/branches/${b.id}/test-payment`, { amount: 1 });
    return `Test payment of ${money(r.amount, 'KES', { decimals: 'auto' })} sent — it shows on this branch's POS in a few seconds.`;
  });

  const sandboxReady = b.registeredEnvironment === 'sandbox' && b.environment === 'sandbox';
  return (
    <div className={`${card} p-4 space-y-2`} data-testid="c2b-branch">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-white">{b.name}</p>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={b.enabled} disabled={busy || (!licensed && !b.enabled)} onChange={(e) => void save(e.target.checked)} />
          Payment notifications
        </label>
      </div>
      {b.enabled && (
        <>
          {buyGoods && (
            <label className="block text-xs text-gray-400">Buy Goods store number (head office shortcode — not the Buy Goods Till number on the receipt; blank: {b.stkShortcode ?? 'the STK shortcode'})
              <div className="mt-1 flex gap-2">
                <input className={input} inputMode="numeric" value={store} onChange={(e) => setStore(e.target.value)} placeholder={b.stkShortcode ?? ''} />
                <button className={btn} disabled={busy} onClick={() => void save(true)}>Save</button>
              </div>
            </label>
          )}
          <p className="text-xs text-gray-400">{registrationLine(b)}</p>
          {b.lastError && <p className="text-xs text-red-400">Safaricom's last answer: {b.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy || !licensed || !b.mpesaType} onClick={() => void register()}>
              {b.registeredAt ? 'Register again' : 'Register with Safaricom'}
            </button>
            {sandboxReady && <button className={btn} disabled={busy} onClick={() => void testPayment()}>Send a test payment (sandbox)</button>}
          </div>
        </>
      )}
      {msg && <p className={`text-xs ${msg.ok ? 'text-swift' : 'text-red-400'}`}>{msg.text}</p>}
    </div>
  );
}

export default function MpesaNotificationsSettings() {
  const [data, setData] = useState<C2bSettings | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.get<C2bSettings>('/api/mpesa/c2b-settings')); setError(''); }
    catch (e: any) { setError(e?.message ?? 'Could not load the payment notifications'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading payment notifications…</p>;

  return (
    <div className="space-y-3" data-testid="mpesa-c2b-settings">
      <div>
        <h2 className="text-lg font-semibold text-white">Payment notifications</h2>
        <p className="text-sm text-gray-400 mt-1">
          When a customer pays the branch's Till number or Paybill themselves, the POS lists the payment and the cashier
          taps it to put it on the bill — no phone number needed. Needs internet on the POS.
        </p>
      </div>
      {!data.licensed && <p className={warn}>Payment notifications are part of the ZapTill online licence — contact ZapTill to enable it.</p>}
      {!data.table && <p className={warn}>Payment notifications need the latest database update (migration 188).</p>}
      <p className={warn}>
        Safaricom reports a number's payments to ONE place. If your bank or accounting system already receives payment
        notifications for this Paybill or Till number, registering here stops theirs — check with them first.
      </p>
      {data.table && data.branches.map((b) => <BranchRow key={b.id} b={b} licensed={data.licensed} onChanged={load} />)}
    </div>
  );
}
