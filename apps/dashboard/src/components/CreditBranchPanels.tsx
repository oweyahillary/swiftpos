/**
 * CreditBranchPanels — A595, owner decision D4 (2026-10-27): credit limits with branches, on Customers › Credit.
 *
 *   CreditSettingsPanel  the owner's maximum limit (nobody else sets one above it), "Partners decide credit at their own
 *                        branches", and which branches sell on account (the owner; a partner at their own branches when
 *                        allowed). GET / PUT /api/credit/settings, PUT /api/credit/branches/:id.
 *   CreditBranchPanel    on a customer: owed here / owed in total per branch, the limit at each branch (the owner; a partner
 *                        at their own branch when allowed — never on a limit the owner locked), and the owner's lock.
 *                        PUT /api/credit/customer/:id/branch-limit, PATCH /api/credit/customer/:id/limit { locked }.
 * The cloud decides every rule (routes/credit.ts, lib/branchCredit.ts); these screens only offer what it allows.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';   // the one money formatter (tests/format.test.mjs)

export interface CreditSettingsView { max_limit: number | null; partners_decide: boolean; is_owner: boolean; branches: Array<{ id: string; name: string | null; credit_enabled: boolean }> }
export interface BranchCreditRow { branch_id: string; branch_name: string | null; owed: number; credit_limit: number | null; set_by_name: string | null }


export function useCreditSettings(): { settings: CreditSettingsView | null; reload: () => Promise<void> } {
  const [settings, setSettings] = useState<CreditSettingsView | null>(null);
  const reload = useCallback(async () => {
    try { setSettings(await api.get<CreditSettingsView>('/api/credit/settings')); } catch { setSettings(null); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { settings, reload };
}

export function CreditSettingsPanel({ settings, reload, partner, currency }: {
  settings: CreditSettingsView | null; reload: () => Promise<void>; partner: boolean; currency: string;
}) {
  const [max, setMax] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMax(settings?.max_limit ? String(settings.max_limit) : ''); }, [settings?.max_limit]);
  if (!settings) return null;
  const owner = settings.is_owner;
  const mayToggle = owner || (partner && settings.partners_decide);
  if (!owner && !mayToggle) return null;
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ kind: 'ok', text: ok }); await reload(); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };
  return (
    <section className="mb-5 rounded-xl border border-gray-700 bg-gray-800/40 p-4" data-testid="credit-settings">
      <p className="text-sm font-semibold text-white">Credit settings</p>
      {owner && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-gray-400">Maximum credit limit (only you can set a customer above it)
            <div className="mt-1 flex gap-2">
              <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" placeholder="No maximum" data-testid="credit-max"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
              <button disabled={busy} onClick={() => run(() => api.put('/api/credit/settings', { max_limit: max.trim() ? Number(max) : null }), 'Maximum saved')}
                className="rounded-lg bg-swift-strong px-3 py-2 text-sm text-white disabled:opacity-50">Save</button>
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300 sm:mt-5">
            <input type="checkbox" checked={settings.partners_decide} disabled={busy} data-testid="credit-partners"
              onChange={(e) => run(() => api.put('/api/credit/settings', { partners_decide: e.target.checked }), 'Saved')} />
            Partners decide credit at their own branches
          </label>
        </div>
      )}
      {settings.max_limit !== null && !owner && <p className="mt-2 text-xs text-gray-400">The owner's maximum: {money(settings.max_limit, currency)}.</p>}
      {mayToggle && settings.branches.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-gray-400">Branches that sell on account</p>
          <div className="mt-1 flex flex-wrap gap-3">
            {settings.branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={b.credit_enabled} disabled={busy} data-testid={`credit-branch-${b.id}`}
                  onChange={(e) => run(() => api.put(`/api/credit/branches/${b.id}`, { enabled: e.target.checked }), 'Saved')} />
                {b.name ?? 'Branch'}
              </label>
            ))}
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.kind === 'ok' ? 'text-gray-300' : 'text-red-400'}`}>{msg.text}</p>}
    </section>
  );
}

export function CreditBranchPanel({ customerId, limit, owedTotal, locked, rows, settings, partner, partnerBranches, currency, onChanged }: {
  customerId: string; limit: number; owedTotal: number; locked: boolean; rows: BranchCreditRow[]; settings: CreditSettingsView | null;
  partner: boolean; partnerBranches?: string[] | null; currency: string; onChanged: () => Promise<void>;
}) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [newBranch, setNewBranch] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = settings?.is_owner === true;
  const mayEditAt = (branchId: string) => !locked && (owner || (partner && !!settings?.partners_decide
    && (!partnerBranches || partnerBranches.includes(branchId))));
  const save = async (branchId: string, value: string) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/credit/customer/${customerId}/branch-limit`, { branch_id: branchId, credit_limit: value.trim() === '' ? null : Number(value) });
      setMsg({ kind: 'ok', text: 'Branch limit saved' }); await onChanged();
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };
  const lock = async (on: boolean, limit: number) => {
    setBusy(true); setMsg(null);
    try { await api.patch(`/api/credit/customer/${customerId}/limit`, { credit_limit: limit, locked: on }); await onChanged(); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };
  const others = (settings?.branches ?? []).filter((b) => !rows.some((r) => r.branch_id === b.id) && mayEditAt(b.id));
  return (
    <div className="mb-5 rounded-lg bg-gray-800/50 p-4" data-testid="credit-branches">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-white">By branch</p>
        {owner && (
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={locked} disabled={busy} data-testid="credit-lock" onChange={(e) => lock(e.target.checked, limit)} />
            Lock this limit (only you change it)
          </label>
        )}
      </div>
      {locked && !owner && <p className="mt-1 text-xs text-amber-300">The owner locked this customer's limit.</p>}
      <p className="mt-1 text-xs text-gray-400">Owed in total: {money(owedTotal, currency)}</p>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.branch_id} className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
            <span className="min-w-[8rem] text-white">{r.branch_name ?? 'Branch'}</span>
            <span>Owed here {money(r.owed, currency)}</span>
            <span className="text-gray-400">· limit here {r.credit_limit === null ? 'none (the business limit)' : money(r.credit_limit, currency)}</span>
            {mayEditAt(r.branch_id) && (
              <>
                <input value={edit[r.branch_id] ?? (r.credit_limit === null ? '' : String(r.credit_limit))} inputMode="decimal" placeholder="none"
                  onChange={(e) => setEdit((x) => ({ ...x, [r.branch_id]: e.target.value }))}
                  className="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white" />
                <button disabled={busy} onClick={() => save(r.branch_id, edit[r.branch_id] ?? (r.credit_limit === null ? '' : String(r.credit_limit)))}
                  className="rounded bg-gray-700 px-2 py-1 text-xs text-white">Save</button>
              </>
            )}
          </li>
        ))}
        {!rows.length && <li className="text-xs text-gray-500">Nothing owed at any branch yet.</li>}
      </ul>
      {others.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={newBranch} onChange={(e) => setNewBranch(e.target.value)} className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white">
            <option value="">Set a limit at a branch…</option>
            {others.map((b) => <option key={b.id} value={b.id}>{b.name ?? 'Branch'}</option>)}
          </select>
          {newBranch && (
            <>
              <input value={edit[newBranch] ?? ''} inputMode="decimal" onChange={(e) => setEdit((x) => ({ ...x, [newBranch]: e.target.value }))}
                className="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white" />
              <button disabled={busy} onClick={() => save(newBranch, edit[newBranch] ?? '')} className="rounded bg-gray-700 px-2 py-1 text-xs text-white">Save</button>
            </>
          )}
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.kind === 'ok' ? 'text-gray-300' : 'text-red-400'}`}>{msg.text}</p>}
    </div>
  );
}
