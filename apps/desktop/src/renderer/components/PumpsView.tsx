import { useCallback, useEffect, useMemo, useState } from 'react';
import { posApi, type Forecourt, type Pump } from '../lib/posApi';
import {
  QUICK_AMOUNTS, LOW_PCT, gradeColour, keyIn, fuelSale, litresText, moneyText, gradeGauge, pumpGrades, pumpState,
  PUMP_STATE_LABEL, type FuelField, type Gauge, type PumpState,
} from '@zaptill/core/forecourt';

// The petrol POS's forecourt (A588; owner, 2026-10-24: "FIX the petrol pos shop item, make it feel petrol-like, you can
// add gauges"). Loaded only when a petrol station opens its pumps (POSPage lazy-loads it, A517's budget).
//
//   - a gauge per fuel grade: the tanks' level when this POS knows it (the cloud's fuel tanks, online licence), else the
//     litres this POS sold today against yesterday — never a number it does not hold (main/forecourt.ts);
//   - each pump a dispenser: its grade's colour and name, the price per litre, idle / in use / selected, its last sale on
//     the display and the litres it sold today;
//   - a pump tapped opens the keypad: an amount (KES) or litres, the other worked out live (litres to 3 decimals), quick
//     amounts and "Full tank" (litres read off the pump). The line goes on the sale through the same fuel path as always
//     (POSPage.addFuelLine: quantity = litres at full precision, the amount as entered; order_type 'fuel_sale').
//
// Pumps are synced reference data (SQLite), so the screen and the sale work offline; only the tank levels need the cloud.

interface Props {
  pumps: Pump[];
  currency: string;
  onAddFuel: (pump: Pump, litres: number, amount: number) => void;
  /** The fuel products (category colour: the owner's fallback colour for a grade the POS does not recognise). */
  products?: any[];
  /** The pumps with a fuel line on the sale being rung (shown "In use"). */
  onSale?: ReadonlySet<string>;
  /** Changes after each completed sale: the counters are read again. */
  refreshKey?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
const REFRESH_MS = 60_000;

export default function PumpsView({ pumps, currency, onAddFuel, products = [], onSale = new Set(), refreshKey = '' }: Props) {
  const [data, setData] = useState<Forecourt | null>(null);
  const [active, setActive] = useState<Pump | null>(null);
  const [field, setField] = useState<FuelField>('amount');
  const [entry, setEntry] = useState('');
  const [fullTank, setFullTank] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => posApi.pos.forecourt().then((d) => { if (live) setData(d); }).catch(() => { /* counters stay as they were */ });
    read();
    const t = setInterval(read, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [refreshKey]);

  const colourOf = useMemo(() => {
    const byId = new Map(products.map((p: any) => [p.id, p]));
    const grades = pumpGrades(pumps);
    const m = new Map<string, string>();
    grades.forEach((g, i) => m.set(g.id, gradeColour(g.name, byId.get(g.id)?.category_color ?? null, i)));
    return (id: string | null | undefined) => (id ? m.get(id) : undefined) ?? '#6b7280';
  }, [pumps, products]);
  const grades = useMemo(() => pumpGrades(pumps), [pumps]);
  const pumpDay = useMemo(() => new Map((data?.pumps ?? []).map((p) => [p.pump_id, p])), [data]);

  const price = active?.price_per_litre ?? 0;
  const sale = fuelSale(field, entry, price);

  const openPump = (pump: Pump) => {
    if (pumpState(pump, null, onSale) === 'off' || !pump.price_per_litre || pump.price_per_litre <= 0) return;
    setActive(pump); setField('amount'); setEntry(''); setFullTank(false);
  };
  const close = () => setActive(null);
  const confirm = useCallback(() => {
    if (!active || !(sale.amount > 0) || !(sale.litres > 0)) return;
    onAddFuel(active, sale.litres, sale.amount);
    setActive(null);
  }, [active, sale.amount, sale.litres, onAddFuel]);
  const press = useCallback((k: string) => setEntry((e) => keyIn(e, k, field)), [field]);
  const switchField = (f: FuelField) => { if (f !== field) { setField(f); setEntry(''); } setFullTank(false); };

  // The keyboard works the keypad too (a USB numpad on the counter).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key) || e.key === '.') { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
      else if (e.key === 'Enter') { confirm(); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, press, confirm]);

  const tanksKnown = !!data?.tanks && data.tanks.length > 0;
  const asOf = data?.tanksAt ? new Date(data.tanksAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="forecourt">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* The gauges: one per grade */}
        {grades.length > 0 && (
          <section aria-label="Fuel levels" data-testid="fuel-gauges">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">{tanksKnown ? 'Tank levels' : 'Litres today'}</h2>
              <span className="text-[11px] text-gray-500" data-testid="gauge-source">
                {tanksKnown ? `As of ${asOf}` : 'Sold on this POS today, against yesterday'}
              </span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {grades.map((g) => (
                <GradeGauge key={g.id} name={g.name} colour={colourOf(g.id)} gauge={gradeGauge(g.id, data)} />
              ))}
            </div>
          </section>
        )}

        {/* The pumps */}
        <section aria-label="Pumps">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Pumps</h2>
          {pumps.length === 0 ? (
            <div className="text-center text-gray-300 text-sm mt-12 px-6">
              No pumps configured. Add pumps in the dashboard (Settings → Pumps), then press Sync on the POS.
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {pumps.map((pump) => (
                <Dispenser key={pump.id} pump={pump} currency={currency} colour={colourOf(pump.fuel_product_id)}
                  state={pumpState(pump, active?.id ?? null, onSale)} day={pumpDay.get(pump.id)} onTap={openPump} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* The keypad */}
      {active && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in" onClick={close}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md overflow-hidden animate-pop-in" data-testid="fuel-keypad"
            onClick={(e) => e.stopPropagation()}>
            <div className="h-1.5" style={{ background: colourOf(active.fuel_product_id) }} />
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-white truncate">{active.name}</h3>
                  <div className="text-xs text-gray-400">
                    <span className="font-semibold" style={{ color: colourOf(active.fuel_product_id) }}>{active.fuel_product_name ?? 'Fuel'}</span>
                    {' · '}{currency} {moneyText(price)}/L
                  </div>
                </div>
                <button onClick={close} aria-label="Close" className="min-w-[40px] min-h-[40px] text-gray-300 hover:text-white text-xl leading-none">×</button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-1 p-1 rounded-xl bg-gray-800" role="tablist">
                {(['amount', 'litres'] as FuelField[]).map((f) => (
                  <button key={f} role="tab" aria-selected={field === f} data-testid={`fuel-field-${f}`} onClick={() => switchField(f)}
                    className={`min-h-[40px] rounded-lg text-sm font-semibold transition-colors ${field === f ? 'bg-action-500 text-gray-950' : 'text-gray-300 hover:text-white'}`}>
                    {f === 'amount' ? `Amount (${currency})` : 'Litres'}
                  </button>
                ))}
              </div>

              {/* The display: what is typed, and what it comes to */}
              <div className="mt-3 rounded-xl bg-gray-950 border border-gray-800 px-4 py-3 font-mono text-right">
                <div className="text-3xl text-white tabular-nums min-h-[2.5rem]" data-testid="fuel-entry">
                  {field === 'amount' ? `${currency} ${entry || '0'}` : `${entry || '0'} L`}
                </div>
                <div className="text-sm text-amber-300 tabular-nums mt-1" data-testid="fuel-conversion">
                  {field === 'amount' ? `= ${litresText(sale.litres)}` : `= ${currency} ${moneyText(sale.amount)}`}
                </div>
              </div>
              {fullTank && (
                <p className="text-xs text-gray-400 mt-2" data-testid="full-tank-hint">Full tank: fill up, then enter the litres the pump shows.</p>
              )}

              <div className="grid grid-cols-4 gap-2 mt-3">
                {QUICK_AMOUNTS.map((q) => (
                  <button key={q} data-testid="fuel-quick" onClick={() => { setField('amount'); setEntry(String(q)); setFullTank(false); }}
                    className="press min-h-[44px] bg-gray-800 border border-gray-700 hover:border-action-500 text-gray-100 text-sm font-semibold rounded-lg transition-colors">
                    {q.toLocaleString('en-KE')}
                  </button>
                ))}
                <button data-testid="fuel-full-tank" onClick={() => { setField('litres'); setEntry(''); setFullTank(true); }}
                  className={`press min-h-[44px] border text-sm font-semibold rounded-lg transition-colors ${fullTank ? 'bg-action-500/15 border-action-500 text-white' : 'bg-gray-800 border-gray-700 hover:border-action-500 text-gray-100'}`}>
                  Full tank
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3">
                {KEYS.map((k) => (
                  <button key={k} onClick={() => press(k)} data-testid={`fuel-key-${k}`} aria-label={k === 'back' ? 'Delete' : k}
                    className="press min-h-[52px] rounded-xl bg-gray-800 border border-gray-700 hover:border-gray-500 text-xl font-semibold text-white transition-colors">
                    {k === 'back' ? '⌫' : k}
                  </button>
                ))}
              </div>

              <div className="flex gap-2 mt-4">
                <button onClick={close}
                  className="flex-1 min-h-[48px] bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 rounded-lg transition-colors">
                  Cancel
                </button>
                <button onClick={confirm} disabled={!(sale.amount > 0) || !(sale.litres > 0)} data-testid="fuel-add"
                  className="press flex-[2] min-h-[48px] bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:hover:bg-action-500 text-gray-950 font-semibold rounded-lg transition-colors">
                  Add to sale · {currency} {moneyText(sale.amount)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One grade's gauge: a semicircle (SVG) — the tank's level, or today's litres against yesterday's. */
export function GradeGauge({ name, colour, gauge }: { name: string; colour: string; gauge: Gauge | null }) {
  const r = 40, len = Math.PI * r;
  const pct = gauge?.pct ?? 0;
  const low = gauge?.kind === 'tank' && gauge.low;
  const stroke = low ? '#ef4444' : colour;
  const fmtL = (n: number) => `${Math.round(n).toLocaleString('en-KE')} L`;
  return (
    <div className={`rounded-xl border p-3 bg-gray-800/60 ${low ? 'border-red-500/60' : 'border-gray-700'}`} data-testid="grade-gauge"
      data-kind={gauge?.kind ?? 'none'} data-low={low ? '1' : '0'}>
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: colour }} />
        <span className="text-sm font-semibold text-white truncate">{name}</span>
      </div>
      <div className="flex items-end gap-3">
        <svg viewBox="0 0 100 56" className="w-24 h-14 flex-shrink-0" role="img"
          aria-label={gauge ? `${name}: ${Math.round(pct)}%` : `${name}: not known yet`}>
          <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" className="text-gray-700" />
          {gauge && pct > 0 && (
            <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke={stroke} strokeWidth="9" strokeLinecap="round"
              strokeDasharray={`${(len * pct) / 100} ${len}`} data-testid="gauge-fill" />
          )}
          {gauge?.kind === 'tank' && (
            // the low mark
            <line x1={50 - 40 * Math.cos(Math.PI * LOW_PCT / 100) * 0.78} y1={50 - 40 * Math.sin(Math.PI * LOW_PCT / 100) * 0.78}
              x2={50 - 40 * Math.cos(Math.PI * LOW_PCT / 100) * 1.12} y2={50 - 40 * Math.sin(Math.PI * LOW_PCT / 100) * 1.12}
              stroke="#ef4444" strokeWidth="2" />
          )}
          <text x="50" y="48" textAnchor="middle" className="fill-current text-white" fontSize="15" fontWeight="700">
            {gauge ? `${Math.round(pct)}%` : '–'}
          </text>
        </svg>
        <div className="min-w-0 text-xs leading-5">
          {!gauge ? (
            <span className="text-gray-500">…</span>
          ) : gauge.kind === 'tank' ? (
            <>
              <div className={`font-semibold tabular-nums ${low ? 'text-red-300' : 'text-white'}`} data-testid="gauge-left">{fmtL(gauge.left)} left</div>
              <div className="text-gray-400 tabular-nums">of {fmtL(gauge.capacity)}{gauge.tanks > 1 ? ` · ${gauge.tanks} tanks` : ''}</div>
              {low && <div className="text-red-300 font-semibold">Low</div>}
            </>
          ) : (
            <>
              <div className="font-semibold text-white tabular-nums" data-testid="gauge-today">{litresText(gauge.today)} today</div>
              <div className="text-gray-400 tabular-nums">{litresText(gauge.yesterday)} yesterday</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATE_STYLE: Record<PumpState, string> = {
  idle: 'bg-gray-700 text-gray-200',
  in_use: 'bg-amber-500/20 text-amber-200',
  selected: 'bg-action-500 text-gray-950',
  off: 'bg-gray-800 text-gray-500',
  no_price: 'bg-gray-800 text-amber-300',
};

/** One pump, drawn as a dispenser: the grade's colour band, the display (its last sale), the price and the counter. */
export function Dispenser({ pump, currency, colour, state, day, onTap }: {
  pump: Pump; currency: string; colour: string; state: PumpState;
  day?: Forecourt['pumps'][number]; onTap: (p: Pump) => void;
}) {
  const usable = state !== 'off' && state !== 'no_price';
  const last = day?.last_sale_at ? new Date(day.last_sale_at) : null;
  return (
    <button onClick={() => onTap(pump)} disabled={!usable} data-testid="pump-card" data-state={state}
      className={`press text-left rounded-2xl border overflow-hidden transition-colors ${usable ? 'bg-gray-800 hover:border-action-500' : 'bg-gray-900 opacity-60 cursor-not-allowed'} ${state === 'selected' ? 'border-action-500 ring-2 ring-action-500/50' : state === 'in_use' ? 'border-amber-500/60' : 'border-gray-700'}`}>
      <div className="px-3 py-2 flex items-center justify-between gap-2" style={{ background: colour }}>
        <span className="text-sm font-bold text-white truncate drop-shadow">{pump.fuel_product_name ?? 'No fuel product'}</span>
        <span aria-hidden className="text-white/90 text-base">⛽</span>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-base font-semibold text-white truncate">{pump.name}</span>
          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${STATE_STYLE[state]}`}>{PUMP_STATE_LABEL[state]}</span>
        </div>
        {/* The dispenser's display: the last sale */}
        <div className="rounded-lg bg-gray-950 border border-gray-800 px-2.5 py-2 font-mono tabular-nums" data-testid="pump-display">
          <div className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500"><span>Last sale</span><span>{last ? last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
          <div className="text-right text-lg text-amber-300 leading-tight">{day?.last_sale_amount != null ? `${currency} ${moneyText(day.last_sale_amount)}` : '— —'}</div>
          <div className="text-right text-xs text-amber-200/80">{day?.last_sale_litres != null ? litresText(day.last_sale_litres) : ''}</div>
        </div>
        <div className="flex items-baseline justify-between text-xs">
          {state === 'no_price'
            ? <span className="text-amber-300">Map a fuel product in the dashboard</span>
            : <span className="text-white font-semibold">{currency} {moneyText(pump.price_per_litre ?? 0)}<span className="text-gray-400 font-normal">/L</span></span>}
          {day && <span className="text-gray-400 tabular-nums" data-testid="pump-today">Today {litresText(day.litres_today)}</span>}
        </div>
      </div>
    </button>
  );
}
