import { useEffect, useMemo, useState } from 'react';
import type { DiningTable } from '../lib/posApi';
import type { HeldOrder } from '../lib/heldOrders';

// Restaurant table map — desktop port of the dashboard's slot picker.
//
// Two views, same as the web:
//   Floor plan — absolute-positioned tables on a canvas, shown when any table
//                has pos_x/pos_y from Restaurant Setup's layout editor
//   Grid      — uniform cards, the fallback (and toggleable)
//
// Occupancy on the till maps to HELD ORDERS: a table is occupied when a tab
// is parked against it. Tapping a free table opens a new order on it; tapping
// an occupied one recalls its tab. Tables are synced reference data (SQLite),
// so the whole map works offline.

const FLOOR_W = 800;
const FLOOR_H = 520;
const TABLE_W = 72;
const TABLE_H = 52;

// Zone accents — keep in step with the dashboard's palette.
const ZONE_COLORS: Record<string, string> = {
  indoor:  '#38bdf8',
  outdoor: '#34d399',
  terrace: '#a78bfa',
  bar:     '#f472b6',
  vip:     '#fbbf24',
};
const DEFAULT_ZONE = '#64748b';
const zoneColor = (zone: string | null) => ZONE_COLORS[(zone ?? '').toLowerCase()] ?? DEFAULT_ZONE;

// Live dwell since a tab was opened. Counts in seconds for the first minute
// (so a freshly seated table visibly ticks), then minutes, then hours.
// Re-rendered every second by the tick in the component below.
function dwell(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

interface Props {
  tables: DiningTable[];
  heldOrders: HeldOrder[];
  currency: string;
  onTableTap: (table: DiningTable, heldOrder: HeldOrder | null) => void;
  onTakeaway: () => void;
  // Minutes a table may sit before it flips to the "over" (turnover-alert) state.
  // Mirrors the web's turnover_alert_minutes; defaults to 45 until that setting
  // is synced to the till.
  turnoverAlertMinutes?: number;
}

export default function TablesView({ tables, heldOrders, currency, onTableTap, onTakeaway, turnoverAlertMinutes }: Props) {
  const overMins = turnoverAlertMinutes ?? 45;

  // A tab is matched to a table by name — the same string that goes on the
  // KOT and receipt. Dine-in tabs only; takeaways never occupy a table.
  const tabByTable = useMemo(() => {
    const map: Record<string, HeldOrder> = {};
    for (const o of heldOrders) {
      if (o.orderType === 'dine_in' && o.tableNumber) map[o.tableNumber] = o;
    }
    return map;
  }, [heldOrders]);

  const hasLayout = tables.some(t => t.pos_x != null && t.pos_y != null);
  const [view, setView] = useState<'floor' | 'grid'>(hasLayout ? 'floor' : 'grid');

  // Tick once a second so the dwell timers on occupied tables count up live.
  // TablesView is only mounted while the map is on screen, so this interval
  // stops the moment the cashier switches to the product grid.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => (n + 1) % 60), 1000);
    return () => clearInterval(id);
  }, []);

  // Minutes a tab has been open, and whether it has crossed the turnover alert.
  const dwellMins = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;
  const isOver = (tab: HeldOrder | null) => !!tab && dwellMins(tab.heldAt) >= overMins;

  const occupiedCount = tables.filter(t => tabByTable[t.name]).length;
  const overCount = tables.filter(t => isOver(tabByTable[t.name] ?? null)).length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-white font-semibold">Tables</h2>
          <span className="text-xs text-gray-500">
            {tables.length - occupiedCount} free · <span className="text-amber-400">{occupiedCount} occupied</span>
            {overCount > 0 && <> · <span className="text-red-400">{overCount} over</span></>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasLayout && (
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {([['floor', 'Floor'], ['grid', 'Grid']] as const).map(([v, label]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1 text-xs ${view === v ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={onTakeaway}
            className="bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
          >
            🥡 Takeaway
          </button>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-8">
          <p className="text-gray-600 text-sm">
            No tables synced yet. Configure them in the dashboard under
            Setup → Restaurant Setup, then hit Sync in the top bar.
          </p>
        </div>
      ) : view === 'floor' ? (
        /* ── Floor plan ───────────────────────────────────── */
        <div className="flex-1 overflow-auto p-4">
          <div
            className="relative rounded-xl flex-shrink-0"
            style={{ width: FLOOR_W, height: FLOOR_H, background: '#0a0f1a' }}
          >
            {tables.map(table => {
              const tab = tabByTable[table.name] ?? null;
              const occ = !!tab;
              const over = isOver(tab);
              const c = zoneColor(table.zone);
              const accent = over ? '#ef4444' : occ ? '#f59e0b' : c;
              const isCircle = table.shape === 'circle';
              const items = tab ? tab.cart.reduce((s, i) => s + i.quantity, 0) : 0;
              return (
                <button
                  key={table.id}
                  onClick={() => onTableTap(table, tab)}
                  className={`absolute flex flex-col items-center justify-center select-none transition-transform hover:scale-105 active:scale-95 ${over ? 'animate-pulse' : ''}`}
                  style={{
                    left: table.pos_x ?? 40,
                    top: table.pos_y ?? 40,
                    width: TABLE_W,
                    height: isCircle ? TABLE_W : TABLE_H,
                    borderRadius: isCircle ? '50%' : 10,
                    background: occ ? (over ? 'rgba(239,68,68,0.18)' : 'rgba(245,158,11,0.15)') : `${c}1a`,
                    border: `2px solid ${accent}`,
                    boxShadow: occ ? `0 0 0 3px ${over ? 'rgba(239,68,68,0.28)' : 'rgba(245,158,11,0.2)'}` : 'none',
                  }}
                >
                  <span className="text-[11px] font-bold pointer-events-none" style={{ color: accent }}>
                    {table.name}
                  </span>
                  <span className="text-[9px] pointer-events-none mt-0.5" style={{ color: accent, opacity: occ ? 1 : 0.7 }}>
                    {occ ? `${over ? '⏰' : ''}${items} · ${dwell(tab!.heldAt)}` : `👥${table.capacity}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        /* ── Grid ─────────────────────────────────────────── */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {tables.map(table => {
              const tab = tabByTable[table.name] ?? null;
              const occ = !!tab;
              const over = isOver(tab);
              const items = tab ? tab.cart.reduce((s, i) => s + i.quantity, 0) : 0;
              const total = tab ? tab.cart.reduce((s, i) => s + i.lineTotal, 0) : 0;
              return (
                <button
                  key={table.id}
                  onClick={() => onTableTap(table, tab)}
                  className={`rounded-xl p-3 text-center border transition-all hover:scale-[1.02] active:scale-[0.98] ${
                    occ
                      ? (over ? 'bg-red-500/10 border-red-500/60 animate-pulse' : 'bg-amber-500/10 border-amber-500/60')
                      : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <p className={`text-sm font-bold ${over ? 'text-red-400' : occ ? 'text-amber-400' : 'text-white'}`}>{table.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">👥 {table.capacity}</p>
                  {occ ? (
                    <p className={`${over ? 'text-red-400' : 'text-amber-400'} text-[10px] mt-1.5 font-medium`}>
                      {items} item{items === 1 ? '' : 's'} · {currency} {total.toLocaleString()}
                      <br />
                      <span className="opacity-70">{over ? '⏰ ' : ''}{dwell(tab!.heldAt)} · tap to view</span>
                    </p>
                  ) : (
                    <p className="text-gray-600 text-[10px] mt-1.5">tap to open</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
