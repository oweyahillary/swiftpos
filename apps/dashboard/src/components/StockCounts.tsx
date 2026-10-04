import { useCallback, useEffect, useMemo, useState } from 'react';
import { printDocument } from '../lib/printDocument';

/**
 * StockCounts — A394: stock take. One screen for the owner (Stock › Stock counts) and the manager (Manager › Stock
 * count); the cloud decides what each may see (routes/stockTakes.ts).
 *
 * Owner, 2026-10-04: "We are missing a stock take module" — "Yes the count should be blind, I would recommend freeze but
 * we leave that as a feature which the owner will decide".
 *
 *   Start   — a branch; stocked products, ingredients, or both; everything or chosen categories.
 *   Count   — type what is on the shelf. Blind: the system's figure is never shown while counting.
 *   Hand in — the count goes to review.
 *   Review  — (someone who may change stock: the owner by default) the differences and their value; send items back
 *             to be counted again; post — stock changes by the differences.
 */

export interface CountsClient {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
}

interface Line {
  id: string; item_kind: 'product' | 'ingredient'; name: string; unit: string | null; category: string | null;
  by_piece: boolean; counted_qty: number | string | null; counted_at: string | null; counted_by_name: string | null;
  recount: boolean; unit_cost?: number | string | null;
  expected_qty?: number | string | null; late_sales?: number | string | null; expected_final?: number | string | null;
  variance?: number | string | null; variance_value?: number | string | null; previous_count?: number | string | null;
}
interface Summary { items: number; counted: number; notCounted: number; withVariance: number; shortValue: number; overValue: number; netValue: number }
interface Take {
  id: string; ref: string; status: 'counting' | 'review' | 'posted' | 'cancelled'; freeze: boolean; note: string | null;
  branch_id: string; branch_name?: string | null; started_at: string; started_by_name: string | null;
  submitted_at: string | null; submitted_by_name: string | null; posted_at: string | null; posted_by_name: string | null;
  cancelled_at?: string | null; can_review: boolean; summary: Summary | null;
  progress: { items: number; counted: number; not_counted: number }; lines: Line[];
}
interface ListRow {
  id: string; ref: string; status: Take['status']; freeze: boolean; started_at: string; started_by_name: string | null;
  posted_at: string | null; posted_by_name: string | null; summary: Summary | null; branches?: { name?: string } | null;
}

const STATUS: Record<Take['status'], { label: string; cls: string }> = {
  counting:  { label: 'Counting',   cls: 'bg-gray-700 text-gray-200' },
  review:    { label: 'For review', cls: 'bg-amber-500/10 text-amber-400' },
  posted:    { label: 'Posted',     cls: 'bg-swift/15 text-swift-text' },
  cancelled: { label: 'Cancelled',  cls: 'bg-gray-700 text-gray-300' },
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const fmtQty = (v: unknown): string => { const n = num(v); return n === null ? '—' : String(Math.round(n * 100) / 100); };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const errText = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;

export default function StockCounts({ client, branchId, branches, currency = 'KES', business, canStart = true, isOwner = false }: {
  client: CountsClient;
  /** The branch to count. The owner picks it in the sidebar; a manager is locked to their own. */
  branchId: string | null;
  branches?: { id: string; name: string }[];
  currency?: string;
  business?: { name: string; address?: string | null; phone?: string | null } | null;
  canStart?: boolean;
  /** The owner sees the freeze switch ("the owner will decide"). */
  isOwner?: boolean;
}) {
  const [list, setList] = useState<ListRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    setLoading(true); setError('');
    try { setList(await client.get<ListRow[]>(`/api/stock-takes${branchId ? `?branch_id=${branchId}` : ''}`)); }
    catch (e) { setError(errText(e, 'Could not load stock counts.')); }
    finally { setLoading(false); }
  }, [branchId]);   // eslint-disable-line react-hooks/exhaustive-deps — client is a new object every render (POSAuthContext)

  useEffect(() => { void loadList(); }, [loadList]);

  if (openId) {
    return <CountScreen client={client} id={openId} currency={currency} business={business}
      onClose={() => { setOpenId(null); void loadList(); }} />;
  }

  const open = list.find((t) => t.status === 'counting' || t.status === 'review');
  const branchName = (id: string | null) => branches?.find((b) => b.id === id)?.name;

  return (
    <div className="space-y-5" data-testid="stock-counts">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Stock counts</h1>
          <p className="mt-0.5 text-sm text-gray-400">Count what is on the shelf; the differences are reviewed before stock changes.</p>
        </div>
        {canStart && !open && (
          <button disabled={!branchId} onClick={() => setStarting(true)} data-testid="start-count"
            className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
            Start a count
          </button>
        )}
      </div>
      {isOwner && <FreezeSwitch client={client} />}
      {!branchId && <p className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">Choose a branch to start a count.</p>}

      {open && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-swift/40 bg-swift/5 p-4">
          <div>
            <div className="text-sm font-semibold text-white">{open.ref} — {STATUS[open.status].label}{open.branches?.name ? ` · ${open.branches.name}` : ''}</div>
            <div className="mt-0.5 text-xs text-gray-400">
              Started {when(open.started_at)} by {open.started_by_name ?? '—'}
              {open.freeze ? ' · items cannot be sold until they are counted' : ' · selling carries on'}
            </div>
          </div>
          <button onClick={() => setOpenId(open.id)} className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950">
            {open.status === 'counting' ? 'Continue counting' : 'Open'}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr><th className="px-4 py-2">Count</th><th className="px-4 py-2">Status</th><th className="hidden px-4 py-2 sm:table-cell">Started</th>
              <th className="hidden px-4 py-2 md:table-cell">Posted</th><th className="px-4 py-2 text-right">Difference</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>}
            {!loading && !list.length && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No stock counts yet.</td></tr>}
            {list.map((t) => (
              <tr key={t.id} onClick={() => setOpenId(t.id)} className="cursor-pointer hover:bg-gray-900/60">
                <td className="px-4 py-3 text-white">{t.ref}<div className="text-xs text-gray-500">{t.branches?.name ?? branchName(null) ?? ''}</div></td>
                <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span></td>
                <td className="hidden px-4 py-3 text-gray-400 sm:table-cell">{when(t.started_at)}<div className="text-xs text-gray-500">{t.started_by_name ?? ''}</div></td>
                <td className="hidden px-4 py-3 text-gray-400 md:table-cell">{when(t.posted_at)}<div className="text-xs text-gray-500">{t.posted_by_name ?? ''}</div></td>
                <td className={`px-4 py-3 text-right ${t.summary && t.summary.netValue < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                  {t.summary && t.status === 'posted' ? `${currency} ${t.summary.netValue.toLocaleString('en-KE')}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {starting && branchId && (
        <StartCount client={client} branchId={branchId} branchName={branchName(branchId)}
          onClose={() => setStarting(false)}
          onStarted={(id) => { setStarting(false); setOpenId(id); }} />
      )}
    </div>
  );
}

// ── The owner's freeze switch ───────────────────────────────────────────────

function FreezeSwitch({ client }: { client: CountsClient }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    client.get<Array<{ key: string; value: unknown }>>('/api/business/settings')
      .then((rows) => setOn(String((Array.isArray(rows) ? rows : []).find((r) => r.key === 'stock_count_freeze')?.value ?? '').replace(/"/g, '') === 'true'))
      .catch(() => setOn(false));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const flip = async () => {
    if (on === null) return;
    setBusy(true); setError('');
    try { await client.post('/api/business/settings', { key: 'stock_count_freeze', value: on ? 'false' : 'true' }); setOn(!on); }
    catch (e) { setError(errText(e, 'Could not save.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4" data-testid="freeze-switch">
      <div className="min-w-[220px] flex-1">
        <div className="text-sm font-semibold text-white">Freeze items while they are counted <span className="ml-1 rounded-full bg-swift/15 px-2 py-0.5 text-[10px] font-medium text-swift-text">Recommended</span></div>
        <div className="mt-0.5 text-xs text-gray-400">
          On: an item in a count cannot be sold — on the tills or the web POS — until it has been counted. Off: selling carries on;
          each item is compared with what the system held when it was counted. Applies to counts started after the change.
        </div>
        {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
      </div>
      <button role="switch" aria-checked={!!on} disabled={busy || on === null} onClick={flip}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-swift' : 'bg-gray-700'} disabled:opacity-50`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

// ── Start a count ────────────────────────────────────────────────────────────

function StartCount({ client, branchId, branchName, onClose, onStarted }: {
  client: CountsClient; branchId: string; branchName?: string; onClose: () => void; onStarted: (id: string) => void;
}) {
  const [products, setProducts] = useState(true);
  const [ingredients, setIngredients] = useState(false);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [ingCats, setIngCats] = useState<string[]>([]);
  const [pickCats, setPickCats] = useState<string[]>([]);
  const [pickIngCats, setPickIngCats] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [freeze, setFreeze] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    client.get<{ id: string; name: string; status?: string }[]>('/api/categories')
      .then((c) => setCats((Array.isArray(c) ? c : []).filter((x) => !x.status || x.status === 'active'))).catch(() => setCats([]));
    client.get<{ category: string | null }[]>(`/api/stock/ingredients?status=active&branch_id=${branchId}`)
      .then((r) => setIngCats([...new Set((Array.isArray(r) ? r : []).map((i) => i.category).filter((c): c is string => !!c))].sort()))
      .catch(() => setIngCats([]));
    client.get<Array<{ key: string; value: unknown }> | Record<string, unknown>>('/api/business/settings')
      .then((s) => {
        const rows = Array.isArray(s) ? s : Object.entries(s).map(([key, value]) => ({ key, value }));
        const v = rows.find((r) => r.key === 'stock_count_freeze')?.value;
        setFreeze(String(v ?? '').replace(/"/g, '') === 'true');
      }).catch(() => setFreeze(null));
  }, [branchId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const start = async () => {
    setBusy(true); setError('');
    try {
      const r = await client.post<{ id: string }>('/api/stock-takes', {
        branch_id: branchId, products, ingredients, category_ids: products ? pickCats : [],
        ingredient_categories: ingredients ? pickIngCats : [], note,
      });
      onStarted(r.id);
    } catch (e) { setError(errText(e, 'Could not start the count.')); }
    finally { setBusy(false); }
  };

  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-swift bg-swift/15 text-white' : 'border-gray-700 text-gray-400 hover:text-white'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-900 p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()} data-testid="start-count-form">
        <h2 className="text-lg font-semibold text-white">Start a stock count</h2>
        <p className="mt-0.5 text-sm text-gray-400">{branchName ? `At ${branchName}. ` : ''}Counts are blind — nobody counting sees what the system expects.</p>

        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">What to count</div>
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={products} onChange={(e) => setProducts(e.target.checked)} /> Stocked products (shelf items, drinks)
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={ingredients} onChange={(e) => setIngredients(e.target.checked)} /> Ingredients (raw materials)
            </label>
          </div>

          {products && cats.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Product categories <span className="normal-case text-gray-600">— none chosen = everything this branch stocks</span></div>
              <div className="flex flex-wrap gap-2">
                {cats.map((c) => <button key={c.id} type="button" className={chip(pickCats.includes(c.id))} onClick={() => setPickCats(toggle(pickCats, c.id))}>{c.name}</button>)}
              </div>
            </div>
          )}
          {ingredients && ingCats.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Ingredient categories <span className="normal-case text-gray-600">— none chosen = all</span></div>
              <div className="flex flex-wrap gap-2">
                {ingCats.map((c) => <button key={c} type="button" className={chip(pickIngCats.includes(c))} onClick={() => setPickIngCats(toggle(pickIngCats, c))}>{c}</button>)}
              </div>
            </div>
          )}

          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Note (optional) — e.g. month-end count"
            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none" />

          {freeze !== null && (
            <p className="rounded-xl border border-gray-800 bg-gray-950 px-3 py-2 text-xs text-gray-400" data-testid="freeze-note">
              {freeze
                ? 'The owner has chosen to freeze: an item being counted cannot be sold until it has been counted.'
                : 'Selling carries on while you count — each item is compared with what the system held when it was counted.'}
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
          <button disabled={busy || (!products && !ingredients)} onClick={start}
            className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Starting…' : 'Start counting'}</button>
        </div>
      </div>
    </div>
  );
}

// ── One count: counting, review, posted ─────────────────────────────────────

function CountScreen({ client, id, currency, business, onClose }: {
  client: CountsClient; id: string; currency: string;
  business?: { name: string; address?: string | null; phone?: string | null } | null; onClose: () => void;
}) {
  const [take, setTake] = useState<Take | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [onlyLeft, setOnlyLeft] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try { setTake(await client.get<Take>(`/api/stock-takes/${id}`)); setError(''); }
    catch (e) { setError(errText(e, 'Could not load the count.')); }
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => {
    if (!take) return [] as Array<{ line_id: string; qty: string }>;
    return take.lines.filter((l) => typed[l.id] !== undefined && typed[l.id] !== (l.counted_qty === null ? '' : fmtQty(l.counted_qty)))
      .map((l) => ({ line_id: l.id, qty: typed[l.id].trim() }));
  }, [typed, take]);

  const save = async (): Promise<boolean> => {
    if (!dirty.length) return true;
    setBusy(true); setError('');
    try {
      for (let i = 0; i < dirty.length; i += 400) {
        await client.post(`/api/stock-takes/${id}/count`, { counts: dirty.slice(i, i + 400) });
      }
      setTyped({}); setSaved(`Saved ${dirty.length} count${dirty.length === 1 ? '' : 's'}.`);
      await load();
      return true;
    } catch (e) { setError(errText(e, 'Could not save the counts.')); return false; }
    finally { setBusy(false); }
  };

  const act = async (path: string, body: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError(''); setSaved('');
    try { await client.post(`/api/stock-takes/${id}/${path}`, body); setPicked([]); await load(); }
    catch (e) { setError(errText(e, 'That did not work.')); await load(); }
    finally { setBusy(false); }
  };

  if (!take) {
    return <div className="space-y-3"><button onClick={onClose} className="text-sm text-gray-400 hover:text-white">← Stock counts</button>
      {error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-sm text-gray-500">Loading…</p>}</div>;
  }

  const counting = take.status === 'counting';
  const review = take.status === 'review' && take.can_review;
  const showDiff = take.can_review && (take.status === 'review' || take.status === 'posted');
  const q = search.trim().toLowerCase();
  const rows = take.lines.filter((l) =>
    (!q || l.name.toLowerCase().includes(q) || (l.category ?? '').toLowerCase().includes(q)) &&
    (!onlyLeft || l.counted_qty === null) &&
    (!onlyDiff || (num(l.variance) ?? 0) !== 0));
  const s = take.summary;
  const money = (n: number | null | undefined) => `${currency} ${(n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

  const printSheet = (withFigures: boolean) => printDocument({
    docType: withFigures ? 'STOCK COUNT — DIFFERENCES' : 'STOCK COUNT SHEET',
    number: take.ref,
    dateLabel: when(take.started_at),
    accent: withFigures ? '#b45309' : '#475569',
    business: business ?? { name: 'ZapTill' },
    meta: [
      { label: 'Branch', value: take.branch_name ?? '—' },
      { label: 'Started', value: `${when(take.started_at)} — ${take.started_by_name ?? ''}` },
      ...(take.posted_at ? [{ label: 'Posted', value: `${when(take.posted_at)} — ${take.posted_by_name ?? ''}` }] : []),
    ],
    // Blind sheet: no system figure — only the space to write what is on the shelf.
    columns: withFigures
      ? [{ label: 'Item' }, { label: 'Counted', align: 'right' }, { label: 'Expected', align: 'right' }, { label: 'Difference', align: 'right' }, { label: 'Value', align: 'right' }]
      : [{ label: 'Item' }, { label: 'Category' }, { label: 'Unit' }, { label: 'Counted', align: 'right' }],
    rows: withFigures
      ? take.lines.filter((l) => l.counted_qty !== null).map((l) => [l.name, fmtQty(l.counted_qty), fmtQty(l.expected_final), fmtQty(l.variance), money(num(l.variance_value))])
      : take.lines.map((l) => [l.name, l.category ?? '', l.unit ?? '', '']),
    totals: withFigures && s ? [
      { label: 'Short', value: money(s.shortValue) }, { label: 'Over', value: money(s.overValue) }, { label: 'Net', value: money(s.netValue) },
    ] : undefined,
    note: take.note,
    signatures: withFigures ? ['Reviewed by', 'Approved by'] : ['Counted by', 'Checked by'],
  });

  return (
    <div className="space-y-4" data-testid="count-screen">
      <button onClick={async () => { if (await save()) onClose(); }} className="text-sm text-gray-400 hover:text-white">← Stock counts</button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-white">{take.ref}</h1>
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[take.status].cls}`}>{STATUS[take.status].label}</span>
          </div>
          <p className="mt-0.5 text-sm text-gray-400">
            {take.branch_name ?? ''} · started {when(take.started_at)} by {take.started_by_name ?? '—'}
            {take.freeze && (take.status === 'counting' || take.status === 'review') ? ' · items cannot be sold until counted' : ''}
          </p>
          {take.note && <p className="mt-1 text-xs text-gray-500">{take.note}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => printSheet(false)} className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:text-white">Print count sheet</button>
          {showDiff && <button onClick={() => printSheet(true)} className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:text-white">Print differences</button>}
        </div>
      </div>

      {/* Progress (everyone) */}
      <div>
        <div className="mb-1 flex justify-between text-xs text-gray-400">
          <span>{take.progress.counted} of {take.progress.items} counted</span>
          {take.progress.not_counted > 0 && <span>{take.progress.not_counted} left</span>}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-800">
          <div className="h-full bg-swift" style={{ width: `${take.progress.items ? Math.round((take.progress.counted / take.progress.items) * 100) : 0}%` }} />
        </div>
      </div>

      {showDiff && s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="count-summary">
          {[
            { label: 'Items with a difference', value: String(s.withVariance), cls: 'text-white' },
            { label: 'Short', value: money(s.shortValue), cls: 'text-red-400' },
            { label: 'Over', value: money(s.overValue), cls: 'text-swift-text' },
            { label: 'Net', value: money(s.netValue), cls: s.netValue < 0 ? 'text-red-400' : 'text-white' },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900 p-3">
              <div className="text-xs text-gray-500">{c.label}</div>
              <div className={`mt-1 text-lg font-semibold ${c.cls}`}>{c.value}</div>
            </div>
          ))}
        </div>
      )}

      {take.status === 'review' && !take.can_review && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">Handed in {when(take.submitted_at)}. Waiting for the owner to review the differences.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items"
          className="min-w-[180px] flex-1 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none" />
        {counting && <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={onlyLeft} onChange={(e) => setOnlyLeft(e.target.checked)} /> Not counted yet</label>}
        {showDiff && <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only differences</label>}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              {review && <th className="w-8 px-3 py-2" />}
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Counted</th>
              {showDiff && <><th className="hidden px-3 py-2 text-right sm:table-cell">Expected</th><th className="px-3 py-2 text-right">Difference</th>
                <th className="hidden px-3 py-2 text-right md:table-cell">Value</th></>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map((l) => {
              const v = num(l.variance) ?? 0;
              const late = num(l.late_sales) ?? 0;
              return (
                <tr key={l.id} className={l.recount && l.counted_qty === null ? 'bg-amber-500/5' : ''}>
                  {review && (
                    <td className="px-3 py-2"><input type="checkbox" aria-label={`Count ${l.name} again`} checked={picked.includes(l.id)}
                      disabled={l.counted_qty === null} onChange={() => setPicked(picked.includes(l.id) ? picked.filter((x) => x !== l.id) : [...picked, l.id])} /></td>
                  )}
                  <td className="px-3 py-2">
                    <div className="text-white">{l.name}</div>
                    <div className="text-xs text-gray-500">
                      {[l.category, l.unit, l.item_kind === 'ingredient' ? 'ingredient' : null].filter(Boolean).join(' · ')}
                      {l.recount && l.counted_qty === null ? <span className="ml-1 text-amber-400">· count again</span> : null}
                      {showDiff && num(l.previous_count) !== null ? <span className="ml-1">· first count {fmtQty(l.previous_count)}</span> : null}
                      {showDiff && late !== 0 ? <span className="ml-1">· {fmtQty(-late)} sold on a till before the count, synced after</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {counting ? (
                      <input inputMode="decimal" aria-label={`Counted ${l.name}`} data-testid="count-input"
                        value={typed[l.id] ?? (l.counted_qty === null ? '' : fmtQty(l.counted_qty))}
                        onChange={(e) => setTyped({ ...typed, [l.id]: e.target.value.replace(/[^\d.]/g, '') })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                        placeholder={l.by_piece ? 'pcs' : '0'}
                        className="w-24 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1.5 text-right text-white focus:border-swift focus:outline-none" />
                    ) : <span className="text-gray-200">{fmtQty(l.counted_qty)}</span>}
                  </td>
                  {showDiff && <>
                    <td className="hidden px-3 py-2 text-right text-gray-400 sm:table-cell">{fmtQty(l.expected_final)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${v < 0 ? 'text-red-400' : v > 0 ? 'text-swift-text' : 'text-gray-500'}`}>
                      {l.counted_qty === null ? '—' : v > 0 ? `+${fmtQty(v)}` : fmtQty(v)}
                    </td>
                    <td className="hidden px-3 py-2 text-right text-gray-400 md:table-cell">{l.counted_qty === null || num(l.unit_cost) === null ? '—' : money(num(l.variance_value))}</td>
                  </>}
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {saved && !error && <p className="text-sm text-swift-text">{saved}</p>}

      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-gray-800 bg-gray-950 py-3">
        {counting && <>
          <button disabled={busy} onClick={() => act('cancel', {}, 'Cancel this count? Nothing counted will change stock.')}
            className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel count</button>
          <button disabled={busy || !dirty.length} onClick={() => void save()}
            className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-200 disabled:opacity-40">{busy ? 'Saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}</button>
          <button disabled={busy} data-testid="submit-count" onClick={async () => {
            if (!(await save())) return;
            const left = take.lines.filter((l) => l.counted_qty === null).length - dirty.filter((d) => d.qty !== '').length;
            await act('submit', {}, left > 0
              ? `${left} item${left === 1 ? ' is' : 's are'} not counted — their stock will not change. Hand the count in for review?`
              : 'Hand the count in for review?');
          }} className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">Hand in for review</button>
        </>}
        {review && <>
          <button disabled={busy} onClick={() => act('cancel', {}, 'Cancel this count? Stock will not change.')}
            className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel count</button>
          <button disabled={busy || !picked.length} onClick={() => act('recount', { line_ids: picked })}
            className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-200 disabled:opacity-40">Count again{picked.length ? ` (${picked.length})` : ''}</button>
          <button disabled={busy} data-testid="post-count" onClick={() => act('post', {},
            `Post ${take.ref}? Stock changes by the differences${s ? ` (net ${money(s.netValue)})` : ''}. Items not counted stay as they are.`)}
            className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Posting…' : 'Post to stock'}</button>
        </>}
      </div>
    </div>
  );
}
