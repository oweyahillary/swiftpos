/**
 * MenusPage — A537: Menu › Menus. A business's menus (Food, Soft drinks, Alcohol, Tea …) above its categories.
 *
 * Owner, 2026-10-20: "some restaurants have different menus — food menu, non-alcoholic drinks menu, alcoholic drinks
 * menu, tea menu etc, can we include such?" Plain menus (no hours or days for now); one menu per category — a category
 * is put under a menu on the Categories page. The tills and the web POS show the menus as tabs at the top of the
 * category panel; a business with no menus sees no change.
 *
 * Add, rename, reorder (up / down), switch off (its categories then show under Other on the POS) and delete (its
 * categories are left with no menu). Each menu shows how many categories it holds.
 *
 * A573 (owner, 2026-10-22, on a retail business's dashboard: "strangley enough in retail businness their is a menu item"):
 * the page speaks the business's words — Menus at a restaurant or café, Departments at a shop, minimart or petrol station
 * (Groceries, Beverages …), Groups anywhere else (lib/businessTerms.ts). Same table, same API.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useTerm } from '../../lib/terminology';
import type { Menu } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import MenuHoursEditor from './MenuHoursEditor';   // A578: a menu's hours
import { availabilityLabel, readAvailability, type MenuAvailability } from '../../lib/menuHours';   // A578
import { isFoodService } from '../../lib/businessTerms';   // A578: the hours' examples follow the type

export default function MenusPage() {
  const { business } = useBusiness();
  const { lower, terms } = useTerm();
  const one = terms.menu.toLowerCase();      // A573: menu / department / group
  const many = terms.menus.toLowerCase();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [hoursFor, setHoursFor] = useState<string | null>(null);   // A578: the menu whose hours are open
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!business) return;
    try {
      const data = await api.get<Menu[]>('/api/menus');
      setMenus((data ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    } catch (e: any) {
      setError(e?.message ?? `Could not load the ${many}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [business]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e: any) { setError(e?.message ?? 'Not saved'); } finally { setBusy(false); }
  };

  const add = () => {
    if (!name.trim()) { setError(`A ${one} needs a name`); return; }
    void run(async () => {
      await api.post('/api/menus', { name: name.trim(), ...(icon.trim() ? { icon: icon.trim() } : {}) });
      setName(''); setIcon('');
    });
  };
  const rename = (m: Menu) => {
    if (!editName.trim()) { setError(`A ${one} needs a name`); return; }
    void run(async () => { await api.patch(`/api/menus/${m.id}`, { name: editName.trim() }); setEditing(null); });
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= menus.length) return;
    const next = menus.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setMenus(next);
    void run(() => api.post('/api/menus/reorder', { ids: next.map((m) => m.id) }));
  };
  // A578 (owner, 2026-10-23: menus by time of day): a menu's hours — null = always (the default).
  const saveHours = (m: Menu, availability: MenuAvailability | null) =>
    void run(async () => { await api.patch(`/api/menus/${m.id}`, { availability }); setHoursFor(null); });
  const toggle = (m: Menu) => void run(() => api.patch(`/api/menus/${m.id}`, { active: !m.active }));
  const remove = (m: Menu) => showConfirm({
    title: `Delete the ${m.name} ${one}?`,
    message: `Its ${m.category_count ?? 0} ${lower('categories')} stay, with no ${one} (they show under Other on the POS).`,
    intent: 'destructive',
    confirmLabel: 'Delete',
    onConfirm: () => run(() => api.delete(`/api/menus/${m.id}`)),
  });

  return (
    <div className="p-4 sm:p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{terms.menus}</h1>
        <p className="text-gray-400 text-sm mt-0.5" data-testid="menus-intro">
          Group your {lower('categories')} into {many} — {terms.menuExamples.join(', ')}. Put a {lower('category')} under
          a {one} on the {lower('categories')} page. The POS shows the {many} as tabs across the top of its items.
          {' '}Give a {one} <b className="text-gray-300 font-semibold">Hours</b> (days and times) and the POS shows it only then.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={`New ${one}, e.g. ${terms.menuExamples[1] ?? terms.menuExamples[0]}`}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          className="flex-1 min-w-[12rem] bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-swift transition-colors" />
        <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} placeholder={`Icon (optional) ${terms.menuIcon}`} aria-label="Icon"
          className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-swift transition-colors" />
        <button onClick={add} disabled={busy || !name.trim()}
          className="bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 font-semibold px-4 py-2.5 rounded-lg text-sm transition-colors">
          + Add {one}
        </button>
      </div>
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-swift border-t-transparent rounded-full animate-spin" />
        </div>
      ) : menus.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg">No {many} yet</p>
          <p className="text-sm mt-1">Without {many} the POS shows every {lower('category')} in one list, as before.</p>
        </div>
      ) : (
        <div data-testid="menus-list" className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
          {menus.map((m, i) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex flex-col">
                <button onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={`Move ${m.name} up`}
                  className="text-gray-400 hover:text-white disabled:opacity-30 px-2 leading-none">▲</button>
                <button onClick={() => move(i, 1)} disabled={busy || i === menus.length - 1} aria-label={`Move ${m.name} down`}
                  className="text-gray-400 hover:text-white disabled:opacity-30 px-2 leading-none">▼</button>
              </div>
              <div className="flex-1 min-w-[10rem]">
                {editing === m.id ? (
                  <div className="flex gap-2">
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') rename(m); if (e.key === 'Escape') setEditing(null); }}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-swift" />
                    <button onClick={() => rename(m)} disabled={busy} className="text-xs bg-swift text-gray-950 font-semibold px-3 rounded-lg">Save</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-gray-400 hover:text-white px-2">Cancel</button>
                  </div>
                ) : (
                  <>
                    <p className={`font-medium truncate ${m.active ? 'text-white' : 'text-gray-500'}`}>
                      {m.icon && <span className="mr-1.5">{m.icon}</span>}{m.name}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {m.category_count ?? 0} {(m.category_count ?? 0) === 1 ? lower('category') : lower('categories')}
                      {!m.active && ' · off — not shown on the POS'}
                    </p>
                    {/* A578: the hours in words — "Always" when none are set */}
                    <p className="text-xs mt-0.5" data-testid="menu-hours-summary">
                      <span aria-hidden>🕐 </span>
                      <span className={readAvailability(m.availability) ? 'text-swift-text' : 'text-gray-500'}>
                        {readAvailability(m.availability) ? availabilityLabel(readAvailability(m.availability)) : 'Always available'}
                      </span>
                    </p>
                  </>
                )}
              </div>
              {editing !== m.id && (
                <div className="flex items-center gap-1">
                  <button onClick={() => { setEditing(m.id); setEditName(m.name); }} disabled={busy}
                    className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">Rename</button>
                  <button onClick={() => setHoursFor(hoursFor === m.id ? null : m.id)} disabled={busy} data-testid="menu-hours-button"
                    className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">Hours</button>
                  <button onClick={() => toggle(m)} disabled={busy}
                    className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">
                    {m.active ? 'Switch off' : 'Switch on'}
                  </button>
                  <button onClick={() => remove(m)} disabled={busy}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors">Delete</button>
                </div>
              )}
              {hoursFor === m.id && editing !== m.id && (
                <MenuHoursEditor name={m.name} one={one} food={isFoodService(business?.type)} initial={readAvailability(m.availability)}
                  busy={busy} onSave={(v) => saveHours(m, v)} onCancel={() => setHoursFor(null)} />
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
