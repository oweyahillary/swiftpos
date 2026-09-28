import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { checkTypeName } from '../lib/expenseTypes';

/**
 * ExpenseTypesPanel — A358 (2026-09-28): the manager's Expenses page lists the expense types and, for those who may,
 * adds one. Owner, on v0.6.18: "add it here under expense but leave it under shifts also" — the Shift → Expenses
 * picker (A341) keeps its own "+ Add type". Same rule and the same cloud route (expense:addCategory →
 * POST /api/expenses/categories). Online only: offline, the list is empty and the message says why.
 */
export default function ExpenseTypesPanel({ canAdd }: { canAdd: boolean }) {
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = () => posApi.expense.categories()
    .then(list => setTypes(Array.isArray(list) ? list : []))
    .catch(() => setTypes([]))
    .finally(() => setLoaded(true));
  useEffect(() => { void load(); }, []);

  const save = async () => {
    const check = checkTypeName(name, types);
    if (check.ok === false) { setError(check.error); return; }
    if (check.ok === 'exists') { setNote(`"${check.name}" is already an expense type.`); setAdding(false); setName(''); setError(''); return; }
    setBusy(true); setError(''); setNote('');
    try {
      const created = await posApi.expense.addCategory(check.name);
      await load();
      setNote(`Expense type "${created.name}" added`);
      setAdding(false); setName('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not add the expense type.');
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="expense-types" className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-white">Expense types</span>
        {canAdd && !adding && (
          <button type="button" onClick={() => { setAdding(true); setError(''); setNote(''); }}
            className="text-sm text-gray-200 hover:text-white border border-gray-600 hover:border-gray-400 rounded-lg px-3 py-1 transition-colors">
            + Add type
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {!loaded ? <span className="text-xs text-gray-400">Loading…</span>
          : types.length === 0 ? <span className="text-xs text-gray-400">No expense types yet (the list needs a connection).</span>
          : types.map(t => (
            <span key={t.id} className="text-xs px-2 py-0.5 rounded-md bg-gray-700 text-gray-200">{t.name}</span>
          ))}
      </div>
      {canAdd && adding && (
        <div className="flex gap-2">
          <input type="text" autoFocus maxLength={60} value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="New expense type (e.g. Gas refill)"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-action-500" />
          <button type="button" disabled={busy} onClick={() => void save()}
            className="text-sm font-medium bg-action-500 hover:bg-action-400 disabled:opacity-50 text-gray-950 rounded-lg px-3 transition-colors">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" disabled={busy} onClick={() => { setAdding(false); setName(''); }}
            className="text-sm text-gray-300 hover:text-white px-2 transition-colors">Cancel</button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {note && !error && <p className="text-xs text-gray-300">{note}</p>}
    </div>
  );
}
