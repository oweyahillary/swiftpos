/**
 * ManageTabs — catalogue and staff editing from the till.
 *
 * The client runs desktop-only, so without these she has to phone us to add a
 * product or reprice one — which for a fast food place is a daily event, not an
 * occasional one.
 *
 * Every write here is ONLINE-ONLY. Sales queue offline because a sale must never
 * be refused; catalogue edits must not, because two tills inventing the same
 * product on a dead network produces duplicates with no sane merge. The IPC layer
 * fails with a plain-language message and these screens surface it as-is.
 *
 * Permissions are enforced SERVER-side (products.manage, staff.manage). These
 * screens hide what the role can't do as a courtesy, but hiding a button is not
 * the control — the API is.
 */

import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { parseCsvRows, csvBool } from '../lib/csv';
import type { CsvRow } from '../lib/csv';

const input =
  'w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white ' +
  'placeholder-gray-400 focus:outline-none focus:border-green-500 transition-colors';
const label = 'block text-xs text-gray-400 mb-1';
const btn =
  'bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed ' +
  'text-gray-950 font-semibold rounded-lg px-4 py-2 transition-colors';

function Banner({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  if (!text) return null;
  return (
    <div
      className={`rounded-lg px-3 py-2 text-sm mb-3 ${
        kind === 'ok'
          ? 'bg-green-500/10 border border-green-500/30 text-green-300'
          : 'bg-red-500/10 border border-red-500/30 text-red-300'
      }`}
    >
      {text}
    </div>
  );
}

/* ── Menu: products + categories ──────────────────────────────────────────── */

export function MenuTab({ currency }: { currency: string }) {
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const [showNew, setShowNew] = useState(false);

  const blank = { name: '', base_price: '', category_id: '', description: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => {
    setLoading(true);
    try {
      const [p, c] = await Promise.all([posApi.manage.listProducts(), posApi.manage.listCategories()]);
      setProducts(Array.isArray(p) ? p : []);
      setCategories(Array.isArray(c) ? c : []);
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load the menu.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const flash = (msg: string) => { setOk(msg); setTimeout(() => setOk(''), 3000); };

  const save = async () => {
    const price = parseFloat(form.base_price);
    if (!form.name.trim()) { setErr('Name is required.'); return; }
    if (!Number.isFinite(price) || price < 0) { setErr('Enter a valid price.'); return; }

    setBusy(true); setErr('');
    try {
      const payload = {
        name: form.name.trim(),
        base_price: price,
        category_id: form.category_id || null,
        description: form.description?.trim() || null,
        // Stock is not tracked for this client, and a product created here must
        // not silently start deducting against records that don't exist.
        track_stock: false,
      };
      if (editing) {
        await posApi.manage.updateProduct(editing.id, payload);
        flash(`Updated ${payload.name}`);
      } else {
        await posApi.manage.createProduct(payload);
        flash(`Added ${payload.name}`);
      }
      setEditing(null); setShowNew(false); setForm(blank);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Cycles the kitchen routing override: inherit → always → never → inherit.
   *
   * Three states, not two, and the middle one matters. Almost every product
   * should stay on "inherit" so the category remains the single place a routing
   * decision is made; the override exists for the handful that genuinely differ
   * from their neighbours — cole slaw sitting in a category of hot sides.
   */
  const cycleKitchen = async (p: any) => {
    const current: boolean | null =
      p.is_kitchen === true || p.is_kitchen === 1 ? true
      : p.is_kitchen === false || p.is_kitchen === 0 ? false
      : null;
    const next = current === null ? true : current === true ? false : null;
    setBusy(true); setErr('');
    try {
      await posApi.manage.updateProduct(p.id, { is_kitchen: next });
      flash(next === null ? `${p.name} follows its category again`
          : next ? `${p.name} always goes to the kitchen`
                 : `${p.name} never goes to the kitchen`);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not update.');
    } finally { setBusy(false); }
  };

  const toggleStatus = async (p: any) => {
    setBusy(true); setErr('');
    try {
      const next = p.status === 'active' ? 'inactive' : 'active';
      await posApi.manage.updateProduct(p.id, { status: next });
      flash(next === 'active' ? `${p.name} back on the menu` : `${p.name} hidden from the till`);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not update.');
    } finally {
      setBusy(false);
    }
  };

  const shown = products.filter(p =>
    !search.trim() || p.name?.toLowerCase().includes(search.trim().toLowerCase()));

  if (loading) return <p className="text-gray-300 p-4">Loading menu…</p>;

  return (
    <div className="p-4 max-w-3xl">
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <div className="flex gap-2 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search products" className={input} />
        <button
          onClick={() => { setShowNew(v => !v); setEditing(null); setForm(blank); }}
          className={btn}>
          {showNew ? 'Cancel' : 'Add product'}
        </button>
      </div>

      {(showNew || editing) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <p className="text-white font-semibold">{editing ? `Edit ${editing.name}` : 'New product'}</p>
          <div>
            <label className={label}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Chicken Burger" className={input} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Price ({currency})</label>
              <input value={form.base_price} inputMode="decimal"
                onChange={e => setForm({ ...form, base_price: e.target.value })}
                placeholder="450" className={input} />
            </div>
            <div>
              <label className={label}>Category</label>
              <select value={form.category_id}
                onChange={e => setForm({ ...form, category_id: e.target.value })}
                className={input}>
                <option value="">— none —</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={label}>Description</label>
            <input value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="Chicken breast, lettuce, tomato, cheddar" className={input} />
            <p className="text-xs text-gray-400 mt-1">
              For a meal, list what's inside — it prints on the packing ticket.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className={btn}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add product'}
            </button>
            <button onClick={() => { setEditing(null); setShowNew(false); setForm(blank); }}
              className="text-gray-400 hover:text-white px-3">Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {shown.length === 0 && <p className="text-gray-300 p-4 text-sm">No products found.</p>}
        {shown.map(p => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className={`truncate ${p.status === 'active' ? 'text-white' : 'text-gray-300 line-through'}`}>
                {p.name}
              </p>
              <p className="text-xs text-gray-300">
                {categories.find(c => c.id === p.category_id)?.name ?? 'Uncategorised'}
              </p>
            </div>
            <span className="text-sm text-gray-300 font-mono">{currency} {Number(p.base_price).toLocaleString()}</span>
            <button
              onClick={() => { setEditing(p); setShowNew(false); setForm({
                name: p.name ?? '', base_price: String(p.base_price ?? ''),
                category_id: p.category_id ?? '', description: p.description ?? '',
              }); }}
              className="text-xs text-gray-400 hover:text-white px-2">Edit</button>
            {(() => {
              const ov: boolean | null =
                p.is_kitchen === true || p.is_kitchen === 1 ? true
                : p.is_kitchen === false || p.is_kitchen === 0 ? false
                : null;
              const inherited = !!categories.find(c => c.id === p.category_id)?.is_kitchen;
              const effective = ov === null ? inherited : ov;
              return (
                <button onClick={() => cycleKitchen(p)} disabled={busy}
                  title={ov === null
                    ? `Follows ${categories.find(c => c.id === p.category_id)?.name ?? 'its category'} — click to override`
                    : ov ? 'Forced to the kitchen — click for never' : 'Never goes to the kitchen — click to follow the category'}
                  className={`text-xs px-2 py-0.5 rounded-md border transition-colors whitespace-nowrap ${
                    effective ? 'border-green-700 text-green-400' : 'border-gray-700 text-gray-300'
                  } ${ov !== null ? 'font-semibold' : 'opacity-80'}`}>
                  {effective ? '🍳 Kitchen' : 'Counter'}{ov !== null ? ' ·' : ''}
                </button>
              );
            })()}
            <button onClick={() => toggleStatus(p)} disabled={busy}
              className="text-xs text-gray-300 hover:text-amber-400 px-2">
              {p.status === 'active' ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
      </div>

      <CategoryBlock categories={categories} onChanged={load} />
    </div>
  );
}

/* ── Categories ───────────────────────────────────────────────────────────── */

function CategoryBlock({ categories, onChanged }: { categories: any[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [isKitchen, setIsKitchen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try {
      await posApi.manage.createCategory({ name: name.trim(), is_kitchen: isKitchen });
      setName(''); setIsKitchen(false);
      onChanged();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add category.');
    } finally { setBusy(false); }
  };

  const toggleKitchen = async (c: any) => {
    setBusy(true); setErr('');
    try {
      await posApi.manage.updateCategory(c.id, { is_kitchen: !c.is_kitchen });
      onChanged();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not update category.');
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-6">
      <p className="text-white font-semibold mb-2">Categories</p>
      <Banner kind="err" text={err} />
      <div className="flex gap-2 mb-3">
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="New category" className={input} />
        <button
          onClick={() => setIsKitchen(v => !v)}
          className={`px-3 rounded-lg border text-xs whitespace-nowrap transition-colors ${
            isKitchen ? 'border-green-500 text-green-400' : 'border-gray-700 text-gray-300'}`}>
          {isKitchen ? 'Kitchen ✓' : 'Kitchen'}
        </button>
        <button onClick={add} disabled={busy || !name.trim()} className={btn}>Add</button>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        Mark a category as <span className="text-gray-400">Kitchen</span> when its items are cooked to order.
        Those appear on the kitchen ticket; drinks, sauces and bought-in items should stay off.
      </p>
      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {categories.map(c => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2">
            <span className="flex-1 text-gray-200 truncate">{c.name}</span>
            <button onClick={() => toggleKitchen(c)} disabled={busy}
              className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                c.is_kitchen ? 'border-green-500 text-green-400' : 'border-gray-700 text-gray-300'}`}>
              {c.is_kitchen ? 'Kitchen' : 'Not kitchen'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Staff ────────────────────────────────────────────────────────────────── */

export function StaffTab({ branchId }: { branchId?: string }) {
  const [staff, setStaff] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', pin: '', role_id: '', override_pin: '' });

  const load = async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([posApi.manage.listStaff(), posApi.manage.listRoles()]);
      setStaff(Array.isArray(s) ? s : []);
      setRoles(Array.isArray(r) ? r : []);
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load staff.');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.name.trim()) { setErr('Name is required.'); return; }
    if (!/^\d{4,6}$/.test(form.pin)) { setErr('PIN must be 4–6 digits.'); return; }
    if (!form.role_id) { setErr('Choose a role.'); return; }
    if (form.override_pin && !/^\d{4,6}$/.test(form.override_pin)) {
      setErr('Override PIN must be 4–6 digits, or left blank.'); return;
    }
    if (form.override_pin && form.override_pin === form.pin) {
      // Same digits means the sign-in PIN silently doubles as void authority —
      // anyone who watches a shift start can then void sales.
      setErr('The override PIN must be different from the sign-in PIN.'); return;
    }

    setBusy(true); setErr('');
    try {
      // branch_ids defaults to [] server-side, and a staff member with no branch
      // has nothing to sign in against. Bind them to the branch this till serves.
      await posApi.manage.createStaff({
        name: form.name.trim(),
        pin: form.pin,
        role_id: form.role_id,
        branch_ids: branchId ? [branchId] : [],
        // Optional. Void authority is granted by HAVING this PIN, not by role
        // name — /api/staff/authorizers selects on override_pin_hash — so
        // without a way to set it here a manager could create a supervisor who
        // still could not authorise anything.
        ...(form.override_pin ? { override_pin: form.override_pin } : {}),
      });
      setOk(`Added ${form.name.trim()}`); setTimeout(() => setOk(''), 3000);
      setForm({ name: '', pin: '', role_id: '', override_pin: '' }); setShowNew(false);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add staff member.');
    } finally { setBusy(false); }
  };

  const toggleActive = async (m: any) => {
    setBusy(true); setErr('');
    try {
      await posApi.manage.updateStaff(m.id, { is_active: !m.is_active });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not update.');
    } finally { setBusy(false); }
  };

  if (loading) return <p className="text-gray-300 p-4">Loading staff…</p>;

  return (
    <div className="p-4 max-w-2xl">
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <button onClick={() => setShowNew(v => !v)} className={`${btn} mb-4`}>
        {showNew ? 'Cancel' : 'Add staff member'}
      </button>

      {showNew && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <div>
            <label className={label}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Melisa Nandy" className={input} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>PIN</label>
              <input value={form.pin} inputMode="numeric" maxLength={6}
                onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
                placeholder="4–6 digits" className={`${input} font-mono tracking-widest`} />
            </div>
            <div>
              <label className={label}>Role</label>
              <select value={form.role_id} onChange={e => setForm({ ...form, role_id: e.target.value })}
                className={input}>
                <option value="">— choose —</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={label}>Override PIN — optional</label>
            <input value={form.override_pin} inputMode="numeric" maxLength={6}
              onChange={e => setForm({ ...form, override_pin: e.target.value.replace(/\D/g, '') })}
              placeholder="leave blank for ordinary staff"
              className={`${input} font-mono tracking-widest`} />
            <p className="text-xs text-gray-400 mt-1">
              Setting this lets the person authorise a void. Void authority comes from
              having this PIN, not from the job title — a supervisor without one cannot
              approve anything. Must differ from the sign-in PIN.
            </p>
          </div>

          <button onClick={add} disabled={busy} className={btn}>
            {busy ? 'Saving…' : 'Add staff member'}
          </button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {staff.map(m => (
          <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className={`truncate ${m.is_active === false ? 'text-gray-300 line-through' : 'text-white'}`}>
                {m.name}
              </p>
              {/* The API nests the role as `roles: { id, name }`. This read
                  `role_name` and `role`, neither of which exists on the
                  payload, so every staff member displayed as "—" and there was
                  no way to tell a cashier from a manager in the list. */}
              <p className="text-xs text-gray-300 capitalize">
                {m.roles?.name ?? m.role_name ?? m.role ?? '—'}
                {m.can_authorize ? ' · can authorise voids' : ''}
              </p>
            </div>
            <button onClick={() => toggleActive(m)} disabled={busy}
              className="text-xs text-gray-300 hover:text-amber-400 px-2">
              {m.is_active === false ? 'Reactivate' : 'Deactivate'}
            </button>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Deactivating stops the PIN working immediately. Staff are never deleted, so
        past sales keep their cashier name.
      </p>
    </div>
  );
}

/* ── Receipt text ─────────────────────────────────────────────────────────── */

export function ReceiptTextTab() {
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    posApi.manage.getReceiptText()
      .then(t => { setHeader(t.header ?? ''); setFooter(t.footer ?? ''); })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await posApi.manage.setReceiptText(header, footer);
      setOk('Saved — applies to every till'); setTimeout(() => setOk(''), 3000);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save.');
    } finally { setBusy(false); }
  };

  const area = `${input} h-28 resize-none font-mono text-sm`;

  return (
    <div className="p-4 max-w-xl space-y-4">
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <div>
        <label className={label}>Header — printed under the business name</label>
        <textarea value={header} onChange={e => setHeader(e.target.value)}
          placeholder={'Kimathi Street, Nairobi\nTel: 0712 345 678\nPIN: P051234567X'}
          className={area} />
      </div>

      <div>
        <label className={label}>Footer — printed at the bottom</label>
        <textarea value={footer} onChange={e => setFooter(e.target.value)}
          placeholder={'Thank you, visit again!\nFollow us @kudokudo_ke'}
          className={area} />
      </div>

      <p className="text-xs text-gray-400">
        One line per line. Blank lines are ignored so a stray return can't waste paper.
        This applies to every till at the business, not just this one.
      </p>

      <button onClick={save} disabled={busy} className={btn}>
        {busy ? 'Saving…' : 'Save receipt text'}
      </button>
    </div>
  );
}

/* ── Combos ───────────────────────────────────────────────────────────────── */

/**
 * A combo is a product sold as one line at one price, expanded into components
 * only on the dispatcher and kitchen tickets. That means the components here are
 * a printing definition, not a pricing one — changing them never changes what the
 * customer pays.
 *
 * Component quantities are PER COMBO. "3 × Chicken Burger" inside a Kanka Combo
 * means each combo contains three, which is how the tickets print them.
 */
export function CombosTab({ currency }: { currency: string }) {
  const [combos, setCombos] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', combo_price: '', category_id: '', description: '' });

  // Component editor for the selected combo
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Array<{ product_id: string; quantity: number }>>([]);
  const [pick, setPick] = useState('');
  const [pickQty, setPickQty] = useState('1');

  const load = async () => {
    setLoading(true);
    try {
      const [c, p, cats] = await Promise.all([
        posApi.manage.listCombos(),
        posApi.manage.listProducts(),
        posApi.manage.listCategories(),
      ]);
      setCombos(Array.isArray(c) ? c : []);
      setProducts(Array.isArray(p) ? p : []);
      setCategories(Array.isArray(cats) ? cats : []);
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load combos.');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(''), 3000); };
  const nameOf = (id: string) => products.find(p => p.id === id)?.name ?? '—';

  // Components must be ordinary products, never other combos — nesting would
  // recurse on the ticket and there is no sane depth limit for a packing sheet.
  const componentChoices = products.filter(p => !p.is_combo && p.status === 'active');

  const create = async () => {
    const price = parseFloat(form.combo_price);
    if (!form.name.trim()) { setErr('Name is required.'); return; }
    if (!Number.isFinite(price) || price <= 0) { setErr('Enter a valid price.'); return; }
    setBusy(true); setErr('');
    try {
      await posApi.manage.createCombo({
        name: form.name.trim(),
        combo_price: price,
        category_id: form.category_id || null,
        description: form.description?.trim() || null,
        items: [],
      });
      flash(`Added ${form.name.trim()} — now add its components`);
      setForm({ name: '', combo_price: '', category_id: '', description: '' });
      setShowNew(false);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not create combo.');
    } finally { setBusy(false); }
  };

  const openEditor = (c: any) => {
    setOpenId(c.id);
    setDraft((c.combo_items ?? []).map((ci: any) => ({
      product_id: ci.product?.id ?? ci.product_id,
      quantity: Number(ci.quantity) || 1,
    })));
    setPick(''); setPickQty('1');
  };

  const addComponent = () => {
    if (!pick) return;
    const qty = Math.max(1, parseInt(pickQty, 10) || 1);
    setDraft(d => d.some(x => x.product_id === pick)
      ? d.map(x => x.product_id === pick ? { ...x, quantity: qty } : x)
      : [...d, { product_id: pick, quantity: qty }]);
    setPick(''); setPickQty('1');
  };

  const saveComponents = async () => {
    if (!openId) return;
    setBusy(true); setErr('');
    try {
      await posApi.manage.setComboItems(openId, draft);
      flash('Components saved');
      setOpenId(null);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save components.');
    } finally { setBusy(false); }
  };

  if (loading) return <p className="text-gray-300 p-4">Loading combos…</p>;

  return (
    <div className="p-4 max-w-3xl">
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <button onClick={() => setShowNew(v => !v)} className={`${btn} mb-4`}>
        {showNew ? 'Cancel' : 'New combo'}
      </button>

      {showNew && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <div>
            <label className={label}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Kanka Combo" className={input} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Price ({currency})</label>
              <input value={form.combo_price} inputMode="decimal"
                onChange={e => setForm({ ...form, combo_price: e.target.value })}
                placeholder="2490" className={input} />
            </div>
            <div>
              <label className={label}>Category</label>
              <select value={form.category_id}
                onChange={e => setForm({ ...form, category_id: e.target.value })} className={input}>
                <option value="">— none —</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Put combos in their own category and leave it <span className="text-gray-400">not kitchen</span> —
            the components route to the kitchen on their own categories, not the combo's.
          </p>
          <button onClick={create} disabled={busy} className={btn}>
            {busy ? 'Saving…' : 'Create combo'}
          </button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {combos.length === 0 && <p className="text-gray-300 p-4 text-sm">No combos yet.</p>}
        {combos.map(c => (
          <div key={c.id}>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-white truncate">{c.name}</p>
                <p className="text-xs text-gray-300">
                  {(c.combo_items ?? []).length} component{(c.combo_items ?? []).length === 1 ? '' : 's'}
                </p>
              </div>
              <span className="text-sm text-gray-300 font-mono">
                {currency} {Number(c.combo_price ?? c.base_price ?? 0).toLocaleString()}
              </span>
              <button onClick={() => openId === c.id ? setOpenId(null) : openEditor(c)}
                className="text-xs text-gray-400 hover:text-white px-2">
                {openId === c.id ? 'Close' : 'Components'}
              </button>
            </div>

            {openId === c.id && (
              <div className="px-4 pb-4 bg-gray-950/40">
                {draft.length === 0 && (
                  <p className="text-xs text-amber-400/80 py-2">
                    No components — the packing ticket would show just the combo name.
                  </p>
                )}
                {draft.map(d => (
                  <div key={d.product_id} className="flex items-center gap-2 py-1">
                    <span className="w-10 text-right font-mono text-gray-300">{d.quantity}×</span>
                    <span className="flex-1 text-gray-200 truncate">{nameOf(d.product_id)}</span>
                    <button
                      onClick={() => setDraft(list => list.filter(x => x.product_id !== d.product_id))}
                      className="text-xs text-gray-300 hover:text-red-400 px-2">Remove</button>
                  </div>
                ))}

                <div className="flex gap-2 mt-3">
                  <select value={pick} onChange={e => setPick(e.target.value)} className={`${input} flex-1`}>
                    <option value="">— add component —</option>
                    {componentChoices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input value={pickQty} inputMode="numeric"
                    onChange={e => setPickQty(e.target.value.replace(/\D/g, ''))}
                    className={`${input} w-16 text-center`} />
                  <button onClick={addComponent} disabled={!pick} className={btn}>Add</button>
                </div>

                <p className="text-xs text-gray-400 mt-2">
                  Quantities are per combo — "3× Chicken Burger" means each combo contains three.
                </p>

                <button onClick={saveComponents} disabled={busy} className={`${btn} mt-3`}>
                  {busy ? 'Saving…' : 'Save components'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <VariantBlock products={products} />
      <AddOnBlock products={products} />
    </div>
  );
}

/* ── Add-ons (modifier groups) ──────────────────────────────────────────────
 *
 * The counterpart to VariantBlock. The distinction is the whole point:
 *
 *   Choices  (variant group)   pick exactly one, changes the unit price
 *   Add-ons  (modifier group)  tick any number, each adds its own price
 *
 * A meal where the chips AND the drink can each be upgraded needs add-ons. Put
 * both upgrades in one variant group and they become mutually exclusive — the
 * customer can have large chips or a bigger soda, never both, which is not what
 * anybody selling meals means.
 */
function AddOnBlock({ products }: { products: any[] }) {
  const [productId, setProductId] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState('Upgrades');
  const [options, setOptions] = useState('Large fries +60, 500ml soda +50');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const loadGroups = async (pid: string) => {
    if (!pid) { setGroups([]); return; }
    try { setGroups(await posApi.manage.listModifierGroups(pid) ?? []); }
    catch (e: any) { setErr(e?.message ?? 'Could not load add-ons.'); }
  };

  const add = async () => {
    if (!productId) { setErr('Choose a product first.'); return; }
    const opts = parseVariantOptions(options);
    if (!name.trim() || opts.length < 1) { setErr('Give the group a name and at least one add-on.'); return; }
    setBusy(true); setErr('');
    try {
      await posApi.manage.createModifierGroup({
        product_id: productId,
        name: name.trim(),
        min_select: 0,          // nothing is compulsory
        max_select: null,       // any combination, including all of them
        options: opts.map(o => ({ name: o.name, price: o.adj })),
      });
      setOk('Add-ons saved'); setTimeout(() => setOk(''), 3000);
      await loadGroups(productId);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save add-ons.');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setErr('');
    try { await posApi.manage.deleteModifierGroup(id); await loadGroups(productId); }
    catch (e: any) { setErr(e?.message ?? 'Could not remove.'); }
    finally { setBusy(false); }
  };

  const parsed = parseVariantOptions(options);
  const base = Number(products.find(p => p.id === productId)?.base_price) || 0;

  return (
    <div className="mt-8">
      <p className="text-white font-semibold mb-2">Add-ons — tick any</p>
      <p className="text-xs text-gray-400 mb-2">
        The cashier may tick none, one, or all of these, and each adds its own price.
        Use where two upgrades are independent — large chips <span className="text-gray-200">and</span> a
        bigger soda, not one or the other.
      </p>
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <select value={productId}
        onChange={e => { setProductId(e.target.value); loadGroups(e.target.value); }}
        className={`${input} mb-3`}>
        <option value="">— choose a product or combo —</option>
        {products.filter(p => p.status === 'active').map(p =>
          <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      {productId && (
        <>
          {groups.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800 mb-3">
              {groups.map(g => (
                <div key={g.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-200">{g.name}</p>
                    <p className="text-xs text-gray-300 truncate">
                      {(g.modifier_options ?? g.options ?? []).map((o: any) => {
                        const pr = Number(o.price) || 0;
                        return pr === 0 ? o.name : `${o.name} +${pr}`;
                      }).join(' · ') || '—'}
                    </p>
                  </div>
                  <button onClick={() => remove(g.id)} disabled={busy}
                    className="text-xs text-gray-300 hover:text-red-400 px-2">Remove</button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Group name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={input} />
              </div>
              <div>
                <label className={label}>Add-ons, comma separated</label>
                <input value={options} onChange={e => setOptions(e.target.value)} className={input}
                  placeholder="Large fries +60, 500ml soda +50" />
              </div>
            </div>

            {parsed.length > 0 && (
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1.5">
                  Base {currencyless(base)} · the cashier can tick any of these
                </p>
                {parsed.map((o, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-200">☐ {o.name}</span>
                    <span className="font-mono text-gray-200">+{currencyless(o.adj)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm border-t border-gray-800 mt-1.5 pt-1.5">
                  <span className="text-gray-400">All ticked</span>
                  <span className="font-mono text-gray-200">
                    {currencyless(base + parsed.reduce((t, o) => t + o.adj, 0))}
                  </span>
                </div>
              </div>
            )}

            <p className="text-xs text-gray-400">
              Put the price after the name: <span className="text-gray-200 font-mono">Large fries +60</span>.
              Leave it off and the add-on is free.
            </p>
            <button onClick={add} disabled={busy} className={btn}>
              {busy ? 'Saving…' : 'Add group'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Variants ─────────────────────────────────────────────────────────────── */

/**
 * Options a cashier picks at the till — Spice: Normal / Spicy being the one this
 * menu needs. Kept simple on purpose: a group with a flat list of options and no
 * price adjustment, because that is the whole requirement here and a fuller
 * editor is a tomorrow problem.
 */
/**
 * Parses an option list that may carry price adjustments.
 *
 *   "Medium, Large +70"        → Medium +0, Large +70
 *   "250ml, 500ml +50"         → 250ml +0, 500ml +50
 *   "Small -20, Regular"       → Small -20, Regular +0
 *
 * The adjustment was previously hardcoded to 0, so a group could describe a
 * choice but never price it — "Large fries" cost the same as medium. The whole
 * pricing chain already supported it (computeUnitPrice sums the adjustments,
 * and the server recomputes from variant_options.price_adjustment), so the only
 * thing missing was a way to type the number.
 */
export function parseVariantOptions(raw: string): Array<{ name: string; adj: number }> {
  return raw.split(',').map(part => {
    const t = part.trim();
    if (!t) return null;
    // Trailing +N / -N / N, with an optional currency word in between.
    const m = t.match(/^(.*?)\s*([+-]\s*\d+(?:\.\d+)?)\s*$/);
    if (!m) return { name: t, adj: 0 };
    const name = m[1].trim();
    const adj = parseFloat(m[2].replace(/\s+/g, ''));
    // "Coke 500" is a name, not a price — only treat it as an adjustment when
    // an explicit sign was given and something is left over for the name.
    return name ? { name, adj: Number.isFinite(adj) ? adj : 0 } : { name: t, adj: 0 };
  }).filter(Boolean) as Array<{ name: string; adj: number }>;
}

const currencyless = (n: number) =>
  n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function VariantBlock({ products }: { products: any[] }) {
  const [productId, setProductId] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState('Spice');
  const [options, setOptions] = useState('Normal, Spicy');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const loadGroups = async (pid: string) => {
    if (!pid) { setGroups([]); return; }
    try { setGroups(await posApi.manage.listVariantGroups(pid) ?? []); }
    catch (e: any) { setErr(e?.message ?? 'Could not load options.'); }
  };

  const add = async () => {
    if (!productId) { setErr('Choose a product first.'); return; }
    const opts = parseVariantOptions(options);
    if (!name.trim() || opts.length < 2) { setErr('Give the group a name and at least two options.'); return; }
    setBusy(true); setErr('');
    try {
      await posApi.manage.createVariantGroup({
        product_id: productId,
        name: name.trim(),
        required: true,
        options: opts.map((o, i) => ({ name: o.name, price_adjustment: o.adj, sort_order: i })),
      });
      setOk('Options added'); setTimeout(() => setOk(''), 3000);
      await loadGroups(productId);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add options.');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setErr('');
    try { await posApi.manage.deleteVariantGroup(id); await loadGroups(productId); }
    catch (e: any) { setErr(e?.message ?? 'Could not remove.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-6">
      <p className="text-white font-semibold mb-2">Choices — pick one</p>
      <p className="text-xs text-gray-400 mb-2">
        The cashier must choose exactly one from each group. Use for spice level, or a
        size where only one answer makes sense.
      </p>
      <Banner kind="err" text={err} />
      <Banner kind="ok" text={ok} />

      <select value={productId}
        onChange={e => { setProductId(e.target.value); loadGroups(e.target.value); }}
        className={`${input} mb-3`}>
        <option value="">— choose a product or combo —</option>
        {products.filter(p => p.status === 'active').map(p =>
          <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      {productId && (
        <>
          {groups.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800 mb-3">
              {groups.map(g => (
                <div key={g.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-200">{g.name}</p>
                    <p className="text-xs text-gray-300 truncate">
                      {(g.variant_options ?? g.options ?? []).map((o: any) => {
                        const a = Number(o.price_adjustment) || 0;
                        return a === 0 ? o.name : `${o.name} ${a > 0 ? '+' : '−'}${Math.abs(a)}`;
                      }).join(' · ') || '—'}
                    </p>
                  </div>
                  <button onClick={() => remove(g.id)} disabled={busy}
                    className="text-xs text-gray-300 hover:text-red-400 px-2">Remove</button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Group name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={input} />
              </div>
              <div>
                <label className={label}>Options, comma separated</label>
                <input value={options} onChange={e => setOptions(e.target.value)} className={input}
                  placeholder="Medium, Large +70" />
              </div>
            </div>

            {/* Live preview. Pricing a choice wrongly is expensive and silent —
                seeing the resulting figure before saving is the cheapest guard. */}
            {(() => {
              const parsed = parseVariantOptions(options);
              const base = Number(products.find(p => p.id === productId)?.base_price) || 0;
              if (parsed.length === 0) return null;
              return (
                <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-400 mb-1.5">The cashier will see</p>
                  {parsed.map((o, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-gray-200">
                        {o.name}
                        {o.adj !== 0 && (
                          <span className="text-gray-400 text-xs ml-1.5">
                            {o.adj > 0 ? '+' : '−'}{currencyless(Math.abs(o.adj))}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-gray-200">{currencyless(base + o.adj)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            <p className="text-xs text-gray-400">
              The cashier picks one when adding this item. Add a price difference with
              <span className="text-gray-200 font-mono"> +70</span> or
              <span className="text-gray-200 font-mono"> −20</span> after the name —
              for example <span className="text-gray-200 font-mono">Medium, Large +70</span>.
              Leave it off and the option costs the same as the base price.
            </p>
            <p className="text-xs text-gray-400">
              One group per choice. A meal with a fries size and a drink size needs
              <span className="text-gray-200"> two </span> groups, which together give every
              combination — the cashier picks one from each.
            </p>
            <button onClick={add} disabled={busy} className={btn}>
              {busy ? 'Saving…' : 'Add option group'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Menu import ──────────────────────────────────────────────────────────── */

/**
 * Bulk menu import from a spreadsheet export.
 *
 * Two things this does that the raw endpoint does not:
 *
 *   1. Creates missing categories first. POST /api/products/bulk resolves
 *      category_name against EXISTING categories and silently writes null when
 *      there is no match — import a hundred rows against an empty catalogue and
 *      you get a hundred uncategorised products and no error.
 *
 *   2. Shows a preview before writing anything. An import is the easiest way to
 *      make a mess at speed, and "what is about to happen" is worth one click.
 *
 * Products import with track_stock false — this client does not track stock, and
 * the endpoint defaults it to TRUE.
 */
/**
 * Pulls variant groups out of a product row.
 *
 * Columns, up to three groups:
 *   variant1, variant1_options, variant2, variant2_options, ...
 *
 * Option lists accept | or ; as the separator, falling back to commas:
 *
 *   Fries   | Medium | Large +70
 *   Drink   | 250ml; 500ml +50
 *
 * The pipe matters. An option list naturally contains commas, and a comma
 * inside a CSV cell has to be quoted — which is exactly the thing people get
 * wrong in Excel and then cannot debug from a shop floor. Commas still work if
 * the cell is quoted properly.
 */
function readVariantSpecs(row: CsvRow): Array<{ name: string; options: Array<{ name: string; adj: number }> }> {
  const out: Array<{ name: string; options: Array<{ name: string; adj: number }> }> = [];
  for (let i = 1; i <= 3; i++) {
    const groupName =
      (row[`variant${i}`] ?? row[`variant${i}_name`] ?? row[`option${i}`] ?? '').trim();
    const listRaw =
      (row[`variant${i}_options`] ?? row[`option${i}_values`] ?? row[`options${i}`] ?? '').trim();
    if (!groupName || !listRaw) continue;

    const sep = listRaw.includes('|') ? '|' : listRaw.includes(';') ? ';' : ',';
    const options = parseVariantOptions(listRaw.split(sep).join(','));
    if (options.length >= 2) out.push({ name: groupName, options });
  }
  return out;
}

/**
 * Pulls ADD-ON groups (tick any) out of a product row.
 *
 *   addon1, addon1_options
 *
 * Same syntax as variants, different meaning: every option here is optional and
 * additive, so "Large fries +60 | 500ml soda +50" lets a customer take both.
 */
function readAddonSpecs(row: CsvRow): Array<{ name: string; options: Array<{ name: string; adj: number }> }> {
  const out: Array<{ name: string; options: Array<{ name: string; adj: number }> }> = [];
  for (let i = 1; i <= 2; i++) {
    const groupName = (row[`addon${i}`] ?? row[`addon${i}_name`] ?? row[`extra${i}`] ?? '').trim();
    const listRaw   = (row[`addon${i}_options`] ?? row[`extra${i}_options`] ?? '').trim();
    if (!groupName || !listRaw) continue;
    const sep = listRaw.includes('|') ? '|' : listRaw.includes(';') ? ';' : ',';
    const options = parseVariantOptions(listRaw.split(sep).join(','));
    // One add-on is legitimate — "Add cheese +50" is a complete group.
    if (options.length >= 1) out.push({ name: groupName, options });
  }
  return out;
}

/**
 * Per-product kitchen override from a CSV row.
 *
 * Distinct from the `kitchen` column, which flags the whole CATEGORY. This one
 * says "this item specifically", and BLANK means inherit — which is why it
 * returns undefined rather than false for an empty cell. Writing false would
 * pin every imported product to "never cook", and flipping its category later
 * would then do nothing.
 */
function readItemKitchen(row: CsvRow): boolean | undefined {
  const raw = (row['item_kitchen'] ?? row['product_kitchen'] ?? row['kitchen_item'] ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['yes', 'y', 'true', '1', 'kitchen'].includes(raw)) return true;
  if (['no', 'n', 'false', '0', 'counter'].includes(raw)) return false;
  return undefined;
}

export function ImportTab({ currency, onDone }: { currency: string; onDone?: () => void }) {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  // Variant creation is one round trip per product, so it can take a while
  // on a big menu. Silence would look like a hang.
  const [variantProgress, setVariantProgress] = useState<{ done: number; total: number } | null>(null);

  // A starter file that shows the shape rather than describing it. Every row is
  // a comment in disguise: a quoted description containing a comma, a category
  // that is cooked and one that is not, and Hot/Cold Sides split apart to show
  // why — the kitchen flag lives on the CATEGORY, so a category holding both
  // fries and cole slaw cannot route either of them correctly.
  const downloadSample = () => {
    const csv = [
      'name,price,category,description,kitchen,variant1,variant1_options,addon1,addon1_options',
      // Spice is a CHOICE — exactly one answer. The upgrades are ADD-ONS: the
      // customer may take large chips, a bigger soda, both, or neither. Putting
      // both upgrades in one choice group would make them mutually exclusive.
      '3 Piece Meal,400,Combos,,yes,Spice,Normal | Spicy,Upgrades,Large fries +60 | 500ml soda +50',
      'Chicken Burger,390,Burgers,"Chicken breast, lettuce, tomato",yes,Spice,Normal | Spicy,Extras,Add cheese +50 | Add bacon +80',
      'Crispy Burger,690,Burgers,,yes,,,,',
      'Chicken Wrap,550,Wraps,,yes,,,,',
      'French Fries,200,Hot Sides,,yes,Size,Medium | Large +70,,',
      'Cole Slaw,200,Cold Sides,Prepared at the counter,no,,,,',
      'Kudo Sauce,100,Sauces,,no,,,,',
      'Shake Chocolate,350,Shakes & Mojitos,Made beside the till,no,,,,',
      'Soda 500ml,120,Soft Drinks,,no,,,,',
      'Water 500ml,100,Soft Drinks,,no,,,,',
    ].join('\r\n') + '\r\n';

    // BOM so Excel opens it as UTF-8 instead of mangling any accented names.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'swiftpos-menu-sample.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const [fileName, setFileName] = useState('');
  const [existing, setExisting] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number; errors: any[] } | null>(null);

  useEffect(() => {
    posApi.manage.listCategories().then(c => setExisting(Array.isArray(c) ? c : [])).catch(() => {});
  }, []);

  const readFile = async (file: File) => {
    setErr(''); setResult(null);
    try {
      const text = await file.text();
      const { headers: h, rows: r } = parseCsvRows(text);
      if (!h.includes('name') || !h.includes('price')) {
        setErr('The file needs at least a "name" and a "price" column.');
        setRows([]); setHeaders([]); return;
      }
      setHeaders(h); setRows(r); setFileName(file.name);
    } catch {
      setErr('Could not read that file. Save it as CSV and try again.');
    }
  };

  // Rows the server would reject anyway — surfaced here so they can be fixed in
  // the spreadsheet rather than discovered as a list of row numbers afterwards.
  const invalid = rows.filter(r => !r.name || !Number.isFinite(parseFloat(r.price)) || parseFloat(r.price) < 0);
  const valid = rows.filter(r => !invalid.includes(r));

  const csvCategories: string[] = Array.from(new Set(valid.map(r => (r.category ?? '').trim()).filter(Boolean)));
  const existingNames = new Set(existing.map(c => (c.name ?? '').trim().toLowerCase()));
  const newCategories = csvCategories.filter(n => !existingNames.has(n.toLowerCase()));

  const runImport = async () => {
    setBusy(true); setErr(''); setResult(null);
    try {
      // Does the file mark this category as cooked-to-order anywhere?
      const csvSaysKitchen = (name: string) => valid.some(r =>
        (r.category ?? '').trim().toLowerCase() === name.toLowerCase() && csvBool(r.kitchen));

      // 1. Categories first, so category_name resolves for every product row.
      for (const name of newCategories) {
        await posApi.manage.createCategory({ name, is_kitchen: csvSaysKitchen(name) });
      }

      // 1b. Categories that ALREADY exist still need the kitchen flag applied.
      // The workflow explicitly allows adding categories on the Menu tab before
      // importing; without this, a file saying kitchen=yes against a category
      // created by hand was silently ignored, and nothing routed to the fryer.
      // Only flipped ON — an import should never quietly stop a category being
      // cooked, since that is a decision someone made deliberately.
      for (const cat of existing) {
        const name = (cat.name ?? '').trim();
        if (!name || !csvCategories.some(n => n.toLowerCase() === name.toLowerCase())) continue;
        if (csvSaysKitchen(name) && !cat.is_kitchen) {
          await posApi.manage.updateCategory(cat.id, { is_kitchen: true });
        }
      }

      // 2. Products, in chunks — the endpoint caps at 500 rows per call.
      const payload = valid.map(r => ({
        name:          r.name,
        base_price:    r.price,
        category_name: r.category || undefined,
        description:   r.description || undefined,
        track_stock:   false,
      }));

      const totals = { created: 0, updated: 0, errors: [] as any[] };
      for (let i = 0; i < payload.length; i += 400) {
        const res = await posApi.manage.bulkProducts(payload.slice(i, i + 400));
        totals.created += res?.created ?? 0;
        totals.updated += res?.updated ?? 0;
        if (Array.isArray(res?.errors)) totals.errors.push(...res.errors);
      }
      // 3. Variant groups. Must run AFTER the products exist, because a group
      // hangs off a product id and the bulk endpoint does not return ids —
      // so the products are re-listed and matched by name, the same key the
      // bulk upsert uses.
      const wantVariants = valid
        .map(r => ({
          product: r.name.trim(),
          specs:   readVariantSpecs(r),
          addons:  readAddonSpecs(r),
          itemKitchen: readItemKitchen(r),
        }))
        .filter(v => v.specs.length > 0 || v.addons.length > 0 || v.itemKitchen !== undefined);

      if (wantVariants.length > 0) {
        setVariantProgress({ done: 0, total: wantVariants.length });
        const all = await posApi.manage.listProducts();
        const byName = new Map<string, string>();
        for (const p of (Array.isArray(all) ? all : [])) {
          const k = String(p.name ?? '').trim().toLowerCase();
          if (k && !byName.has(k)) byName.set(k, p.id);
        }

        let n = 0;
        for (const { product, specs, addons, itemKitchen } of wantVariants) {
          n++; setVariantProgress({ done: n, total: wantVariants.length });
          const pid = byName.get(product.toLowerCase());
          if (!pid) { totals.errors.push({ row: 0, error: `${product}: product not found, options skipped` }); continue; }

          if (itemKitchen !== undefined) {
            try {
              await posApi.manage.updateProduct(pid, { is_kitchen: itemKitchen });
            } catch (e: any) {
              totals.errors.push({ row: 0, error: `${product}: could not set kitchen routing — ${e?.message ?? 'failed'}` });
            }
          }

          // Replace a group of the same name rather than adding a second one,
          // so re-importing a corrected price updates it instead of leaving the
          // cashier with two "Fries" groups to choose between.
          let current: any[] = [];
          try { current = await posApi.manage.listVariantGroups(pid) ?? []; } catch { /* treat as none */ }

          for (const spec of specs) {
            try {
              const clash = current.find((g: any) =>
                String(g.name ?? '').trim().toLowerCase() === spec.name.toLowerCase());
              if (clash) await posApi.manage.deleteVariantGroup(clash.id);
              await posApi.manage.createVariantGroup({
                product_id: pid,
                name: spec.name,
                required: true,
                options: spec.options.map((o, i) => ({ name: o.name, price_adjustment: o.adj, sort_order: i })),
              });
            } catch (e: any) {
              totals.errors.push({ row: 0, error: `${product} / ${spec.name}: ${e?.message ?? 'could not save options'}` });
            }
          }

          // Add-ons, same replace-by-name rule.
          let currentAddons: any[] = [];
          if (addons.length > 0) {
            try { currentAddons = await posApi.manage.listModifierGroups(pid) ?? []; } catch { /* treat as none */ }
          }
          for (const spec of addons) {
            try {
              const clash = currentAddons.find((g: any) =>
                String(g.name ?? '').trim().toLowerCase() === spec.name.toLowerCase());
              if (clash) await posApi.manage.deleteModifierGroup(clash.id);
              await posApi.manage.createModifierGroup({
                product_id: pid,
                name: spec.name,
                min_select: 0,
                max_select: null,
                options: spec.options.map(o => ({ name: o.name, price: o.adj })),
              });
            } catch (e: any) {
              totals.errors.push({ row: 0, error: `${product} / ${spec.name}: ${e?.message ?? 'could not save add-ons'}` });
            }
          }
        }
        setVariantProgress(null);
      }

      setResult(totals);
      setRows([]); setHeaders([]); setFileName('');
      const cats = await posApi.manage.listCategories();
      setExisting(Array.isArray(cats) ? cats : []);
      onDone?.();
    } catch (e: any) {
      setErr(e?.message ?? 'Import failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="p-4 max-w-3xl">
      <Banner kind="err" text={err} />

      {result && (
        <div className="rounded-lg px-3 py-2 text-sm mb-4 bg-green-500/10 border border-green-500/30 text-green-300">
          Imported — {result.created} added, {result.updated} updated
          {result.errors.length > 0 && `, ${result.errors.length} skipped`}
          {result.errors.length > 0 && (
            <ul className="mt-2 text-xs text-amber-300 list-disc pl-4">
              {result.errors.slice(0, 8).map((e, i) => <li key={i}>Row {e.row}: {e.error}</li>)}
              {result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4">
        <p className="text-white font-semibold mb-1">Import menu from a spreadsheet</p>
        <p className="text-xs text-gray-300 mb-3">
          In Excel or Google Sheets choose <span className="text-gray-300">Save As → CSV</span>, then pick the file here.
        </p>

        <input type="file" accept=".csv,text/csv"
          onChange={e => { const f = e.target.files?.[0]; if (f) readFile(f); }}
          className="block w-full text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-800 file:text-gray-200 hover:file:bg-gray-700" />

        <button onClick={downloadSample}
          className="mt-3 text-xs text-green-400 hover:text-green-300 transition-colors">
          ↓ Download a sample file to fill in
        </button>

        <div className="mt-4 text-xs text-gray-300">
          <p className="text-gray-400 mb-1">Columns</p>
          <p><span className="text-gray-300 font-mono">name</span>, <span className="text-gray-300 font-mono">price</span> — required.
            {' '}<span className="font-mono">category</span>, <span className="font-mono">description</span>, <span className="font-mono">kitchen</span> — optional.</p>
          <pre className="mt-2 bg-gray-950 rounded-lg p-3 overflow-x-auto text-gray-400">{`name,price,category,description,kitchen
Chicken Burger,390,Burgers,"Chicken breast, lettuce, tomato",yes
Coca-Cola 1.25L,230,Soft Drinks,,no`}</pre>
          <p className="mt-2">
            Put a description in quotes if it contains commas.{' '}
            <span className="text-gray-400">kitchen</span> marks the whole category as cooked-to-order —
            it is set per category, not per item, so every product sharing a category is routed the same way.
            Split anything mixed into two categories (for example Hot Sides and Cold Sides),
            or override the odd one out with <span className="font-mono text-gray-300">item_kitchen</span>{' '}
            (<span className="font-mono">yes</span> / <span className="font-mono">no</span>, blank = follow
            the category). Cole slaw sitting among hot sides is the case it exists for.
          </p>

          <p className="text-gray-300 mt-3 mb-1">Choices — pick one</p>
          <p>
            <span className="font-mono text-gray-300">variant1</span> /{' '}
            <span className="font-mono text-gray-300">variant1_options</span>, up to three groups.
            The cashier must pick exactly one. Separate options with{' '}
            <span className="font-mono text-gray-300">|</span> and put any price difference after
            the name.
          </p>
          <pre className="mt-2 bg-gray-950 rounded-lg p-3 overflow-x-auto text-gray-400">{`variant1,variant1_options
Spice,Normal | Spicy`}</pre>

          <p className="text-gray-300 mt-3 mb-1">Add-ons — tick any</p>
          <p>
            <span className="font-mono text-gray-300">addon1</span> /{' '}
            <span className="font-mono text-gray-300">addon1_options</span>, up to two groups.
            Same syntax, different behaviour: the cashier may tick{' '}
            <span className="text-gray-200">any number</span> and each adds its own price.
          </p>
          <pre className="mt-2 bg-gray-950 rounded-lg p-3 overflow-x-auto text-gray-400">{`addon1,addon1_options
Upgrades,Large fries +60 | 500ml soda +50`}</pre>

          <p className="mt-2">
            Use a <span className="text-gray-200">choice</span> where exactly one answer makes sense,
            and an <span className="text-gray-200">add-on</span> where upgrades are independent.
            Large chips and a bigger soda in one choice group become mutually exclusive — the
            customer could have one but never both. Use{' '}
            <span className="font-mono text-gray-300">|</span> rather than commas, or the cell has to
            be quoted. Re-importing replaces a group of the same name rather than adding a second.
          </p>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-white font-semibold mb-2">
            {fileName} — {valid.length} product{valid.length === 1 ? '' : 's'} ready
          </p>

          {invalid.length > 0 && (
            <p className="text-xs text-amber-400 mb-2">
              {invalid.length} row{invalid.length === 1 ? '' : 's'} will be skipped — missing name or invalid price.
            </p>
          )}

          {newCategories.length > 0 && (
            <p className="text-xs text-gray-400 mb-2">
              New categories to create: <span className="text-gray-200">{newCategories.join(', ')}</span>
            </p>
          )}

          <div className="max-h-64 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800 mb-3">
            {valid.slice(0, 50).map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span className="flex-1 text-gray-200 truncate">{r.name}</span>
                <span className="text-gray-300 text-xs truncate w-32">{r.category || '—'}</span>
                <span className="font-mono text-gray-300">{currency} {parseFloat(r.price).toLocaleString()}</span>
              </div>
            ))}
            {valid.length > 50 && (
              <p className="px-3 py-2 text-xs text-gray-400">…and {valid.length - 50} more</p>
            )}
          </div>

          <div className="flex gap-2">
            {variantProgress && (
              <p className="text-xs text-gray-300 mb-2">
                Saving options… {variantProgress.done} of {variantProgress.total} products
              </p>
            )}
            <button onClick={runImport} disabled={busy || valid.length === 0} className={btn}>
              {busy ? 'Importing…' : `Import ${valid.length} product${valid.length === 1 ? '' : 's'}`}
            </button>
            <button onClick={() => { setRows([]); setHeaders([]); setFileName(''); }}
              className="text-gray-400 hover:text-white px-3">Cancel</button>
          </div>

          <p className="text-xs text-gray-400 mt-2">
            Existing products with the same barcode are updated; everything else is added.
            Nothing is deleted. Stock tracking is left off.
          </p>
        </div>
      )}
    </div>
  );
}
