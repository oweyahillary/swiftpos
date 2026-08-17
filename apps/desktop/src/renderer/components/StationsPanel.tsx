/**
 * StationsPanel — define print stations and route categories to them.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * `categories.is_kitchen`: a single tick box meaning "one kitchen". That box is
 * why 3PC Chicken never reached the kitchen — nobody had ticked it, and nothing
 * anywhere said so. The order simply arrived at the counter with half of it never
 * cooked, and the first sign was a customer waiting.
 *
 * So the unassigned warning at the top of this screen is not decoration. It is
 * the entire reason the screen exists, and it is why it sits ABOVE the station
 * list rather than below it.
 *
 * ── TWO KINDS OF SETTING ON ONE SCREEN, DELIBERATELY ────────────────────────
 * A station is a business-level idea shared by every till ("Grill"), and its
 * categories are the same everywhere. But the PRINTER serving it is a property of
 * this terminal — till 1 and till 3 have different hardware attached.
 *
 * Mixing scopes on one screen is usually a mistake, but separating these would be
 * worse: the person plugging in a printer is the person deciding what prints on
 * it, and sending them to two screens is how one gets done and the other does
 * not. The scope is labelled per field instead.
 */

import { useCallback, useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { PrintStation, StationKind, PrinterInfo } from '../lib/posApi';
import type { PrinterSettings } from '../hooks/usePrinterSettings';

interface Category { id: string; name: string }

interface Props {
  printers: PrinterInfo[];
  settings: PrinterSettings;
  save: (patch: Partial<PrinterSettings>) => void;
  canEdit: boolean;
}

const KIND_HELP: Record<StationKind, string> = {
  kitchen:  'Prints what is cooked. Drinks and other non-prepared items are left off.',
  dispatch: 'Prints everything on the order, for packing the bag.',
  receipt:  'The customer copy — item names only, not itemised.',
};

const KIND_LABEL: Record<StationKind, string> = {
  kitchen: 'Kitchen', dispatch: 'Packing', receipt: 'Customer',
};

export default function StationsPanel({ printers, settings, save, canEdit }: Props) {
  const [stations, setStations] = useState<PrintStation[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [unassigned, setUnassigned] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<StationKind>('kitchen');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // Independent, not Promise.all: one failing call must not blank the screen
    // and leave it reporting "no stations", which reads as configured-and-empty
    // rather than could-not-ask.
    const [st, cats, un] = await Promise.all([
      posApi.manage.listStations().catch(e => { setError(e?.message ?? 'Could not load stations'); return null; }),
      posApi.manage.listCategories().catch(() => null),
      posApi.manage.unassignedCategories().catch(() => null),
    ]);
    if (st) setStations(st);
    if (cats) setCategories(cats);
    if (un) setUnassigned(un);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const seedDefaults = async () => {
    setBusy('seed');
    try {
      await posApi.manage.seedDefaultStations();
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not create the default stations');
    } finally { setBusy(''); }
  };

  const addStation = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy('new');
    try {
      await posApi.manage.createStation({ name, kind: newKind, sort_order: stations.length });
      setNewName('');
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not create the station');
    } finally { setBusy(''); }
  };

  const toggleCategory = async (station: PrintStation, categoryId: string) => {
    const next = station.category_ids.includes(categoryId)
      ? station.category_ids.filter(id => id !== categoryId)
      : [...station.category_ids, categoryId];
    // Optimistic: routing edits are a rapid series of tick-box clicks, and waiting
    // for a round trip per tick makes the screen feel broken.
    setStations(prev => prev.map(s => s.id === station.id ? { ...s, category_ids: next } : s));
    setBusy(station.id);
    try {
      await posApi.manage.setStationCategories(station.id, next);
      setUnassigned(await posApi.manage.unassignedCategories().catch(() => unassigned));
    } catch (e: any) {
      setError(e?.message ?? 'Could not save routing');
      await load();   // put the truth back on screen rather than leave the optimistic guess
    } finally { setBusy(''); }
  };

  const removeStation = async (station: PrintStation) => {
    setBusy(station.id);
    try {
      await posApi.manage.deleteStation(station.id);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not delete the station');
    } finally { setBusy(''); }
  };

  const field = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm';

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-white font-semibold">Stations</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Where each category prints. Shared by every till — the printer for each
          station is set per terminal below.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* The point of the screen. Above the list, because a category that prints
          nowhere is the failure this whole feature exists to make impossible. */}
      {!loading && unassigned.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <p className="text-sm text-amber-200 font-medium">
            {unassigned.length === 1
              ? '1 category prints nowhere'
              : `${unassigned.length} categories print nowhere`}
          </p>
          <p className="text-xs text-amber-300/80 mt-1">
            {unassigned.map(c => c.name).join(', ')}
          </p>
          <p className="text-xs text-amber-400/70 mt-1.5">
            Items in these categories will not appear on any kitchen or packing ticket.
          </p>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : stations.length === 0 ? (
        <div className="border border-gray-700 rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-gray-400">
            No stations yet. Set up the usual three in one step, or create your own below.
          </p>
          {canEdit && (
            <>
              <button
                onClick={seedDefaults}
                disabled={busy === 'seed'}
                className="bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
              >
                {busy === 'seed' ? 'Creating…' : 'Create default stations'}
              </button>
              <p className="text-xs text-gray-600">
                Creates Kitchen, Packing and Till, and routes every category — cooked ones to
                Kitchen, all of them to Packing — so nothing prints nowhere. Adjust anytime.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {stations.map(st => {
            const open = expanded === st.id;
            const boundPrinter = settings.stationPrinters?.[st.id] ?? '';
            return (
              <div key={st.id} className="border border-gray-700 rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2.5 bg-gray-800/40">
                  <button
                    onClick={() => setExpanded(open ? null : st.id)}
                    className="flex-1 text-left"
                  >
                    <span className="text-white text-sm font-medium">{st.name}</span>
                    <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                      {KIND_LABEL[st.kind]}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">
                      {st.category_ids.length === 0
                        ? 'no categories'
                        : `${st.category_ids.length} categor${st.category_ids.length === 1 ? 'y' : 'ies'}`}
                    </span>
                    {!boundPrinter && (
                      <span className="ml-2 text-xs text-amber-400">· no printer on this till</span>
                    )}
                  </button>
                  <span className="text-gray-500 text-xs">{open ? '▾' : '▸'}</span>
                </div>

                {open && (
                  <div className="px-3 py-3 space-y-3 border-t border-gray-700">
                    <p className="text-xs text-gray-400">{KIND_HELP[st.kind]}</p>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5">
                        Categories that print here
                        <span className="text-gray-600"> · shared by all tills</span>
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {categories.map(c => {
                          const on = st.category_ids.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              disabled={!canEdit || busy === st.id}
                              onClick={() => toggleCategory(st, c.id)}
                              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                on
                                  ? 'bg-green-500/15 border-green-500/40 text-green-300'
                                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                              } disabled:opacity-50`}
                            >
                              {on ? '✓ ' : ''}{c.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5">
                        Printer for this station
                        <span className="text-gray-600"> · this till only</span>
                      </label>
                      <select
                        value={boundPrinter}
                        disabled={!canEdit}
                        onChange={e => save({
                          stationPrinters: { ...(settings.stationPrinters ?? {}), [st.id]: e.target.value },
                        })}
                        className={field}
                      >
                        <option value="">Not set on this terminal</option>
                        {printers.map(p => (
                          <option key={p.name} value={p.name}>{p.displayName}</option>
                        ))}
                      </select>
                    </div>

                    {canEdit && (
                      <button
                        onClick={() => removeStation(st)}
                        disabled={busy === st.id}
                        className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                      >
                        Delete this station
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <div className="border border-gray-700 rounded-lg p-3 space-y-2">
          <label className="block text-xs text-gray-400">Add a station</label>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addStation(); }}
              placeholder="e.g. Grill"
              className={field}
            />
            <select
              value={newKind}
              onChange={e => setNewKind(e.target.value as StationKind)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              <option value="kitchen">Kitchen</option>
              <option value="dispatch">Packing</option>
              <option value="receipt">Customer</option>
            </select>
            <button
              onClick={addStation}
              disabled={busy === 'new' || !newName.trim()}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500
                         text-white rounded-lg px-4 text-sm font-medium transition-colors whitespace-nowrap"
            >
              {busy === 'new' ? 'Adding…' : 'Add'}
            </button>
          </div>
          <p className="text-[11px] text-gray-500">
            {KIND_HELP[newKind]}
          </p>
        </div>
      )}
    </div>
  );
}
