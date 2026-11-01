/**
 * MpesaStkSettings — A618: Settings › Business › Integrations › M-Pesa (STK push). The owner's only.
 *
 * Owner, 2026-11-01: "it should be per branch since different branches might have different payment method some paybill
 * some buy goods". The Daraja details (Lipa Na M-Pesa Online) that send the payment prompt to a customer's phone: the
 * business default, and a branch's own where it differs. Until now they could be put in only by SQL.
 *
 *   - The default card and a row per branch ("Own settings" / "Uses the business default"); Edit opens the form.
 *   - The form: Paybill or Buy Goods; the shortcode (Buy Goods: the store number, and the Buy Goods Till number customers pay
 *     to); the consumer key; the consumer secret and the passkey (password fields, blank = keep the saved one); Sandbox or
 *     Live. Save, Test connection (a Daraja token — nobody is charged), Remove own (a branch: back to the default).
 *   - A warning when a branch's receipt M-Pesa line (set on the POS: Manager › Settings › M-Pesa, A492) names another
 *     number than the one STK payments go to.
 * The cloud (routes/mpesaSettings.ts) never sends a secret, the passkey or the whole key — only whether each is saved.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

type MpesaType = 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
type Environment = 'sandbox' | 'production';

interface MpesaStatus {
  configured: boolean; type: string | null; shortcode: string | null; tillNumber: string | null; environment: string | null;
  keyLast4: string | null; secretSaved: boolean; passkeySaved: boolean; updatedAt: string | null; updatedBy: string | null;
}
interface BranchLine {
  id: string; name: string; own: MpesaStatus | null; uses: 'own' | 'default' | 'none';
  paysTo: string | null; receipt: string | null; receiptWarning: string | null;
}
interface MpesaSettings { serverEnvironment: Environment; branchTable: boolean; default: MpesaStatus; branches: BranchLine[] }

/** Which details the form edits: the default, or a branch's own. */
type Target = { kind: 'default' } | { kind: 'branch'; id: string; name: string };

const card = 'rounded-xl border border-gray-800 bg-gray-900';
const input = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift';
const btn = 'rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-40';
const warn = 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300';

const envLabel = (e: string | null) => (e === 'production' ? 'Live' : e === 'sandbox' ? 'Sandbox (testing)' : 'not recorded');

/** "Paybill 174379" / "Buy Goods 163726 (store 174379)". */
export function describeStatus(s: MpesaStatus | null): string {
  if (!s || !s.shortcode) return 'Not set up';
  if (s.type === 'CustomerPayBillOnline') return `Paybill ${s.shortcode}`;
  return s.tillNumber && s.tillNumber !== s.shortcode ? `Buy Goods ${s.tillNumber} (store ${s.shortcode})` : `Buy Goods ${s.shortcode}`;
}

/** A branch's line: its own, the default it uses (and where that pays), or nothing. */
function branchSummary(b: BranchLine): string {
  if (b.uses === 'own') return `Own settings — ${describeStatus(b.own)}`;
  if (b.uses === 'none') return 'Not set up — customers pay by M-Pesa reference only';
  return b.paysTo ? `Uses the business default — ${b.paysTo}` : 'Uses the business default';
}

/** A message after Save / Test / Remove: done (teal), still going (grey) or refused (red). */
function resultClass(t: string): string {
  if (t === 'Testing…') return 'text-gray-400';
  return /^(Connected|Business default saved)|saved\.$|removed/.test(t) ? 'text-swift' : 'text-red-400';
}

/** These details are for one M-Pesa and the server sends prompts to the other — say so. */
function envWarning(s: MpesaStatus | null, server: Environment): string | null {
  if (!s?.environment || s.environment === server) return null;
  return `These details are marked ${envLabel(s.environment)}, but this server sends payment prompts to ${envLabel(server)} M-Pesa — prompts will fail.`;
}

function StatusLine({ s }: { s: MpesaStatus }) {
  return (
    <p className="text-xs text-gray-500 mt-1">
      {envLabel(s.environment)}{s.keyLast4 ? ` · key …${s.keyLast4}` : ''}
      {s.updatedAt ? ` · saved ${new Date(s.updatedAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
      {s.updatedBy ? ` by ${s.updatedBy}` : ''}
    </p>
  );
}

function MpesaForm({ target, status, branchTable, onSaved, onCancel }: {
  target: Target; status: MpesaStatus | null; branchTable: boolean; onSaved: (msg: string) => void; onCancel: () => void;
}) {
  const [type, setType] = useState<MpesaType>(status?.type === 'CustomerPayBillOnline' ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline');
  const [shortcode, setShortcode] = useState(status?.shortcode ?? '');
  const [till, setTill] = useState(status?.tillNumber ?? '');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [passkey, setPasskey] = useState('');
  const [environment, setEnvironment] = useState<Environment>(status?.environment === 'sandbox' ? 'sandbox' : 'production');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const buyGoods = type === 'CustomerBuyGoodsOnline';
  const path = target.kind === 'default' ? '/api/mpesa/settings/default' : `/api/mpesa/settings/branches/${target.id}`;

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.put(path, { type, shortcode, till_number: buyGoods ? till : '', consumer_key: key, consumer_secret: secret, passkey, environment });
      onSaved(target.kind === 'default' ? 'Business default saved.' : `${target.name}: own M-Pesa details saved.`);
    } catch (e: any) { setError(e?.message ?? 'Could not save'); }
    finally { setBusy(false); }
  };

  if (target.kind === 'branch' && !branchTable) {
    return <p className={warn}>A branch's own M-Pesa details need the latest database update (migration 186). The business default works meanwhile.</p>;
  }
  return (
    <div className="mt-3 space-y-3 border-t border-gray-800 pt-3" data-testid="mpesa-form">
      <div className="flex gap-2">
        {([['CustomerPayBillOnline', 'Paybill'], ['CustomerBuyGoodsOnline', 'Buy Goods']] as const).map(([t, label]) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={`rounded-lg px-3 py-1.5 text-sm border ${type === t ? 'border-swift text-swift' : 'border-gray-700 text-gray-400 hover:border-gray-500'}`}>{label}</button>
        ))}
      </div>
      <label className="block text-xs text-gray-400">{buyGoods ? 'Store number (shortcode)' : 'Paybill number'}
        <input className={`${input} mt-1`} inputMode="numeric" value={shortcode} onChange={(e) => setShortcode(e.target.value)} placeholder="e.g. 174379" />
      </label>
      {buyGoods && (
        <label className="block text-xs text-gray-400">Buy Goods Till number — what customers pay to (blank: the store number)
          <input className={`${input} mt-1`} inputMode="numeric" value={till} onChange={(e) => setTill(e.target.value)} placeholder="e.g. 163726" />
        </label>
      )}
      <label className="block text-xs text-gray-400">Consumer key{status?.keyLast4 ? ` (saved: …${status.keyLast4} — leave blank to keep)` : ''}
        <input className={`${input} mt-1`} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="block text-xs text-gray-400">Consumer secret{status?.secretSaved ? ' (saved — leave blank to keep)' : ''}
        <input className={`${input} mt-1`} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      <label className="block text-xs text-gray-400">Passkey{status?.passkeySaved ? ' (saved — leave blank to keep)' : ''}
        <input className={`${input} mt-1`} type="password" autoComplete="new-password" value={passkey} onChange={(e) => setPasskey(e.target.value)} />
      </label>
      <div className="flex gap-2">
        {([['sandbox', 'Sandbox (testing)'], ['production', 'Live']] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => setEnvironment(v)}
            className={`rounded-lg px-3 py-1.5 text-sm border ${environment === v ? 'border-swift text-swift' : 'border-gray-700 text-gray-400 hover:border-gray-500'}`}>{label}</button>
        ))}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy}
          className="rounded-lg bg-swift px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-swift-light disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
      </div>
    </div>
  );
}

export default function MpesaStkSettings() {
  const [data, setData] = useState<MpesaSettings | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);   // 'default' or a branch id
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmState, showConfirm, closeConfirm] = useConfirm();

  const load = useCallback(async () => {
    try { setData(await api.get<MpesaSettings>('/api/mpesa/settings')); setError(''); }
    catch (e: any) { setError(e?.message ?? 'Could not load the M-Pesa details'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const say = (id: string, text: string) => setMsg((m) => ({ ...m, [id]: text }));
  const test = async (id: string, branchId: string | null) => {
    setBusy(id); say(id, 'Testing…');
    try {
      const r = await api.post<{ ok: boolean; error?: string; source: string; environment: string }>('/api/mpesa/settings/test', branchId ? { branch_id: branchId } : {});
      const which = r.source === 'branch' ? 'its own details' : 'the business default';
      say(id, r.ok ? `Connected to ${envLabel(r.environment)} M-Pesa with ${which}.` : `Safaricom refused ${which}: ${r.error ?? 'no reason given'}`);
    } catch (e: any) { say(id, e?.message ?? 'Could not test'); }
    finally { setBusy(null); }
  };
  const removeOwn = (b: BranchLine) => showConfirm({
    title: `Remove ${b.name}'s own M-Pesa details?`,
    message: 'Payments at this branch will use the business default.',
    intent: 'destructive',
    confirmLabel: 'Remove',
    onConfirm: async () => {
      try { await api.delete(`/api/mpesa/settings/branches/${b.id}`); say(b.id, 'Own details removed — uses the business default.'); await load(); }
      catch (e: any) { say(b.id, e?.message ?? 'Could not remove'); }
    },
  });
  const saved = async (id: string, text: string) => { setEditing(null); say(id, text); await load(); };

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading M-Pesa…</p>;

  return (
    <div className="space-y-3" data-testid="mpesa-stk-settings">
      <div>
        <h2 className="text-lg font-semibold text-white">M-Pesa (STK push)</h2>
        <p className="text-sm text-gray-400 mt-1">
          The Safaricom Daraja details that send the payment prompt to a customer's phone. Set the business default once;
          give a branch its own when it collects to a different Paybill or Buy Goods number.
        </p>
      </div>

      <div className={`${card} p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-white">Business default</p>
            <p className={`text-sm mt-0.5 ${data.default.configured ? 'text-swift' : 'text-gray-500'}`}>{describeStatus(data.default)}</p>
            {data.default.shortcode && <StatusLine s={data.default} />}
          </div>
          <div className="flex gap-2">
            <button className={btn} onClick={() => setEditing(editing === 'default' ? null : 'default')}>{data.default.shortcode ? 'Edit' : 'Set up'}</button>
            {data.default.configured && <button className={btn} disabled={busy === 'default'} onClick={() => void test('default', null)}>Test connection</button>}
          </div>
        </div>
        {data.default.shortcode && !data.default.configured && <p className={`${warn} mt-2`}>Incomplete — a key, the secret or the passkey is missing or unreadable. Save them again.</p>}
        {envWarning(data.default, data.serverEnvironment) && <p className={`${warn} mt-2`}>{envWarning(data.default, data.serverEnvironment)}</p>}
        {msg.default && <p className={`mt-2 text-xs ${resultClass(msg.default)}`}>{msg.default}</p>}
        {editing === 'default' && (
          <MpesaForm target={{ kind: 'default' }} status={data.default} branchTable={data.branchTable}
            onSaved={(t) => void saved('default', t)} onCancel={() => setEditing(null)} />
        )}
      </div>

      {data.branches.map((b) => (
        <div key={b.id} className={`${card} p-4`} data-testid="mpesa-branch">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-white">{b.name}</p>
              <p className={`text-sm mt-0.5 ${b.uses === 'none' ? 'text-gray-500' : 'text-gray-300'}`}>
                {branchSummary(b)}
              </p>
              {b.own && <StatusLine s={b.own} />}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={btn} onClick={() => setEditing(editing === b.id ? null : b.id)}>{b.own ? 'Edit own' : 'Give it its own'}</button>
              {b.uses !== 'none' && <button className={btn} disabled={busy === b.id} onClick={() => void test(b.id, b.id)}>Test connection</button>}
              {b.own && <button className={`${btn} text-red-400 border-red-500/30 hover:border-red-500/60`} disabled={busy === b.id} onClick={() => removeOwn(b)}>Remove own</button>}
            </div>
          </div>
          {b.own && !b.own.configured && <p className={`${warn} mt-2`}>Its own details are incomplete, so it uses the business default. Save them again.</p>}
          {b.receiptWarning && <p className={`${warn} mt-2`} data-testid="mpesa-receipt-warning">{b.receiptWarning} The receipt's number is set on the POS: Manager › Settings › M-Pesa.</p>}
          {envWarning(b.own, data.serverEnvironment) && <p className={`${warn} mt-2`}>{envWarning(b.own, data.serverEnvironment)}</p>}
          {msg[b.id] && <p className={`mt-2 text-xs ${resultClass(msg[b.id])}`}>{msg[b.id]}</p>}
          {editing === b.id && (
            <MpesaForm target={{ kind: 'branch', id: b.id, name: b.name }} status={b.own} branchTable={data.branchTable}
              onSaved={(t) => void saved(b.id, t)} onCancel={() => setEditing(null)} />
          )}
        </div>
      ))}
      <p className="text-xs text-gray-500">
        Find these in the Safaricom Daraja portal (developer.safaricom.co.ke): the app's consumer key and secret, and the
        Lipa Na M-Pesa Online passkey Safaricom sends when the shortcode goes live. Test connection only asks Safaricom for an
        access token — nobody is charged.
      </p>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
