/**
 * OffersScreen — A445: Manager › Menu › Offers on the till. The owner creates offers for every branch or this one; a
 * manager for this branch only (the cloud enforces it). Online: the cloud holds offers; the till applies them from its
 * copy (pulled with the menu), offline too.
 *
 * Owner, 2026-10-11: "a manager can create an offer i.e runs on specific days or on a certain duration" — % or amount
 * off, a special price, buy X get Y free, spend over X get money off, and a custom meal (chosen items for one price).
 */
import { useEffect, useMemo, useState } from 'react';
import { posApi } from '../lib/posApi';
import { cleanOffer, offerRunsAt, offerWhatLabel, offerWhenLabel, type Offer, type OfferKind, type MealPart } from '@zaptill/core/offers';

type Row = Offer & { editable?: boolean; created_by_name?: string | null };
interface Named { id: string; name: string }

const KINDS: Array<{ kind: OfferKind; label: string; hint: string }> = [
  { kind: 'percent_off', label: '% off', hint: 'e.g. 20% off all drinks' },
  { kind: 'amount_off', label: 'Amount off', hint: 'e.g. 100 off each burger' },
  { kind: 'special_price', label: 'Special price', hint: 'e.g. pizza at 700 instead of 900' },
  { kind: 'buy_get', label: 'Buy X get Y', hint: 'e.g. buy 2 get 1 free, or buy 2 burgers get a soda free' },
  { kind: 'spend_get', label: 'Spend over', hint: 'e.g. spend 2,000 get 10% off the bill' },
  { kind: 'meal', label: 'Meal deal', hint: 'e.g. burger + side + drink for 750' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const blank = (): Partial<Offer> => ({
  name: '', kind: 'percent_off', value: 0, spend_type: 'percent', applies_to: 'all', product_ids: [], category_ids: [],
  buy_qty: 2, get_qty: 1, get_product_id: null, min_spend: 0, meal_items: [], start_date: null, end_date: null,
  days: null, start_time: null, end_time: null, branch_ids: null, active: true,
});

const input = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500';
const chip = (on: boolean) => `px-3 py-1.5 rounded-lg text-xs border transition-colors ${on
  ? 'bg-action-500/20 border-action-500/60 text-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'}`;

export default function OffersScreen({ isOwner, currency }: { isOwner: boolean; currency: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Offer> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [products, setProducts] = useState<Named[]>([]);
  const [categories, setCategories] = useState<Named[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);

  const load = () => {
    setLoading(true); setError('');
    posApi.manage.offers()
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => setError(e?.message ?? 'Could not read the offers — the POS needs the internet to change them.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    posApi.manage.listProducts().then((p) => setProducts((p ?? []).map((x: any) => ({ id: String(x.id), name: String(x.name) })))).catch(() => {});
    posApi.manage.listCategories().then((c) => setCategories((c ?? []).map((x: any) => ({ id: String(x.id), name: String(x.name) })))).catch(() => {});
    posApi.pos.offers().then((r) => setBranchId(r.branchId)).catch(() => {});
  }, []);
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? 'an item';

  const save = async (o: Partial<Offer>) => {
    const c = cleanOffer(o);
    if (!c.ok) { setError((c as { error: string }).error); return; }
    setSaving(true); setError('');
    try {
      await posApi.manage.saveOffer({ ...(c as { offer: Offer }).offer, id: o.id ?? '' });
      setEditing(null);
      load();
    } catch (e: any) { setError(e?.message ?? 'Could not save the offer.'); }
    finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    setError('');
    try { await posApi.manage.deleteOffer(id); setDeleting(null); load(); }
    catch (e: any) { setError(e?.message ?? 'Could not delete the offer.'); }
  };

  const now = new Date();
  const where = (o: Offer) => !o.branch_ids ? 'Every branch'
    : o.branch_ids.length === 1 && o.branch_ids[0] === branchId ? 'This branch' : `${o.branch_ids.length} branch${o.branch_ids.length === 1 ? '' : 'es'}`;

  if (editing) {
    return <OfferForm draft={editing} onChange={setEditing} onSave={() => save(editing)} onCancel={() => { setEditing(null); setError(''); }}
      saving={saving} error={error} products={products} categories={categories} isOwner={isOwner} branchId={branchId} currency={currency} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold">Offers</h2>
          <p className="text-xs text-gray-400 mt-0.5">They apply by themselves at the POS and on the web, on the days and hours you set. A cashier can still add a discount on top, up to the usual limit.</p>
        </div>
        <button data-testid="offer-new" onClick={() => setEditing({ ...blank(), branch_ids: isOwner ? null : (branchId ? [branchId] : null) })}
          className="shrink-0 px-3 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">+ New offer</button>
      </div>
      {error && <p className="text-sm text-red-300 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
      {loading && <p className="text-sm text-gray-400">Loading…</p>}
      {!loading && rows.length === 0 && !error && <p className="text-sm text-gray-400 py-8 text-center">No offers yet.</p>}
      <div className="grid gap-3">
        {rows.map((o) => {
          const running = offerRunsAt(o, now, branchId);
          return (
            <div key={o.id} data-testid="offer-row" className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white font-medium">{o.name}</p>
                  <p className="text-sm text-gray-300 mt-0.5">{offerWhatLabel(o, productName)}</p>
                  <p className="text-xs text-gray-400 mt-1">{offerWhenLabel(o)} · {where(o)}</p>
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                  !o.active ? 'bg-gray-700 text-gray-300' : running ? 'bg-amber-500/20 text-amber-200' : 'bg-blue-500/15 text-blue-200'}`}>
                  {!o.active ? 'Off' : running ? 'Running now' : 'Scheduled'}
                </span>
              </div>
              {o.editable !== false ? (
                <div className="flex flex-wrap gap-2 mt-3">
                  <button onClick={() => save({ ...o, active: !o.active })} className={chip(false)}>{o.active ? 'Switch off' : 'Switch on'}</button>
                  <button onClick={() => setEditing(o)} className={chip(false)}>Edit</button>
                  {deleting === o.id ? (
                    <>
                      <button data-testid="offer-delete-yes" onClick={() => remove(o.id)} className="px-3 py-1.5 rounded-lg text-xs border border-red-500/60 text-red-200">Delete it</button>
                      <button onClick={() => setDeleting(null)} className={chip(false)}>Keep it</button>
                    </>
                  ) : <button onClick={() => setDeleting(o.id)} className="px-3 py-1.5 rounded-lg text-xs border border-red-500/30 text-red-300">Delete</button>}
                </div>
              ) : <p className="text-xs text-gray-500 mt-3">Set by the owner for more than this branch — only the owner changes it.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── The form ───────────────────────────────────────────────────────────────────

function OfferForm({ draft, onChange, onSave, onCancel, saving, error, products, categories, isOwner, branchId, currency }: {
  draft: Partial<Offer>; onChange: (d: Partial<Offer>) => void; onSave: () => void; onCancel: () => void; saving: boolean;
  error: string; products: Named[]; categories: Named[]; isOwner: boolean; branchId: string | null; currency: string;
}) {
  const set = (patch: Partial<Offer>) => onChange({ ...draft, ...patch });
  const kind = draft.kind ?? 'percent_off';
  const usesItems = kind === 'percent_off' || kind === 'amount_off' || kind === 'special_price' || kind === 'buy_get';
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const days = draft.days ?? [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    set({ days: next.length && next.length < 7 ? next : null });
  };
  const parts = draft.meal_items ?? [];
  const setPart = (i: number, p: Partial<MealPart>) => set({ meal_items: parts.map((x, n) => (n === i ? { ...x, ...p } : x)) });

  return (
    <div className="space-y-5 max-w-2xl" data-testid="offer-form">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold">{draft.id ? 'Edit offer' : 'New offer'}</h2>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white">Cancel</button>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Name (the cashier and the receipt show it)</span>
        <input className={input} value={draft.name ?? ''} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Happy hour" />
      </label>

      <div className="space-y-1.5">
        <span className="text-xs text-gray-400">What kind of offer</span>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => <button key={k.kind} onClick={() => set({ kind: k.kind })} className={chip(kind === k.kind)}>{k.label}</button>)}
        </div>
        <p className="text-xs text-gray-500">{KINDS.find((k) => k.kind === kind)?.hint}</p>
      </div>

      {kind === 'percent_off' && <Field label="% off"><input type="number" min="1" max="100" className={input} value={draft.value || ''} onChange={(e) => set({ value: num(e.target.value) })} /></Field>}
      {kind === 'amount_off' && <Field label={`Amount off each item (${currency})`}><input type="number" min="0" className={input} value={draft.value || ''} onChange={(e) => set({ value: num(e.target.value) })} /></Field>}
      {kind === 'special_price' && <Field label={`Special price of each item (${currency})`}><input type="number" min="0" className={input} value={draft.value ?? ''} onChange={(e) => set({ value: num(e.target.value) })} /></Field>}
      {kind === 'buy_get' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Buy"><input type="number" min="1" className={input} value={draft.buy_qty || ''} onChange={(e) => set({ buy_qty: num(e.target.value) })} /></Field>
          <Field label="Get free"><input type="number" min="1" className={input} value={draft.get_qty || ''} onChange={(e) => set({ get_qty: num(e.target.value) })} /></Field>
          <div className="col-span-2">
            <Field label="Which item is free">
              <select className={input} value={draft.get_product_id ?? ''} onChange={(e) => set({ get_product_id: e.target.value || null })}>
                <option value="">The same items as bought (the cheapest is free)</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} (must be in the order)</option>)}
              </select>
            </Field>
          </div>
        </div>
      )}
      {kind === 'spend_get' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={`When the bill reaches (${currency})`}><input type="number" min="0" className={input} value={draft.min_spend || ''} onChange={(e) => set({ min_spend: num(e.target.value) })} /></Field>
          <Field label="The customer gets">
            <div className="flex gap-2">
              <input type="number" min="0" className={input} value={draft.value || ''} onChange={(e) => set({ value: num(e.target.value) })} />
              <select className={`${input} w-24`} value={draft.spend_type ?? 'percent'} onChange={(e) => set({ spend_type: e.target.value as Offer['spend_type'] })}>
                <option value="percent">% off</option><option value="amount">{currency} off</option>
              </select>
            </div>
          </Field>
        </div>
      )}
      {kind === 'meal' && (
        <div className="space-y-3">
          <Field label={`Meal price (${currency})`}><input type="number" min="0" className={input} value={draft.value || ''} onChange={(e) => set({ value: num(e.target.value) })} /></Field>
          <p className="text-xs text-gray-400">The meal is made of these parts. When the order has them all, they cost the meal price.</p>
          {parts.map((p, i) => (
            <div key={i} className="bg-gray-900 border border-gray-700 rounded-xl p-3 space-y-2">
              <div className="flex gap-2">
                <input className={input} placeholder="Part name, e.g. Drink" value={p.label} onChange={(e) => setPart(i, { label: e.target.value })} />
                <input type="number" min="1" className={`${input} w-20`} value={p.qty} onChange={(e) => setPart(i, { qty: Math.max(1, num(e.target.value)) })} />
                <button onClick={() => set({ meal_items: parts.filter((_, n) => n !== i) })} className="text-red-300 text-sm px-2">Remove</button>
              </div>
              <PickList label="Any of these categories" items={categories} picked={p.category_ids} onChange={(v) => setPart(i, { category_ids: v })} />
              <PickList label="…or these items" items={products} picked={p.product_ids} onChange={(v) => setPart(i, { product_ids: v })} />
            </div>
          ))}
          <button onClick={() => set({ meal_items: [...parts, { label: '', product_ids: [], category_ids: [], qty: 1 }] })} className={chip(false)}>+ Add a part</button>
        </div>
      )}

      {usesItems && (
        <div className="space-y-2">
          <span className="text-xs text-gray-400">{kind === 'buy_get' ? 'Which items count as bought' : 'Which items'}</span>
          <div className="flex gap-2">
            {(['all', 'categories', 'products'] as const).map((a) => (
              <button key={a} onClick={() => set({ applies_to: a })} className={chip((draft.applies_to ?? 'all') === a)}>
                {a === 'all' ? 'Everything' : a === 'categories' ? 'Chosen categories' : 'Chosen items'}
              </button>
            ))}
          </div>
          {draft.applies_to === 'categories' && <PickList label="Categories" items={categories} picked={draft.category_ids ?? []} onChange={(v) => set({ category_ids: v })} />}
          {draft.applies_to === 'products' && <PickList label="Items" items={products} picked={draft.product_ids ?? []} onChange={(v) => set({ product_ids: v })} />}
        </div>
      )}

      <div className="space-y-2 border-t border-gray-800 pt-4">
        <span className="text-xs text-gray-400">When it runs (leave empty for always)</span>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From date"><input type="date" className={input} value={draft.start_date ?? ''} onChange={(e) => set({ start_date: e.target.value || null })} /></Field>
          <Field label="To date"><input type="date" className={input} value={draft.end_date ?? ''} onChange={(e) => set({ end_date: e.target.value || null })} /></Field>
          <Field label="From time"><input type="time" className={input} value={draft.start_time ?? ''} onChange={(e) => set({ start_time: e.target.value || null })} /></Field>
          <Field label="To time"><input type="time" className={input} value={draft.end_time ?? ''} onChange={(e) => set({ end_time: e.target.value || null })} /></Field>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => <button key={d} onClick={() => toggleDay(i)} className={chip(days.includes(i))}>{d}</button>)}
          <span className="text-xs text-gray-500 self-center ml-1">{days.length ? '' : 'Every day'}</span>
        </div>
      </div>

      <div className="space-y-2 border-t border-gray-800 pt-4">
        <span className="text-xs text-gray-400">Where it runs</span>
        {isOwner ? (
          <div className="flex gap-2">
            <button onClick={() => set({ branch_ids: null })} className={chip(!draft.branch_ids)}>Every branch</button>
            <button onClick={() => set({ branch_ids: branchId ? [branchId] : null })} className={chip(!!draft.branch_ids)} disabled={!branchId}>This branch only</button>
          </div>
        ) : <p className="text-sm text-gray-300">This branch</p>}
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={draft.active !== false} onChange={(e) => set({ active: e.target.checked })} /> On
        </label>
      </div>

      {error && <p className="text-sm text-red-300 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
      <div className="flex gap-2">
        <button data-testid="offer-save" onClick={onSave} disabled={saving} className="px-4 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-50">
          {saving ? 'Saving…' : 'Save offer'}
        </button>
        <button onClick={onCancel} className={chip(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-xs text-gray-400">{label}</span>{children}</label>;
}

function PickList({ label, items, picked, onChange }: { label: string; items: Named[]; picked: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [items, q]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">{label}{picked.length ? ` · ${picked.length} chosen` : ''}</span>
        <input className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white w-40" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-40 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg divide-y divide-gray-800">
        {shown.map((i) => (
          <label key={i.id} className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-200 cursor-pointer hover:bg-gray-800">
            <input type="checkbox" checked={picked.includes(i.id)}
              onChange={(e) => onChange(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))} />
            {i.name}
          </label>
        ))}
        {shown.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">Nothing matches.</p>}
      </div>
    </div>
  );
}
