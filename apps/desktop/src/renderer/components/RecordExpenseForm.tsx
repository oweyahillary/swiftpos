/**
 * RecordExpenseForm — A447: a manager records an expense from Manager › Expenses (it was the cashier's Shift → Expenses
 * only). Owner, 2026-10-11: "add a feature or manager recording expenses under expense tab, 'record expense' not just as a
 * cashier but as a manager also".
 *
 * The same record as the cashier's (expense:create — type, description, amount, how it was paid), approved by the
 * signed-in manager themselves (no PIN, A388). Paid in cash while this till has a shift open, it comes out of that
 * drawer (the shift's expected cash goes down, as for the cashier's); with no shift open it is recorded as paid
 * outside any drawer. Syncs like any expense.
 *
 * A465: on the BRANCH SERVER only, "Which drawer" lists every drawer open at the branch — picking another till's sends it
 * there (branchClose.shiftMoney; that till records it on its own books). The default is today's behaviour. On a plain
 * till nothing changes.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { methodLabel } from '../../shared/paymentCatalogue';

const input = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500';

export default function RecordExpenseForm({ currency, onSaved, onCancel }: { currency: string; onSaved: (msg: string) => void; onCancel: () => void }) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [methods, setMethods] = useState<string[]>(['cash', 'mpesa', 'card']);
  const [catId, setCatId] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A465: the branch server's open drawers (another till's included); '' = as before.
  const [isServer, setIsServer] = useState(false);
  const [drawers, setDrawers] = useState<{ key: string; device_id: string; shift_id: string; label: string }[]>([]);
  const [drawer, setDrawer] = useState('');

  useEffect(() => {
    posApi.expense.categories().then(setCategories).catch(() => {});
    posApi.pos.paymentMethods().then((m) => setMethods([...new Set(['cash', 'mpesa', 'card', ...(m ?? []).map((x) => String(x.code).toLowerCase())])])).catch(() => {});
    posApi.shift.current().then((r) => setShiftOpen(!!r)).catch(() => setShiftOpen(false));
    // A465: only the branch server (node / office) offers another till's drawer.
    posApi.config.get().then(async (c) => {
      if (c?.device_role !== 'node' && c?.device_role !== 'office') return;
      setIsServer(true);
      const ov = await posApi.branchClose.overview();
      if ('error' in ov) return;
      setDrawers(ov.tills.filter((t) => !t.is_self).flatMap((t) => (t.state?.shifts ?? []).filter((sh) => sh.state === 'open').map((sh) => {
        const n = t.state?.terminal?.name?.trim() || (t.state?.terminal?.code ? `Till ${t.state.terminal.code}` : `Terminal ${t.device_id.slice(0, 8)}`);
        return { key: `${t.device_id}:${sh.id}`, device_id: t.device_id, shift_id: sh.id, label: `${n} — ${sh.cashier_name}` };
      })));
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (!desc.trim()) { setError('Description is required.'); return; }
    if (!(Number(amount) > 0)) { setError('Enter an amount greater than zero.'); return; }
    setBusy(true); setError('');
    try {
      const target = isServer ? drawers.find((d) => d.key === drawer) : undefined;
      if (target) {
        // A465: another till's drawer — that till records it (within ~15 s).
        const r = await posApi.branchClose.shiftMoney({ device_id: target.device_id, shift_id: target.shift_id, kind: 'expense', amount: Number(amount),
          description: desc.trim(), expense_category_id: catId || undefined, category_name: categories.find((c) => c.id === catId)?.name, payment_method: method });
        if (!r.ok) { setError(r.error ?? 'Could not save the expense.'); return; }
        onSaved(`Expense sent to ${target.label} — that till records it within about 15 seconds.`);
        return;
      }
      const saved = await posApi.expense.create({
        description: desc.trim(), amount: Number(amount),
        expense_category_id: catId || undefined, category_name: categories.find((c) => c.id === catId)?.name,
        payment_method: method,
      });
      onSaved(`Expense saved${saved?.approvedBy ? ` — approved by ${saved.approvedBy}` : ''}. It syncs on the next connection.`);
    } catch (e: any) { setError(e?.message ?? 'Could not save the expense.'); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="record-expense-form" className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3 max-w-xl">
      <h3 className="text-white font-semibold">Record expense</h3>
      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Type</span>
        <select className={input} value={catId} onChange={(e) => setCatId(e.target.value)}>
          <option value="">No type</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Description</span>
        <input className={input} value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Gas refill" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs text-gray-400">Amount ({currency})</span>
          <input className={input} type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-gray-400">Paid with</span>
          <select className={input} value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
          </select>
        </label>
      </div>
      {isServer && drawers.length > 0 && (
        <label className="block space-y-1" data-testid="record-expense-which-drawer">
          <span className="text-xs text-gray-400">Which drawer</span>
          <select className={input} value={drawer} onChange={(e) => setDrawer(e.target.value)}>
            <option value="">{shiftOpen ? 'This terminal\'s drawer' : 'Not from a drawer'}</option>
            {drawers.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
      )}
      <p data-testid="record-expense-drawer" className="text-xs text-gray-400">
        {method !== 'cash' ? 'Not cash — no drawer is affected.'
          : drawer ? 'Cash comes out of that drawer — its till records it and its expected cash goes down.'
          : shiftOpen ? 'Cash comes out of this till\'s drawer (its shift is open) — the shift\'s expected cash goes down.'
          : 'No shift is open on this till — recorded as cash paid outside any drawer.'}
      </p>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button data-testid="record-expense-save" onClick={save} disabled={busy}
          className="px-4 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save expense'}
        </button>
        <button onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-gray-600 text-gray-200 text-sm">Cancel</button>
      </div>
    </div>
  );
}
