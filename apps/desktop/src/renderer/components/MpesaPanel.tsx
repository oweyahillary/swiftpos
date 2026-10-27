import { useEffect, useState } from 'react';
import { posApi, type MpesaReceiveLite } from '../lib/posApi';
import { MPESA_KINDS, cleanMpesaReceive, mpesaDescribe, type MpesaKind } from '@zaptill/core/mpesaReceive';

// A492 — Manager → Settings → M-Pesa: the number this branch's customers pay to, printed on every receipt.
// Owner, 2026-10-15: "each branch has a till number or paybill number … that should be set on the desktop app not web,
// the manager should be the one doing it not the owner, if its paybill they have to set an account number if its buy
// goods they dont have to". Saved on the cloud for the branch (it needs a connection): this till prints it at once, the
// branch's other tills within a minute. The owner is told of every change — it is where customers' money goes.
export default function MpesaPanel() {
  const [own, setOwn] = useState<MpesaReceiveLite | null>(null);
  const [inherited, setInherited] = useState<MpesaReceiveLite | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<MpesaKind>('buy_goods');
  const [number, setNumber] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const fill = (v: MpesaReceiveLite | null) => {
    setKind(v?.kind ?? 'buy_goods'); setNumber(v?.number ?? ''); setAccount(v?.account ?? '');
  };

  useEffect(() => {
    posApi.manage.getMpesa()
      .then((r) => { setOwn(r.own); setInherited(r.inherited); setCanEdit(r.canEdit); fill(r.own); })
      .catch((e: any) => setError(e?.message ?? 'Could not read the M-Pesa number — it needs a connection.'))
      .finally(() => setLoaded(true));
  }, []);

  const meta = MPESA_KINDS.find((k) => k.kind === kind)!;
  const unchanged = own ? own.kind === kind && own.number === number.trim() && (own.account ?? '') === (kind === 'paybill' ? account.trim() : '')
    : !number.trim();

  const save = async () => {
    if (!canEdit || busy) return;
    const c = cleanMpesaReceive({ kind, number, account });
    if ('error' in c) { setError(c.error); return; }
    setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setMpesa({ kind: c.value.kind, number: c.value.number, account: c.value.account ?? undefined });
      setOwn(c.value); fill(c.value);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="mpesa-panel">
      <h3 className="text-sm font-semibold text-white">M-Pesa for this branch</h3>
      <p className="mt-1 text-xs text-gray-400">
        The number customers pay this branch to. It is printed on every receipt. The owner is told whenever it changes.
      </p>

      {!loaded ? <p className="mt-3 text-sm text-gray-400">Loading…</p> : (
        <div className="mt-3 space-y-3">
          {!own && inherited && (
            <p className="text-xs text-gray-400" data-testid="mpesa-inherited">
              Until this branch has its own, receipts print the business's: {mpesaDescribe(inherited)}.
            </p>
          )}
          {own && !canEdit && <p className="text-sm text-gray-200">{mpesaDescribe(own)}</p>}

          {canEdit && (
            <>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How customers pay">
                {MPESA_KINDS.map((k) => (
                  <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} disabled={busy}
                    onClick={() => { setKind(k.kind); setError(''); }} data-testid={`mpesa-kind-${k.kind}`}
                    className={`rounded-lg border px-3 py-2 text-sm text-left ${kind === k.kind
                      ? 'border-action-500 bg-action-500/10 text-white' : 'border-gray-700 text-gray-300 hover:bg-gray-800/60'}`}>
                    {k.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400">{meta.help}</p>

              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">{meta.numberLabel}</span>
                <input inputMode="numeric" autoComplete="off" value={number} disabled={busy} maxLength={8}
                  onChange={(e) => { setNumber(e.target.value.replace(/[^\d]/g, '')); setError(''); }} data-testid="mpesa-number"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white" />
              </label>

              {kind === 'paybill' && (
                <label className="block">
                  <span className="block text-xs text-gray-400 mb-1">Account number</span>
                  <input autoComplete="off" value={account} disabled={busy} maxLength={20}
                    onChange={(e) => { setAccount(e.target.value); setError(''); }} data-testid="mpesa-account"
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white" />
                </label>
              )}

              <div className="flex items-center gap-3">
                <button type="button" onClick={() => void save()} disabled={busy || unchanged} data-testid="mpesa-save"
                  className="rounded-lg bg-action-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-action-400 disabled:opacity-40">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="text-xs text-gray-300">Saved — receipts print it now.</span>}
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-300" data-testid="mpesa-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
