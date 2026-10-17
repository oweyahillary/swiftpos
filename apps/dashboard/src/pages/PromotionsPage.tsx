import { useState, useEffect, useMemo } from 'react';
import { useTerm } from '../lib/terminology';
import { api } from '../lib/api';
import type { PosApi } from '../context/POSAuthContext';   // A502
import ConfirmModal, { useConfirm } from '../components/ConfirmModal';
import { money } from '../lib/format';
import { useBusiness } from '../context/BusinessContext';

interface Promotion {
  id: string;
  name: string;
  promo_type: 'happy_hour' | 'bogo' | 'quantity_discount';
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  days_of_week: number[];
  applies_to: 'all' | 'category' | 'product';
  product_ids: string[];
  category_ids: string[];
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: number | null;
  min_quantity: number;
  free_quantity: number | null;
  status: 'active' | 'inactive';
  effective_status?: 'active' | 'inactive' | 'expired' | 'scheduled';
  /** A518: charged at the sale now (the cloud's word), and if not, why. */
  charged_at_sale?: boolean;
  not_charged_reason?: string | null;
  created_at: string;
}

type PromoType  = Promotion['promo_type'];
type AppliesTo  = Promotion['applies_to'];
type DiscountType = 'percentage' | 'fixed';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALL_DAYS   = [0, 1, 2, 3, 4, 5, 6];

const TYPE_META: Record<PromoType, { icon: string; label: string; color: string; bg: string }> = {
  happy_hour:        { icon: '🕐', label: 'Happy Hour',     color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20' },
  bogo:              { icon: '🎁', label: 'BOGO',           color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20' },
  quantity_discount: { icon: '📦', label: 'Qty Discount',   color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20' },
};

interface FormState {
  name: string;
  promo_type: PromoType;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  applies_to: AppliesTo;
  discount_type: DiscountType;
  discount_value: string;
  min_quantity: string;
  free_quantity: string;
  product_ids: string[];    // A518: the picker
  category_ids: string[];
}

const BLANK_FORM: FormState = {
  name: '', promo_type: 'happy_hour',
  start_date: '', end_date: '',
  start_time: '', end_time: '',
  days_of_week: ALL_DAYS,
  applies_to: 'all',
  discount_type: 'percentage',
  discount_value: '10',
  min_quantity: '2',
  free_quantity: '1',
  product_ids: [], category_ids: [],
};

interface Named { id: string; name: string }

/** A518: the names a promotion is for, for its card ("Chips, Soda +3"). Unknown ids (deleted since) are left out. */
export function scopeLabel(ids: string[], items: Named[], max = 3): string {
  const byId = new Map(items.map((i) => [i.id, i.name]));
  const names = ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
  if (!names.length) return '';
  return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
}

/**
 * A518: the products or categories a promotion is for — the chosen ones as chips (✕ takes one off), a search over the
 * business's own, and a click to add. The page's own look (gray-950 inputs, swift accents).
 */
function ScopePicker({ label, items, picked, onChange }: { label: string; items: Named[]; picked: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i.name])), [items]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => !picked.includes(i.id) && (!s || i.name.toLowerCase().includes(s))).slice(0, 100);
  }, [items, picked, q]);
  return (
    <div className="space-y-2" data-testid="promotion-scope-picker">
      <div className="flex flex-wrap gap-1.5">
        {picked.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full border border-swift/40 bg-swift/10 px-2.5 py-1 text-xs text-swift-text">
            {byId.get(id) ?? 'Removed item'}
            <button type="button" aria-label={`Remove ${byId.get(id) ?? 'item'}`} onClick={() => onChange(picked.filter((x) => x !== id))}
              className="text-gray-400 hover:text-white">✕</button>
          </span>
        ))}
        {!picked.length && <span className="text-xs text-gray-600">No {label.toLowerCase()} chosen yet.</span>}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`}
        className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2 text-white text-sm focus:outline-none focus:border-swift" />
      <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
        {shown.map((i) => (
          <button key={i.id} type="button" onClick={() => { onChange([...picked, i.id]); setQ(''); }}
            className="block w-full px-3.5 py-2 text-left text-sm text-gray-300 hover:bg-gray-800 hover:text-white">+ {i.name}</button>
        ))}
        {!shown.length && <p className="px-3.5 py-2 text-xs text-gray-600">{items.length ? 'Nothing else matches.' : `No ${label.toLowerCase()} yet.`}</p>}
      </div>
    </div>
  );
}

function fmtTime(t: string | null): string {
  if (!t) return '—';
  const [h, m] = t.split(':');
  const hour = Number(h);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function fmtDays(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if (JSON.stringify([...days].sort()) === JSON.stringify([1,2,3,4,5])) return 'Weekdays';
  if (JSON.stringify([...days].sort()) === JSON.stringify([0,6])) return 'Weekends';
  return days.map(d => DAY_LABELS[d]).join(', ');
}

/** A502: the owner's dashboard uses its own session; the manager portal passes the signed-in person's (posApi) — for
 *  someone the owner gave menu.promotions. */
export default function PromotionsPage({ client = api }: { client?: PosApi } = {}) {
  const currency = useBusiness().business?.currency ?? 'KES';   // A471: the business currency, not a hard-coded KES
  const { term } = useTerm();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [promos, setPromos]     = useState<Promotion[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState<Promotion | null>(null);
  const [form, setForm]         = useState<FormState>(BLANK_FORM);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  // A506: a refused load / switch / delete is said (it read as "No promotions yet", or nothing happened).
  const [listError, setListError] = useState('');

  // A518: the business's own products and categories, for "Specific products / categories" (and their names on the list).
  const [products, setProducts]     = useState<Named[]>([]);
  const [categories, setCategories] = useState<Named[]>([]);
  const [pickError, setPickError]   = useState('');

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const named = (rows: any[] | null | undefined): Named[] => (Array.isArray(rows) ? rows : [])
      .filter((x) => x && x.id && x.name).map((x) => ({ id: String(x.id), name: String(x.name) }));
    client.get<any[]>('/api/products').then((p) => setProducts(named(p)))
      .catch((e: any) => setPickError(e?.message ?? 'Could not load the products'));
    client.get<any[]>('/api/categories').then((c) => setCategories(named(c)))
      .catch((e: any) => setPickError(e?.message ?? 'Could not load the categories'));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps — posApi is a new object every render

  async function load() {
    setLoading(true);
    try {
      const data = await client.get<Promotion[]>('/api/promotions');
      setPromos(data ?? []);
      setListError('');
    } catch (e: any) { setListError(e?.message ?? 'Could not load the promotions'); }
    finally { setLoading(false); }
  }

  function openCreate() {
    setEditing(null);
    setForm(BLANK_FORM);
    setError('');
    setShowForm(true);
  }

  function openEdit(p: Promotion) {
    setEditing(p);
    setForm({
      name:           p.name,
      promo_type:     p.promo_type,
      start_date:     p.start_date ?? '',
      end_date:       p.end_date ?? '',
      start_time:     p.start_time ?? '',
      end_time:       p.end_time ?? '',
      days_of_week:   p.days_of_week,
      applies_to:     p.applies_to,
      discount_type:  p.discount_type ?? 'percentage',
      discount_value: p.discount_value != null ? String(p.discount_value) : '',
      min_quantity:   String(p.min_quantity),
      free_quantity:  p.free_quantity != null ? String(p.free_quantity) : '1',
      product_ids:    p.product_ids ?? [],
      category_ids:   p.category_ids ?? [],
    });
    setError('');
    setShowForm(true);
  }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (form.promo_type !== 'bogo' && !form.discount_value) {
      setError('Discount value is required'); return;
    }
    if (form.applies_to === 'product' && !form.product_ids.length) { setError('Choose the products this promotion is for.'); return; }
    if (form.applies_to === 'category' && !form.category_ids.length) { setError('Choose the categories this promotion is for.'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        name:           form.name.trim(),
        promo_type:     form.promo_type,
        start_date:     form.start_date   || null,
        end_date:       form.end_date     || null,
        start_time:     form.start_time   || null,
        end_time:       form.end_time     || null,
        days_of_week:   form.days_of_week,
        applies_to:     form.applies_to,
        // A518: only the list the scope uses (the cloud empties the other too).
        product_ids:    form.applies_to === 'product' ? form.product_ids : [],
        category_ids:   form.applies_to === 'category' ? form.category_ids : [],
        applies_at_sale: true,   // A518: a promotion saved here is charged at the sale
        discount_type: form.promo_type !== 'bogo' ? form.discount_type : null,
        discount_value: form.promo_type !== 'bogo' && form.discount_value
          ? Number(form.discount_value) : null,
        min_quantity:   Number(form.min_quantity) || 1,
        free_quantity:  form.promo_type === 'bogo' ? Number(form.free_quantity) || 1 : null,
      };
      if (editing) {
        await client.patch(`/api/promotions/${editing.id}`, payload);
      } else {
        await client.post('/api/promotions', payload);
      }
      setShowForm(false);
      await load();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save');
    } finally { setSaving(false); }
  }

  async function toggle(p: Promotion) {
    try {
      await client.patch(`/api/promotions/${p.id}`, {
        status: p.status === 'active' ? 'inactive' : 'active',
      });
      setPromos(prev => prev.map(x =>
        x.id === p.id ? { ...x, status: x.status === 'active' ? 'inactive' : 'active' } : x
      ));
    } catch (e: any) { setListError(e?.message ?? 'Could not change the promotion'); }
  }

  async function remove(id: string) {
    showConfirm({
      title: 'Delete promotion?',
      message: 'This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await client.delete(`/api/promotions/${id}`);
          setPromos(prev => prev.filter(p => p.id !== id));
        } catch (e: any) { setListError(e?.message ?? 'Could not delete the promotion'); }
      },
    });
  }

  function setF<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }));
  }

  function toggleDay(day: number) {
    const days = form.days_of_week;
    setF('days_of_week', days.includes(day)
      ? days.filter(d => d !== day)
      : [...days, day].sort((a, b) => a - b)
    );
  }

  const type = form.promo_type;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-6 pb-4 border-b border-gray-800 flex-shrink-0 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-white text-xl sm:text-2xl font-bold">{term('promotions')}</h1>
          <p className="text-gray-500 text-sm mt-1">
            Happy hour and BOGO deals — charged at every till and the web POS, at every branch
          </p>
        </div>
        <button onClick={openCreate}
          className="px-4 py-2 bg-swift-strong hover:bg-swift-deep text-white text-sm font-bold rounded-lg transition-colors">
          + New promotion
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {listError && <p className="mb-3 text-sm text-red-400" data-testid="promotions-error">{listError}</p>}
        {loading ? (
          <div className="text-center py-16 text-gray-500 text-sm">Loading…</div>
        ) : promos.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">🎉</p>
            <p className="text-gray-400 text-sm mb-1">No promotions yet.</p>
            <p className="text-gray-600 text-xs">
              Create a happy hour or BOGO deal — it will apply automatically at checkout.
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl">
            {promos.map(p => {
              const meta = TYPE_META[p.promo_type];
              return (
                <div key={p.id}
                  className={`border rounded-xl p-4 ${
                    p.status === 'active'
                      ? 'border-gray-800 bg-gray-900'
                      : 'border-gray-800/50 bg-gray-900/40 opacity-60'
                  }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="text-2xl flex-shrink-0">{meta.icon}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <p className="text-white font-semibold">{p.name}</p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.bg} ${meta.color}`}>
                            {meta.label}
                          </span>
                          {p.status === 'active' && (
                            <span className="text-[10px] text-green-400 font-semibold">● Active</span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                          {p.promo_type === 'happy_hour' && <>
                            <span>⏰ {fmtTime(p.start_time)} – {fmtTime(p.end_time)}</span>
                            <span>📅 {fmtDays(p.days_of_week)}</span>
                            {p.discount_value != null && (
                              <span>💰 {p.discount_type === 'percentage' ? `${p.discount_value}% off` : `${money(p.discount_value, currency)} off`}</span>
                            )}
                          </>}
                          {p.promo_type === 'bogo' && <>
                            <span>🛒 Buy {p.min_quantity} get {p.free_quantity} free</span>
                            <span>📅 {fmtDays(p.days_of_week)}</span>
                          </>}
                          {p.promo_type === 'quantity_discount' && <>
                            <span>🛒 {p.min_quantity}+ items</span>
                            {p.discount_value != null && (
                              <span>💰 {p.discount_type === 'percentage' ? `${p.discount_value}% off` : `${money(p.discount_value, currency)} off`}</span>
                            )}
                            <span>📅 {fmtDays(p.days_of_week)}</span>
                          </>}
                          {p.applies_to !== 'all' && (
                            <span className="text-violet-400" data-testid="promotion-scope">
                              {p.applies_to === 'product' ? 'Only ' : 'Only in '}
                              {(p.applies_to === 'product' ? scopeLabel(p.product_ids ?? [], products) : scopeLabel(p.category_ids ?? [], categories))
                                || (p.applies_to === 'product' ? 'no products chosen' : 'no categories chosen')}
                            </span>
                          )}
                          {p.status === 'active' && p.charged_at_sale === false && p.not_charged_reason && (
                            <span className="text-amber-400" data-testid="promotion-not-charged">Not charged at the till: {p.not_charged_reason}</span>
                          )}
                          {(p.start_date || p.end_date) && (
                            <span>📆 {p.start_date ?? '…'} → {p.end_date ?? '…'}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {(p.effective_status === 'expired' || p.effective_status === 'scheduled') && (
                        <span className={`text-[10px] px-2 py-1 rounded-lg font-semibold border ${
                          p.effective_status === 'expired'
                            ? 'text-amber-400 border-amber-500/30'
                            : 'text-blue-400 border-blue-500/30'
                        }`}>
                          {p.effective_status === 'expired' ? 'Expired' : 'Scheduled'}
                        </span>
                      )}
                      <button onClick={() => toggle(p)}
                        className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                          p.status === 'active'
                            ? 'border-green-500/30 text-green-400 hover:bg-green-500/10'
                            : 'border-gray-700 text-gray-500 hover:border-gray-600'
                        }`}>
                        {p.status === 'active' ? 'Active' : 'Inactive'}
                      </button>
                      <button onClick={() => openEdit(p)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition-colors">
                        Edit
                      </button>
                      <button onClick={() => remove(p.id)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-colors">
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
              <h3 className="text-white font-bold">{editing ? 'Edit promotion' : 'New promotion'}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                  Name *
                </label>
                <input value={form.name} onChange={e => setF('name', e.target.value)}
                  placeholder="e.g. Happy Hour, Lunch Special, Buy 2 Get 1"
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
              </div>

              {/* Type */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Type</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(['happy_hour', 'bogo', 'quantity_discount'] as PromoType[]).map(t => {
                    const meta = TYPE_META[t];
                    return (
                      <button key={t} onClick={() => setF('promo_type', t)}
                        className={`p-3 rounded-xl border-2 text-center transition-colors ${
                          type === t ? 'border-swift bg-swift/10' : 'border-gray-700 hover:border-gray-600'
                        }`}>
                        <div className="text-xl mb-1">{meta.icon}</div>
                        <div className={`text-xs font-semibold ${type === t ? 'text-swift-text' : 'text-gray-400'}`}>
                          {meta.label}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Days of week */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Active days</label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAY_LABELS.map((label, i) => (
                    <button key={i} onClick={() => toggleDay(i)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                        form.days_of_week.includes(i)
                          ? 'bg-swift-strong border-swift-strong text-white'
                          : 'border-gray-700 text-gray-500 hover:border-gray-600'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time window — happy hour only */}
              {type === 'happy_hour' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Start time</label>
                    <input type="time" value={form.start_time} onChange={e => setF('start_time', e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">End time</label>
                    <input type="time" value={form.end_time} onChange={e => setF('end_time', e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                  </div>
                </div>
              )}

              {/* Date range */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Start date (optional)</label>
                  <input type="date" value={form.start_date} onChange={e => setF('start_date', e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">End date (optional)</label>
                  <input type="date" value={form.end_date} onChange={e => setF('end_date', e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                </div>
              </div>

              {/* Quantity rules — BOGO and qty_discount */}
              {(type === 'bogo' || type === 'quantity_discount') && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                      {type === 'bogo' ? 'Buy (qty)' : 'Min quantity'}
                    </label>
                    <input type="number" min={1} value={form.min_quantity}
                      onChange={e => setF('min_quantity', e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                  </div>
                  {type === 'bogo' && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Get free (qty)</label>
                      <input type="number" min={1} value={form.free_quantity}
                        onChange={e => setF('free_quantity', e.target.value)}
                        className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
                    </div>
                  )}
                </div>
              )}

              {/* Discount — not BOGO */}
              {type !== 'bogo' && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Discount</label>
                  <div className="flex gap-2">
                    <div className="flex gap-1 bg-gray-800 p-1 rounded-lg flex-shrink-0">
                      {(['percentage', 'fixed'] as DiscountType[]).map(dt => (
                        <button key={dt} onClick={() => setF('discount_type', dt)}
                          className={`text-xs px-3 py-1 rounded-md transition-colors ${
                            form.discount_type === dt ? 'bg-gray-700 text-white' : 'text-gray-500'
                          }`}>
                          {dt === 'percentage' ? '% off' : `${currency} off`}
                        </button>
                      ))}
                    </div>
                    <input type="number" min={0} value={form.discount_value}
                      onChange={e => setF('discount_value', e.target.value)}
                      placeholder={form.discount_type === 'percentage' ? '10' : '100'}
                      className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
                  </div>
                </div>
              )}

              {/* Applies to */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Applies to</label>
                <div className="flex gap-2">
                  {(['all', 'product', 'category'] as AppliesTo[]).map(a => (
                    <button key={a} onClick={() => setF('applies_to', a)}
                      className={`flex-1 py-2 rounded-lg border text-xs font-semibold capitalize transition-colors ${
                        form.applies_to === a
                          ? 'border-swift bg-swift/10 text-swift-text'
                          : 'border-gray-700 text-gray-500 hover:border-gray-600'
                      }`}>
                      {a === 'all' ? 'All items' : a === 'product' ? 'Specific products' : 'Specific categories'}
                    </button>
                  ))}
                </div>
                {/* A518: which products / categories — it is charged on those lines only */}
                {form.applies_to !== 'all' && (
                  <div className="mt-3">
                    {pickError && <p className="mb-2 text-xs text-red-400" role="alert">{pickError}</p>}
                    {form.applies_to === 'product'
                      ? <ScopePicker label="Products" items={products} picked={form.product_ids} onChange={(v) => setF('product_ids', v)} />
                      : <ScopePicker label="Categories" items={categories} picked={form.category_ids} onChange={(v) => setF('category_ids', v)} />}
                  </div>
                )}
              </div>
              {type === 'quantity_discount' && (
                <p className="text-xs text-amber-400">A quantity discount is not charged at the till yet - set it up as an Offer (Menu › Offers) to charge it.</p>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 text-sm text-red-400">
                  {error}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-2.5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-gray-700 rounded-lg text-gray-400 text-sm hover:border-gray-600 transition-colors">
                Cancel
              </button>
              <button onClick={save} disabled={saving}
                className="flex-1 py-2.5 bg-swift-strong hover:bg-swift-deep disabled:opacity-40 rounded-lg text-white text-sm font-bold transition-colors">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create promotion'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
