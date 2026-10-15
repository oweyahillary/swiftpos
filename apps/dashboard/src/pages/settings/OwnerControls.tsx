/**
 * OwnerControls — A491: business options that were the admin portal's, now the owner's (Settings › Business).
 *
 *   POS options   (settings.pos)      — delivery fee and rider, eat now pay later, pay before kitchen, sign-in codes;
 *                                       loyalty on / off and its earn rate.
 *   Till updates  (settings.updates)  — the version the tills install: approve one, or hold.
 *   Payments      (settings.payments) — the business-wide list of payment methods (BusinessPaymentMethods, shown on
 *                                       the Payments tab above the business's own methods; branches override it).
 *
 * API (cloud, routes/controls.ts): GET /api/controls → { pos?, loyalty?, updates?, payments? } — each section only with
 * its key; PUT /api/controls/pos/:key {enabled}; PUT /api/controls/loyalty {enabled?, earn_rate?};
 * PUT /api/controls/updates {version | null}. The business-wide payment methods save through POST /api/business/settings
 * (payment_methods_enabled). The owner holds every key; a section the cloud does not send is not shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { POS_FEATURES } from '../../lib/posFeatures';
import { PAYMENT_METHODS_ENABLED_KEY, enabledSettingValue } from '../../lib/paymentCatalogue';
import { dateShort } from '../../lib/format';
import BranchPaymentMethods from './BranchPaymentMethods';

/** The four switches the owner sets here (the admin portal shows them read-only). */
export const POS_OPTION_KEYS = ['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes'] as const;
export type PosOptionKey = (typeof POS_OPTION_KEYS)[number];

export interface Controls {
  pos?: Record<PosOptionKey, boolean>;
  loyalty?: { enabled: boolean; earn_rate: number };
  updates?: {
    approved_version: string | null;
    releases: Array<{ version: string; published_at: string | null }>;
    tills: Array<{ name: string; terminal_code: string | null; app_version: string | null; last_seen_at: string | null }>;
  };
  payments?: { enabled: string[] };
}

/** The words for a switch — shared/posFeatures.ts (the same the admin portal shows). */
export function posOptionWords(key: PosOptionKey): { label: string; description: string } {
  const f = POS_FEATURES.find((x) => x.key === key);
  return { label: f?.label ?? key, description: f?.description ?? '' };
}

export function useControls() {
  const [data, setData] = useState<Controls | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.get<Controls>('/api/controls')); setError(''); }
    catch (e: any) { setError(e?.message ?? 'Could not load these settings'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { data, setData, error, setError, reload: load };
}

function Switch({ on, onClick, label, disabled, testid }: { on: boolean; onClick: () => void; label: string; disabled?: boolean; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled} data-testid={testid}
      className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors disabled:opacity-50 ${on ? 'bg-swift-strong' : 'bg-gray-700'}`}>
      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-5' : 'left-1'}`} />
    </button>
  );
}

const card = 'rounded-xl border border-gray-800 bg-gray-900';

// ── POS options ───────────────────────────────────────────────────────────────

export function PosOptionsTab() {
  const { business } = useBusiness();
  const currency = (business as { currency?: string } | null)?.currency || 'KES';
  const { data, setData, error, setError, reload } = useControls();
  const [busy, setBusy] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { if (data?.loyalty) setRate(String(data.loyalty.earn_rate ?? 1)); }, [data?.loyalty?.earn_rate]);   // eslint-disable-line react-hooks/exhaustive-deps

  const flip = async (key: PosOptionKey) => {
    if (!data?.pos) return;
    const next = !data.pos[key];
    setBusy(key); setError(''); setMsg('');
    setData({ ...data, pos: { ...data.pos, [key]: next } });
    try { await api.put(`/api/controls/pos/${key}`, { enabled: next }); }
    catch (e: any) { setError(e?.message ?? 'Could not save'); await reload(); }
    finally { setBusy(null); }
  };

  const saveLoyalty = async (patch: { enabled?: boolean; earn_rate?: number }) => {
    if (!data?.loyalty) return;
    if (patch.earn_rate !== undefined && !(patch.earn_rate > 0 && patch.earn_rate <= 1000)) { setError('Enter an earn rate above 0.'); return; }
    setBusy('loyalty'); setError(''); setMsg('');
    setData({ ...data, loyalty: { ...data.loyalty, ...patch } });
    try { await api.put('/api/controls/loyalty', patch); if (patch.earn_rate !== undefined) setMsg('Earn rate saved.'); }
    catch (e: any) { setError(e?.message ?? 'Could not save'); await reload(); }
    finally { setBusy(null); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-4" data-testid="pos-options">
      <div>
        <h2 className="text-lg font-semibold text-white">POS options</h2>
        <p className="text-sm text-gray-400">How the tills and the web POS work for this business. The tills follow on their next sync.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!data && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {data?.pos && (
        <div className={`${card} divide-y divide-gray-800`}>
          {POS_OPTION_KEYS.map((key) => {
            const w = posOptionWords(key);
            return (
              <div key={key} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">{w.label}</div>
                  {w.description && <div className="mt-0.5 text-xs leading-relaxed text-gray-400">{w.description}</div>}
                </div>
                <Switch on={!!data.pos![key]} onClick={() => void flip(key)} label={w.label} disabled={busy === key} testid={`pos-option-${key}`} />
              </div>
            );
          })}
        </div>
      )}

      {data?.loyalty && (
        <div className={`${card} px-4 py-3 space-y-3`} data-testid="loyalty-options">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">Loyalty points</div>
              <div className="mt-0.5 text-xs leading-relaxed text-gray-400">Customers earn points on what they pay and spend them at the till.</div>
            </div>
            <Switch on={data.loyalty.enabled} onClick={() => void saveLoyalty({ enabled: !data.loyalty!.enabled })} label="Loyalty points"
              disabled={busy === 'loyalty'} testid="loyalty-enabled" />
          </div>
          {data.loyalty.enabled && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-gray-400">Points for every {currency} 10 spent
                <input type="number" min={0} step="0.1" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)}
                  className="mt-1 block w-28 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none" />
              </label>
              <button type="button" onClick={() => void saveLoyalty({ earn_rate: Number(rate) })}
                disabled={busy === 'loyalty' || Number(rate) === data.loyalty.earn_rate}
                className="rounded-lg bg-swift px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-swift-light disabled:opacity-40">Save</button>
              {msg && <span className="text-xs text-gray-400">{msg}</span>}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-gray-500">Who may see every cashier's sales, move money in or out of a drawer, or reprint receipts is set per role — Settings › Users and access › Roles and permissions.</p>
    </div>
  );
}

// ── Till updates ──────────────────────────────────────────────────────────────

export function TillUpdatesTab() {
  const { data, error, setError, reload } = useControls();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const u = data?.updates;
  useEffect(() => { if (u) setPick(u.approved_version ?? u.releases[0]?.version ?? ''); }, [u?.approved_version, u?.releases?.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const set = async (version: string | null) => {
    setBusy(true); setError('');
    try { await api.put('/api/controls/updates', { version }); await reload(); }
    catch (e: any) { setError(e?.message ?? 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-4" data-testid="till-updates">
      <div>
        <h2 className="text-lg font-semibold text-white">Till updates</h2>
        <p className="text-sm text-gray-400">The version of ZapTill your tills install. A till downloads it within the hour and installs it when it is next closed.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!data && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {u && (<>
        <div className={`${card} px-4 py-3 space-y-3`}>
          <div className="text-sm text-white" data-testid="approved-version">
            {u.approved_version ? <>Approved: <b>v{u.approved_version}</b></> : <>Held — the tills stay on the version they run.</>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="block flex-1 text-xs text-gray-400">Version
              <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!u.releases.length}
                className="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none">
                {u.releases.length === 0 && <option value="">No releases listed</option>}
                {u.releases.map((r) => (
                  <option key={r.version} value={r.version}>
                    v{r.version}{r.published_at ? ` — ${dateShort(r.published_at)}` : ''}{r.version === u.approved_version ? ' (approved)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => void set(pick)} disabled={busy || !pick || pick === u.approved_version} data-testid="approve-version"
                className="flex-1 sm:flex-none rounded-lg bg-swift px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-swift-light disabled:opacity-40">Approve</button>
              <button type="button" onClick={() => void set(null)} disabled={busy || !u.approved_version} data-testid="hold-version"
                className="flex-1 sm:flex-none rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-40">Hold</button>
            </div>
          </div>
        </div>

        <div className={card}>
          <div className="border-b border-gray-800 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Tills now</div>
          {u.tills.length === 0 ? <p className="px-4 py-4 text-sm text-gray-500">No tills yet.</p> : (
            <ul className="divide-y divide-gray-800">
              {u.tills.map((t, i) => {
                const behind = !!(t.app_version && u.approved_version && t.app_version !== u.approved_version);
                return (
                  <li key={`${t.terminal_code ?? t.name}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-gray-200">{t.name}{t.terminal_code ? <span className="text-gray-500"> · {t.terminal_code}</span> : null}</span>
                      {t.last_seen_at && <span className="block text-xs text-gray-500">last seen {dateShort(t.last_seen_at)}</span>}
                    </span>
                    <span className={`flex-shrink-0 tabular-nums ${behind ? 'text-amber-300' : 'text-gray-400'}`}>{t.app_version ? `v${t.app_version}` : '—'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </>)}
    </div>
  );
}

// ── Payments: the business-wide list ─────────────────────────────────────────

export function BusinessPaymentMethods() {
  const { data, setData, error, setError } = useControls();
  const [saved, setSaved] = useState('');
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data?.payments) return null;   // the cloud sends it only with settings.payments
  const save = async (value: string | null) => {
    const v = enabledSettingValue(value);
    if (!v) return;
    setError(''); setSaved('');
    const before = data;
    setData({ ...data, payments: { enabled: JSON.parse(v) } });
    try { await api.post('/api/business/settings', { key: PAYMENT_METHODS_ENABLED_KEY, value: v }); setSaved('Saved — the tills follow on their next sync.'); }
    catch (e: any) { setData(before); setError(e?.message ?? 'Could not save'); }
  };
  return (
    <div className={`${card} p-4`}>
      <BranchPaymentMethods scope="business" override={JSON.stringify(data.payments.enabled)} businessDefault={undefined} onSave={(v) => void save(v)} />
      {saved && <p className="mt-2 text-xs text-gray-400">{saved}</p>}
    </div>
  );
}
