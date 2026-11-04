import { useEffect, useMemo, useState } from 'react';
import { posApi, type Forecourt, type Pump } from '../lib/posApi';
import { gradeColour, gradeGauge, pumpGrades, pumpState, type Gauge, type PumpState } from '@zaptill/core/forecourt';
import FuelKeypad, { type FuelKeypadLook } from '@zaptill/ui/FuelKeypad';
import { GradeGauge as SharedGauge, Dispenser as SharedDispenser, type GradeGaugeLook, type DispenserLook } from '@zaptill/ui/Pumps';

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
// 2026-11-04 (owner, "6 yes"): the gauge, the dispenser and the keypad are built once in @zaptill/ui (the web POS uses them
// too); this file keeps the desktop's look (the class names below) and its layout.

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

const REFRESH_MS = 60_000;

export default function PumpsView({ pumps, currency, onAddFuel, products = [], onSale = new Set(), refreshKey = '' }: Props) {
  const [data, setData] = useState<Forecourt | null>(null);
  const [active, setActive] = useState<Pump | null>(null);

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

  const openPump = (pump: Pump) => {
    if (pumpState(pump, null, onSale) === 'off' || !pump.price_per_litre || pump.price_per_litre <= 0) return;
    setActive(pump);
  };
  const close = () => setActive(null);

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

      {/* The keypad (@zaptill/ui FuelKeypad) */}
      {active && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in" onClick={close}>
          <FuelKeypad title={active.name} grade={active.fuel_product_name ?? 'Fuel'} colour={colourOf(active.fuel_product_id)}
            price={active.price_per_litre ?? 0} currency={currency} look={KEYPAD_LOOK} onClose={close}
            onAdd={(litres, amount) => { onAddFuel(active, litres, amount); setActive(null); }} />
        </div>
      )}
    </div>
  );
}

// ── The desktop's look of the shared pieces ─────────────────────────────────────────────────────────────────────────

const KEYPAD_LOOK: FuelKeypadLook = {
  card: 'bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md overflow-hidden animate-pop-in',
  body: 'p-5',
  head: 'flex items-center justify-between',
  title: 'text-lg font-semibold text-white truncate',
  subtitle: 'text-xs text-gray-400',
  close: 'min-w-[40px] min-h-[40px] text-gray-300 hover:text-white text-xl leading-none',
  tabs: 'mt-4 grid grid-cols-2 gap-1 p-1 rounded-xl bg-gray-800',
  tab: (on) => `min-h-[40px] rounded-lg text-sm font-semibold transition-colors ${on ? 'bg-action-500 text-gray-950' : 'text-gray-300 hover:text-white'}`,
  display: 'mt-3 rounded-xl bg-gray-950 border border-gray-800 px-4 py-3 font-mono text-right',
  entry: 'text-3xl text-white tabular-nums min-h-[2.5rem]',
  conversion: 'text-sm text-amber-300 tabular-nums mt-1',
  hint: 'text-xs text-gray-400 mt-2',
  quickRow: 'grid grid-cols-4 gap-2 mt-3',
  quick: 'press min-h-[44px] bg-gray-800 border border-gray-700 hover:border-action-500 text-gray-100 text-sm font-semibold rounded-lg transition-colors',
  fullTank: (on) => `press min-h-[44px] border text-sm font-semibold rounded-lg transition-colors ${on ? 'bg-action-500/15 border-action-500 text-white' : 'bg-gray-800 border-gray-700 hover:border-action-500 text-gray-100'}`,
  keys: 'grid grid-cols-3 gap-2 mt-3',
  key: 'press min-h-[52px] rounded-xl bg-gray-800 border border-gray-700 hover:border-gray-500 text-xl font-semibold text-white transition-colors',
  actions: 'flex gap-2 mt-4',
  cancel: 'flex-1 min-h-[48px] bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 rounded-lg transition-colors',
  add: 'press flex-[2] min-h-[48px] bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:hover:bg-action-500 text-gray-950 font-semibold rounded-lg transition-colors',
};

const GAUGE_LOOK: GradeGaugeLook = {
  card: (low) => `rounded-xl border p-3 bg-gray-800/60 ${low ? 'border-red-500/60' : 'border-gray-700'}`,
  head: 'flex items-center gap-2 mb-1',
  dot: 'w-2.5 h-2.5 rounded-full flex-shrink-0',
  name: 'text-sm font-semibold text-white truncate',
  row: 'flex items-end gap-3',
  svg: 'w-24 h-14 flex-shrink-0',
  track: 'text-gray-700',
  value: 'fill-current text-white',
  figures: 'min-w-0 text-xs leading-5',
  main: (low) => `font-semibold tabular-nums ${low ? 'text-red-300' : 'text-white'}`,
  sub: 'text-gray-400 tabular-nums',
  low: 'text-red-300 font-semibold',
};

/** One grade's gauge, in the desktop's look. */
export function GradeGauge(props: { name: string; colour: string; gauge: Gauge | null }) {
  return <SharedGauge {...props} look={GAUGE_LOOK} />;
}

const STATE_STYLE: Record<PumpState, string> = {
  idle: 'bg-gray-700 text-gray-200',
  in_use: 'bg-amber-500/20 text-amber-200',
  selected: 'bg-action-500 text-gray-950',
  off: 'bg-gray-800 text-gray-500',
  no_price: 'bg-gray-800 text-amber-300',
};

const DISPENSER_LOOK: DispenserLook = {
  card: (state, usable) => `press text-left rounded-2xl border overflow-hidden transition-colors ${usable ? 'bg-gray-800 hover:border-action-500' : 'bg-gray-900 opacity-60 cursor-not-allowed'} ${state === 'selected' ? 'border-action-500 ring-2 ring-action-500/50' : state === 'in_use' ? 'border-amber-500/60' : 'border-gray-700'}`,
  band: 'px-3 py-2 flex items-center justify-between gap-2',
  grade: 'text-sm font-bold text-white truncate drop-shadow',
  icon: 'text-white/90 text-base',
  body: 'p-3 space-y-2',
  head: 'flex items-center justify-between gap-2',
  name: 'text-base font-semibold text-white truncate',
  state: (state) => `text-[11px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${STATE_STYLE[state]}`,
  display: 'rounded-lg bg-gray-950 border border-gray-800 px-2.5 py-2 font-mono tabular-nums',
  displayHead: 'flex justify-between text-[10px] uppercase tracking-wider text-gray-500',
  displayAmount: 'text-right text-lg text-amber-300 leading-tight',
  displayLitres: 'text-right text-xs text-amber-200/80',
  foot: 'flex items-baseline justify-between text-xs',
  price: 'text-white font-semibold',
  perLitre: 'text-gray-400 font-normal',
  noPrice: 'text-amber-300',
  today: 'text-gray-400 tabular-nums',
};

/** One pump, drawn as a dispenser, in the desktop's look. */
export function Dispenser({ pump, currency, colour, state, day, onTap }: {
  pump: Pump; currency: string; colour: string; state: PumpState;
  day?: Forecourt['pumps'][number]; onTap: (p: Pump) => void;
}) {
  return <SharedDispenser pump={pump} currency={currency} colour={colour} state={state} day={day} onTap={onTap} look={DISPENSER_LOOK} />;
}
