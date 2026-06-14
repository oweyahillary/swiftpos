/**
 * ReservationsPage.tsx
 * Route: /dashboard/reservations
 *
 * Two panels side by side:
 *  Left  — Reservations for the selected date (calendar picker)
 *  Right — Live walk-in waitlist
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useBranch } from '../context/BranchContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Reservation {
  id: string; guest_name: string; guest_phone: string | null;
  party_size: number; reserved_date: string; reserved_time: string;
  notes: string | null; status: string;
  tables: { name: string; capacity: number } | null;
}

interface WaitlistEntry {
  id: string; guest_name: string; guest_phone: string | null;
  party_size: number; estimated_wait: number | null;
  added_at: string; status: string; notes: string | null;
}

interface TableOption { id: string; name: string; capacity: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

function fmtTime(t: string) {
  const [h, m] = t.split(':');
  const hour = Number(h);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function minutesAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  seated:    'text-green-400 bg-green-500/10 border-green-500/20',
  completed: 'text-gray-500 bg-gray-800 border-gray-700',
  cancelled: 'text-red-400 bg-red-500/10 border-red-500/20',
  no_show:   'text-amber-400 bg-amber-500/10 border-amber-500/20',
  waiting:   'text-amber-400 bg-amber-500/10 border-amber-500/20',
};

// ── Reservation form ──────────────────────────────────────────────────────────

interface ResForm {
  guest_name: string; guest_phone: string; party_size: string;
  reserved_date: string; reserved_time: string; table_id: string; notes: string;
}

const BLANK_RES: ResForm = {
  guest_name: '', guest_phone: '', party_size: '2',
  reserved_date: today(), reserved_time: '19:00', table_id: '', notes: '',
};

// ── Waitlist form ─────────────────────────────────────────────────────────────

interface WaitForm {
  guest_name: string; guest_phone: string; party_size: string;
  estimated_wait: string; notes: string;
}

const BLANK_WAIT: WaitForm = {
  guest_name: '', guest_phone: '', party_size: '2', estimated_wait: '15', notes: '',
};

// ── Main component ────────────────────────────────────────────────────────────

export default function ReservationsPage() {
  const { activeBranchId } = useBranch();

  const [date, setDate]           = useState(today());
  const [reservations, setRes]    = useState<Reservation[]>([]);
  const [waitlist, setWait]       = useState<WaitlistEntry[]>([]);
  const [tables, setTables]       = useState<TableOption[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showRes,  setShowRes]    = useState(false);
  const [showWait, setShowWait]   = useState(false);
  const [resForm,  setResForm]    = useState<ResForm>(BLANK_RES);
  const [waitForm, setWaitForm]   = useState<WaitForm>(BLANK_WAIT);
  const [savingRes,  setSavingRes]  = useState(false);
  const [savingWait, setSavingWait] = useState(false);
  const [error, setError]         = useState('');

  const loadAll = useCallback(async (d = date) => {
    if (!activeBranchId) return;
    setLoading(true);
    try {
      const p = new URLSearchParams({ branch_id: activeBranchId, date: d });
      const wp = new URLSearchParams({ branch_id: activeBranchId });
      const [res, wait, tabs] = await Promise.all([
        api.get<Reservation[]>(`/api/reservations?${p}`),
        api.get<WaitlistEntry[]>(`/api/reservations/waitlist?${wp}`),
        api.get<TableOption[]>(`/api/tables?branch_id=${activeBranchId}`),
      ]);
      setRes(res ?? []);
      setWait(wait ?? []);
      setTables(tabs ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [activeBranchId, date]); // eslint-disable-line

  useEffect(() => { loadAll(); }, [activeBranchId, date]); // eslint-disable-line

  // Auto-refresh waitlist every 30s
  useEffect(() => {
    if (!activeBranchId) return;
    const t = setInterval(async () => {
      const wp = new URLSearchParams({ branch_id: activeBranchId });
      const wait = await api.get<WaitlistEntry[]>(`/api/reservations/waitlist?${wp}`).catch(() => []);
      setWait(wait ?? []);
    }, 30_000);
    return () => clearInterval(t);
  }, [activeBranchId]);

  async function saveRes() {
    if (!resForm.guest_name.trim()) { setError('Guest name is required'); return; }
    if (!activeBranchId) { setError('No branch selected'); return; }
    setSavingRes(true); setError('');
    try {
      await api.post('/api/reservations', {
        branch_id: activeBranchId,
        guest_name: resForm.guest_name.trim(),
        guest_phone: resForm.guest_phone || null,
        party_size: Number(resForm.party_size),
        reserved_date: resForm.reserved_date,
        reserved_time: resForm.reserved_time,
        table_id: resForm.table_id || null,
        notes: resForm.notes || null,
      });
      setShowRes(false); setResForm(BLANK_RES); loadAll();
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setSavingRes(false); }
  }

  async function saveWait() {
    if (!waitForm.guest_name.trim()) { setError('Guest name is required'); return; }
    if (!activeBranchId) { setError('No branch selected'); return; }
    setSavingWait(true); setError('');
    try {
      await api.post('/api/reservations/waitlist', {
        branch_id: activeBranchId,
        guest_name: waitForm.guest_name.trim(),
        guest_phone: waitForm.guest_phone || null,
        party_size: Number(waitForm.party_size),
        estimated_wait: Number(waitForm.estimated_wait) || null,
        notes: waitForm.notes || null,
      });
      setShowWait(false); setWaitForm(BLANK_WAIT); loadAll();
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setSavingWait(false); }
  }

  async function updateResStatus(id: string, status: string) {
    try {
      await api.patch(`/api/reservations/${id}`, { status });
      setRes(prev => prev.map(r => r.id === id ? { ...r, status } : r));
    } catch { /* silent */ }
  }

  async function updateWaitStatus(id: string, status: string) {
    try {
      await api.patch(`/api/reservations/waitlist/${id}`, { status });
      setWait(prev => prev.filter(w => w.id !== id));
    } catch { /* silent */ }
  }

  const InputCls = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500";

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex-shrink-0 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-white text-2xl font-bold">Reservations & Waitlist</h1>
          <p className="text-gray-500 text-sm mt-1">Manage table bookings and walk-in queue</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setShowWait(true); setError(''); }}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold rounded-lg transition-colors">
            + Waitlist
          </button>
          <button onClick={() => { setShowRes(true); setError(''); setResForm({ ...BLANK_RES, reserved_date: date }); }}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors">
            + Reservation
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex gap-0 divide-x divide-gray-800">
        {/* Reservations panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-3">
            <p className="text-sm font-semibold text-white">Reservations</p>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1 text-white text-sm focus:outline-none focus:border-blue-500" />
            <span className="text-xs text-gray-500">{reservations.length} booking{reservations.length !== 1 ? 's' : ''}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {loading && <div className="text-center py-10 text-gray-500 text-sm">Loading…</div>}
            {!loading && reservations.length === 0 && (
              <div className="text-center py-16 text-gray-600 text-sm">No reservations for this date.</div>
            )}
            {reservations.map(r => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-white font-semibold">{r.guest_name}</p>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_COLORS[r.status] ?? 'text-gray-400 border-gray-700'}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
                      <span>⏰ {fmtTime(r.reserved_time)}</span>
                      <span>👥 {r.party_size} guests</span>
                      {r.tables && <span>🪑 {r.tables.name}</span>}
                      {r.guest_phone && <span>📱 {r.guest_phone}</span>}
                    </div>
                    {r.notes && <p className="text-gray-600 text-xs mt-1 italic">{r.notes}</p>}
                  </div>
                  {r.status === 'confirmed' && (
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => updateResStatus(r.id, 'seated')}
                        className="text-xs px-2.5 py-1 bg-green-600/20 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-600/30 transition-colors">
                        Seat
                      </button>
                      <button onClick={() => updateResStatus(r.id, 'no_show')}
                        className="text-xs px-2.5 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-colors">
                        No-show
                      </button>
                    </div>
                  )}
                  {r.status === 'seated' && (
                    <button onClick={() => updateResStatus(r.id, 'completed')}
                      className="flex-shrink-0 text-xs px-2.5 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 transition-colors">
                      Complete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Waitlist panel */}
        <div className="w-80 flex-shrink-0 flex flex-col overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-3">
            <p className="text-sm font-semibold text-white">Waitlist</p>
            {waitlist.length > 0 && (
              <span className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-semibold">
                {waitlist.length} waiting
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {waitlist.length === 0 && (
              <div className="text-center py-12 text-gray-600 text-sm">No one waiting.</div>
            )}
            {waitlist.map((w, i) => (
              <div key={w.id} className="bg-gray-900 border border-amber-500/20 rounded-xl p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-amber-400 w-5">#{i + 1}</span>
                      <p className="text-white text-sm font-semibold">{w.guest_name}</p>
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5 ml-5">
                      👥 {w.party_size} · waited {minutesAgo(w.added_at)}
                      {w.estimated_wait ? ` · ~${w.estimated_wait}m` : ''}
                    </p>
                    {w.guest_phone && <p className="text-gray-600 text-xs ml-5">📱 {w.guest_phone}</p>}
                  </div>
                </div>
                <div className="flex gap-2 ml-5">
                  <button onClick={() => updateWaitStatus(w.id, 'seated')}
                    className="text-xs px-2.5 py-1 bg-green-600/20 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-600/30 transition-colors">
                    Seat
                  </button>
                  <button onClick={() => updateWaitStatus(w.id, 'left')}
                    className="text-xs px-2.5 py-1 text-gray-500 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors">
                    Left
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Reservation form modal */}
      {showRes && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
              <h3 className="text-white font-bold">New reservation</h3>
              <button onClick={() => setShowRes(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Guest name *</label>
                  <input value={resForm.guest_name} onChange={e => setResForm(f => ({ ...f, guest_name: e.target.value }))} className={InputCls} placeholder="Full name" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Phone</label>
                  <input value={resForm.guest_phone} onChange={e => setResForm(f => ({ ...f, guest_phone: e.target.value }))} className={InputCls} placeholder="+254..." />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Party size</label>
                  <input type="number" min={1} value={resForm.party_size} onChange={e => setResForm(f => ({ ...f, party_size: e.target.value }))} className={InputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Date</label>
                  <input type="date" value={resForm.reserved_date} onChange={e => setResForm(f => ({ ...f, reserved_date: e.target.value }))} className={InputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Time</label>
                  <input type="time" value={resForm.reserved_time} onChange={e => setResForm(f => ({ ...f, reserved_time: e.target.value }))} className={InputCls} />
                </div>
              </div>
              {tables.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Table (optional)</label>
                  <select value={resForm.table_id} onChange={e => setResForm(f => ({ ...f, table_id: e.target.value }))} className={InputCls}>
                    <option value="">— Assign later —</option>
                    {tables.map(t => <option key={t.id} value={t.id}>{t.name} (cap. {t.capacity})</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Notes</label>
                <input value={resForm.notes} onChange={e => setResForm(f => ({ ...f, notes: e.target.value }))} className={InputCls} placeholder="Allergies, anniversary, high chair…" />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex gap-2.5">
              <button onClick={() => setShowRes(false)} className="flex-1 py-2.5 border border-gray-700 rounded-lg text-gray-400 text-sm hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={saveRes} disabled={savingRes} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded-lg text-white text-sm font-bold transition-colors">
                {savingRes ? 'Saving…' : 'Book table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Waitlist form modal */}
      {showWait && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
              <h3 className="text-white font-bold">Add to waitlist</h3>
              <button onClick={() => setShowWait(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Guest name *</label>
                  <input value={waitForm.guest_name} onChange={e => setWaitForm(f => ({ ...f, guest_name: e.target.value }))} className={InputCls} placeholder="Full name" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Phone</label>
                  <input value={waitForm.guest_phone} onChange={e => setWaitForm(f => ({ ...f, guest_phone: e.target.value }))} className={InputCls} placeholder="+254..." />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Party size</label>
                  <input type="number" min={1} value={waitForm.party_size} onChange={e => setWaitForm(f => ({ ...f, party_size: e.target.value }))} className={InputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Est. wait (mins)</label>
                  <input type="number" min={0} value={waitForm.estimated_wait} onChange={e => setWaitForm(f => ({ ...f, estimated_wait: e.target.value }))} className={InputCls} placeholder="15" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Notes</label>
                <input value={waitForm.notes} onChange={e => setWaitForm(f => ({ ...f, notes: e.target.value }))} className={InputCls} placeholder="Dietary requirements, preferences…" />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex gap-2.5">
              <button onClick={() => setShowWait(false)} className="flex-1 py-2.5 border border-gray-700 rounded-lg text-gray-400 text-sm hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={saveWait} disabled={savingWait} className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded-lg text-white text-sm font-bold transition-colors">
                {savingWait ? 'Adding…' : 'Add to waitlist'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
