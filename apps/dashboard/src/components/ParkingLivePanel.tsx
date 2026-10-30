/**
 * ParkingLivePanel.tsx — A608 (owner, 2026-10-29, "yes to all": the web manager portal is retired; what only it showed
 * moves to the dashboard): the parking bays now, at the branch in view — total, occupied, free, occupancy, overstays (over
 * 8 hours) and the vehicles in the bays, refreshed every 30 s while the page is shown. The same data the manager portal's
 * Parking Overview read (/api/parking-sessions open, /api/tables parking bays). Shown on the Overview of a parking
 * business only (OverviewPage, businessTerms type 'parking'); every other business type never renders it. With "All
 * branches" in view it asks for a branch (bays belong to one).
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { whenVisible } from '../lib/visiblePoll';

interface ParkingSession { id: string; started_at: string; vehicle_plate?: string | null; vehicle_type?: string | null; rate_per_hour?: number | null }

const OVERSTAY_MS = 8 * 3_600_000;
const elapsedText = (startedAt: string): string => {
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const overstay = (startedAt: string): boolean => Date.now() - new Date(startedAt).getTime() > OVERSTAY_MS;

/** Occupancy of the bays — pure (the test reads it). */
export function bayOccupancy(bays: number, occupied: number): { free: number; pct: number } {
  const free = Math.max(0, bays - occupied);
  return { free, pct: bays > 0 ? Math.round((occupied / bays) * 100) : 0 };
}

export default function ParkingLivePanel({ branchId, branchName, currency }: { branchId: string | null; branchName?: string | null; currency: string }) {
  const [sessions, setSessions] = useState<ParkingSession[]>([]);
  const [bays, setBays] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    const load = async () => {
      const [s, b] = await Promise.allSettled([
        api.get<ParkingSession[]>(`/api/parking-sessions?branch_id=${branchId}&status=open`),
        api.get<unknown[]>(`/api/tables?branch_id=${branchId}&slot_type=parking_bay`),
      ]);
      if (cancelled) return;
      if (s.status === 'fulfilled') setSessions(s.value ?? []);
      if (b.status === 'fulfilled') setBays((b.value ?? []).length);
      setError(s.status === 'rejected' && b.status === 'rejected' ? 'Could not load the parking bays.' : '');
      setLoaded(true);
    };
    void load();
    const t = setInterval(whenVisible(() => { void load(); }), 30_000);   // A591: not while the page is hidden
    return () => { cancelled = true; clearInterval(t); };
  }, [branchId]);

  if (!branchId) {
    return (
      <div className="mb-5 bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 text-sm text-gray-500" data-testid="parking-live-pick">
        Parking bays: pick a branch to see its bays now.
      </div>
    );
  }

  const occupied = sessions.length;
  const { free, pct } = bayOccupancy(bays, occupied);
  const overstays = sessions.filter((x) => overstay(x.started_at));
  const barColour = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e';

  return (
    <div className="mb-5 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="parking-live">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-b border-gray-800">
        <p className="text-sm font-semibold text-white">Parking bays now</p>
        <p className="text-xs text-gray-500">{branchName ?? ''} · refreshes every 30 s</p>
      </div>
      {error && <p className="px-5 py-3 text-sm text-red-400">{error}</p>}
      {!loaded ? <p className="px-5 py-6 text-sm text-gray-500">Loading…</p> : (
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Total bays', value: String(bays), color: '#94a3b8' },
              { label: 'Occupied', value: String(occupied), color: '#f59e0b' },
              { label: 'Free', value: String(free), color: '#22c55e' },
              { label: 'Occupancy', value: `${pct}%`, color: pct > 80 ? '#ef4444' : '#3b82f6' },
            ].map((k) => (
              <div key={k.label} className="bg-gray-800/50 border border-gray-700 rounded-xl p-3 text-center">
                <p className="text-xl font-bold" style={{ color: k.color }}>{k.value}</p>
                <p className="text-gray-500 text-xs mt-1">{k.label}</p>
              </div>
            ))}
          </div>
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1.5"><span>Occupancy</span><span>{occupied} / {bays} bays</span></div>
            <div className="h-2.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, pct)}%`, background: barColour }} />
            </div>
          </div>
          {overstays.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3" data-testid="parking-overstay">
              <p className="text-amber-400 font-semibold text-sm mb-1">Over 8 hours — {overstays.length} vehicle{overstays.length !== 1 ? 's' : ''}</p>
              {overstays.map((x) => <p key={x.id} className="text-amber-400/70 text-xs">{x.vehicle_plate ?? 'Unknown plate'} — {elapsedText(x.started_at)} in the bay</p>)}
            </div>
          )}
          {sessions.length === 0 ? <p className="text-sm text-gray-500 text-center py-4">No vehicles in the bays.</p> : (
            <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg">
              {[...sessions].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()).map((x) => {
                const over = overstay(x.started_at);
                const due = Math.ceil((Date.now() - new Date(x.started_at).getTime()) / 3_600_000) * (x.rate_per_hour ?? 0);
                return (
                  <div key={x.id} className={`flex items-center gap-3 px-4 py-2.5 ${over ? 'bg-amber-500/5' : ''}`}>
                    <span className="text-xs text-gray-400 w-16">{x.vehicle_type === 'truck' ? 'Truck' : x.vehicle_type === 'motorbike' ? 'Motorbike' : 'Car'}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-mono font-bold ${over ? 'text-amber-400' : 'text-white'}`}>{x.vehicle_plate ?? '—'}</p>
                      <p className="text-gray-500 text-xs">{elapsedText(x.started_at)} · {money(x.rate_per_hour ?? 0, currency)}/hr</p>
                    </div>
                    <p className={`text-sm font-bold tabular-nums ${over ? 'text-amber-400' : 'text-green-400'}`}>{money(due, currency)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
