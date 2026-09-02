/**
 * StationsPage — define the print stations a business has, and what routes to them.
 *
 * WHY THIS SCREEN EXISTS
 * The station list was hardcoded in the till's source (three entries: Kitchen,
 * Dispatch, Till). A client wanting a "Barista" station tomorrow meant a code
 * change, a rebuild, and a reinstall on every terminal — for something that is
 * plainly configuration.
 *
 * The model has been in the database since migration 44 and the API since
 * routes/stations.ts. Both were complete. Nothing read them, because there was
 * no screen. This is that screen.
 *
 * ── WHAT LIVES WHERE, AND WHY IT IS SPLIT ───────────────────────────────────
 * A station is a JOB ("the grill", "the bar"). It belongs to the business, so
 * it is defined here and syncs to every terminal.
 *
 * A PRINTER is a machine on a desk. The printer serving the grill at till 1 is
 * not the one serving it at till 3, so that binding lives on each terminal
 * (Manager → Printers on the till itself) and never syncs.
 *
 * Getting that split wrong is how a two-till branch ends up with one till
 * printing everything and the other printing nothing.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type Kind = 'kitchen' | 'dispatch' | 'receipt';

interface Station {
  id: string;
  name: string;
  kind: Kind;
  sort_order: number;
  active: boolean;
  category_ids: string[];
}

interface Category { id: string; name: string }

const KIND_HELP: Record<Kind, string> = {
  kitchen:  'Prints only what is cooked. No prices.',
  dispatch: 'Prints everything that goes in the bag, including drinks. No prices.',
  receipt:  'Prints the customer receipt and opens the cash drawer.',
};

export default function StationsPage() {
  const [stations, setStations]   = useState<Station[]>([]);
  const [categories, setCats]     = useState<Category[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [newName, setNewName]     = useState('');
  const [newKind, setNewKind]     = useState<Kind>('kitchen');
  const [saving, setSaving]       = useState(false);

  async function load() {
    setError('');
    try {
      const [s, c] = await Promise.all([
        api.get<Station[]>('/api/stations'),
        api.get<Category[]>('/api/categories'),
      ]);
      setStations(s);
      setCats(c);
    } catch (e: any) {
      setError(e.message ?? 'Could not load stations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addStation() {
    if (!newName.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/api/stations', { name: newName.trim(), kind: newKind });
      setNewName('');
      await load();
    } catch (e: any) {
      // 409 is a real conflict, not a fault: two stations with the same name are
      // indistinguishable on every ticket header and in every dropdown.
      setError(e.message ?? 'Could not create that station');
    } finally {
      setSaving(false);
    }
  }

  /**
   * A category routes to any number of stations. Toggling writes the WHOLE set
   * back, because PUT /:id/categories replaces rather than merges — a partial
   * write would leave routing that nobody chose.
   */
  async function toggleCategory(station: Station, categoryId: string) {
    const next = station.category_ids.includes(categoryId)
      ? station.category_ids.filter(id => id !== categoryId)
      : [...station.category_ids, categoryId];

    // Optimistic: routing changes are the kind of thing people click through
    // quickly, and a round trip per checkbox makes the screen feel broken.
    setStations(prev => prev.map(s =>
      s.id === station.id ? { ...s, category_ids: next } : s));

    try {
      await api.put(`/api/stations/${station.id}/categories`, { category_ids: next });
    } catch (e: any) {
      setError(e.message ?? 'Could not save routing');
      await load();                       // put the truth back on screen
    }
  }

  async function rename(station: Station, name: string) {
    if (!name.trim() || name === station.name) return;
    try {
      await api.patch(`/api/stations/${station.id}`, { name: name.trim() });
      await load();
    } catch (e: any) { setError(e.message ?? 'Could not rename'); }
  }

  async function remove(station: Station) {
    if (!confirm(
      `Delete "${station.name}"?\n\n`
      + `Its category routing goes with it. Any terminal with a printer bound to `
      + `this station stops printing that ticket.`
    )) return;
    try {
      await api.delete(`/api/stations/${station.id}`);
      await load();
    } catch (e: any) { setError(e.message ?? 'Could not delete'); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading stations…</p>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Print stations</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          A station is a job — the grill, the bar, the packing bench. Point menu
          categories at it here, then bind a printer to it on each till under
          Manager → Printers. The printer is per terminal; the station is shared.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 px-4 py-2.5 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Add */}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="space-y-1">
          <span className="block text-xs uppercase tracking-wide text-gray-500">New station</span>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void addStation(); }}
            placeholder="Barista"
            className="border border-gray-300 dark:border-gray-700 dark:bg-gray-900 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Type</span>
          <select
            value={newKind}
            onChange={e => setNewKind(e.target.value as Kind)}
            className="border border-gray-300 dark:border-gray-700 dark:bg-gray-900 rounded-lg px-3 py-2 text-sm"
          >
            <option value="kitchen">Kitchen</option>
            <option value="dispatch">Dispatch</option>
            <option value="receipt">Receipt</option>
          </select>
        </label>
        <button
          onClick={() => void addStation()}
          disabled={saving || !newName.trim()}
          className="rounded-lg bg-gray-900 dark:bg-white dark:text-gray-900 text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          Add
        </button>
        <p className="w-full text-xs text-gray-500">{KIND_HELP[newKind]}</p>
      </div>

      {/* List */}
      {stations.length === 0 ? (
        <p className="text-sm text-gray-500">
          No stations yet. Until one exists, tills fall back to the built-in
          Kitchen / Dispatch / Till stations and keep printing as they do today.
        </p>
      ) : (
        <div className="space-y-4">
          {stations.map(s => (
            <div key={s.id} className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <input
                  defaultValue={s.name}
                  onBlur={e => void rename(s, e.target.value)}
                  className="font-medium bg-transparent border-b border-transparent hover:border-gray-300
                             focus:border-gray-500 focus:outline-none text-gray-900 dark:text-white"
                />
                <span className="text-xs uppercase tracking-wide text-gray-500">{s.kind}</span>
                <button
                  onClick={() => void remove(s)}
                  className="ml-auto text-xs text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
              <p className="text-xs text-gray-500">{KIND_HELP[s.kind]}</p>

              {s.kind === 'receipt' ? (
                <p className="text-xs text-gray-500">
                  A receipt station prints the whole bill, so it is not routed by category.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {categories.map(c => {
                    const on = s.category_ids.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() => void toggleCategory(s, c.id)}
                        className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                          on
                            ? 'bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900'
                            : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-500'
                        }`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
