/**
 * Forecourt.tsx — the web POS's petrol pieces. A588 (owner, 2026-10-24: "FIX the petrol pos shop item, make it feel
 * petrol-like, you can add gauges"); owner, 2026-11-04 ("6 yes"): the web takes the desktop's forecourt — its dispensers,
 * gauges and fuel keypad, built once in @zaptill/ui (Pumps, FuelKeypad). This file keeps the web's look of them (styles
 * on the POS theme tokens, so they follow the business's theme and fit a phone) and what only the web has:
 *
 *   - FuelStrip: the fuel grades as pump nozzles above the shop's grid — the grades are never shop tiles (the grid used to
 *     list ONLY the fuel, so a petrol station's shop items could only be scanned). A grade tapped opens the fuel keypad;
 *     the open pump's own grade comes first.
 *   - tanksData: the tanks the web knows (each /api/pumps row carries the tank its pump draws from), for the gauges — a
 *     grade with no tank linked gets no gauge (the web keeps no litres-today count of its own; nothing is made up).
 */
import type { CSSProperties } from 'react';
import { gradeColour, type ForecourtData, type PumpState } from '@zaptill/core/forecourt';
import type { FuelKeypadLook } from '@zaptill/ui/FuelKeypad';
import type { GradeGaugeLook, DispenserLook } from '@zaptill/ui/Pumps';

interface FuelProduct { id: string; name: string; base_price: number | string; category_color?: string | null; fuel_unit?: string | null }
export interface PumpTank { id: string; name?: string; current_level: number | string; capacity_litres: number | string; reorder_level?: number | string | null }

export function FuelStrip({ grades, currency, firstId, onPick }: {
  grades: FuelProduct[]; currency: string; firstId?: string | null; onPick: (p: FuelProduct) => void;
}) {
  if (grades.length === 0) return null;
  const list = firstId ? [...grades].sort((a, b) => (a.id === firstId ? -1 : b.id === firstId ? 1 : 0)) : grades;
  return (
    <div data-testid="fuel-strip" style={{ display: 'flex', gap: 8, padding: '8px 16px', overflowX: 'auto', flexShrink: 0,
      borderBottom: '1px solid var(--pos-border-l)', background: 'var(--pos-panel)' }}>
      {list.map((g, i) => {
        const colour = gradeColour(g.name, g.category_color ?? null, grades.indexOf(g));
        return (
          <button key={g.id} type="button" data-testid="fuel-grade" onClick={() => onPick(g)} className="press"
            style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '6px 12px', borderRadius: 10,
              cursor: 'pointer', whiteSpace: 'nowrap', background: 'var(--pos-surface)',
              border: `2px solid ${i === 0 && firstId === g.id ? colour : 'var(--pos-border)'}` }}>
            <span aria-hidden style={{ width: 10, height: 24, borderRadius: 4, background: colour }} />
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--pos-text)' }}>⛽ {g.name}</span>
              <span style={{ fontSize: 11, color: 'var(--pos-text3)' }}>{currency} {Number(g.base_price).toLocaleString('en-KE', { minimumFractionDigits: 2 })}/{g.fuel_unit ?? 'L'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The tanks the pumps draw from (each once), as the gauge rule reads them; the grades that have one. */
export function tanksData(pumps: Array<{ fuel_product_id?: string | null; fuel_tanks?: PumpTank | PumpTank[] | null }>):
  { data: ForecourtData; grades: Set<string> } {
  const seen = new Map<string, NonNullable<ForecourtData['tanks']>[number]>();
  for (const p of pumps) {
    if (!p.fuel_product_id) continue;
    for (const t of Array.isArray(p.fuel_tanks) ? p.fuel_tanks : p.fuel_tanks ? [p.fuel_tanks] : []) {
      const capacity = Number(t.capacity_litres) || 0;
      if (capacity <= 0) continue;
      // Keyed by the tank: one that two pumps share is counted once.
      seen.set(t.id, { id: t.id, name: t.name ?? '', product_id: p.fuel_product_id, capacity_litres: capacity,
        current_level: Math.max(0, Number(t.current_level) || 0),
        reorder_level: t.reorder_level === null || t.reorder_level === undefined ? null : Number(t.reorder_level) });
    }
  }
  const tanks = [...seen.values()];
  return { data: { pumps: [], grades: [], tanks, tanksAt: null }, grades: new Set(tanks.map((t) => t.product_id)) };
}

// ── The web's look of the shared pieces (the POS theme tokens; sizes that fit a phone) ──────────────────────────────

const st = (style: CSSProperties) => ({ style });
const pressed = (style: CSSProperties) => ({ className: 'press', style });
const ACCENT = 'rgb(var(--act-strong, 34 197 94))';
const chip: CSSProperties = { minHeight: 44, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  background: 'var(--pos-surface)', border: '1px solid var(--pos-border)', color: 'var(--pos-text)' };

export const KEYPAD_LOOK: FuelKeypadLook = {
  card: { className: 'animate-pop-in', style: { width: '92vw', maxWidth: 420, maxHeight: '94vh', overflowY: 'auto', borderRadius: 16,
    background: 'var(--pos-panel)', border: '1px solid var(--pos-border)' } },
  body: st({ padding: 16 }),
  head: st({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }),
  title: st({ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--pos-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  subtitle: st({ fontSize: 12, color: 'var(--pos-text3)' }),
  close: st({ minWidth: 40, minHeight: 40, fontSize: 22, lineHeight: 1, background: 'transparent', border: 'none', color: 'var(--pos-text3)', cursor: 'pointer' }),
  tabs: st({ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, borderRadius: 12, background: 'var(--pos-surface)' }),
  tab: (on) => st({ minHeight: 40, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', border: 'none',
    background: on ? ACCENT : 'transparent', color: on ? '#0b1220' : 'var(--pos-text3)' }),
  display: st({ marginTop: 10, borderRadius: 12, padding: '10px 14px', textAlign: 'right', fontFamily: 'ui-monospace, monospace',
    background: 'var(--pos-bg)', border: '1px solid var(--pos-border)' }),
  entry: st({ fontSize: 28, minHeight: 36, color: 'var(--pos-text)', fontVariantNumeric: 'tabular-nums' }),
  conversion: st({ marginTop: 2, fontSize: 14, color: '#fcd34d', fontVariantNumeric: 'tabular-nums' }),
  hint: st({ margin: '8px 0 0', fontSize: 12, color: 'var(--pos-text3)' }),
  quickRow: st({ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }),
  quick: pressed(chip),
  fullTank: (on) => pressed({ ...chip, ...(on ? { borderColor: ACCENT } : {}) }),
  keys: st({ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }),
  key: pressed({ ...chip, minHeight: 50, borderRadius: 12, fontSize: 20 }),
  actions: st({ marginTop: 12, display: 'flex', gap: 8 }),
  cancel: st({ ...chip, flex: 1, minHeight: 48, fontWeight: 500, color: 'var(--pos-text3)' }),
  add: pressed({ flex: 2, minHeight: 48, borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', border: 'none',
    background: ACCENT, color: '#0b1220' }),
};

export const GAUGE_LOOK: GradeGaugeLook = {
  card: (low) => st({ borderRadius: 12, padding: 10, background: 'var(--pos-surface)', border: `1px solid ${low ? 'rgba(239,68,68,0.6)' : 'var(--pos-border)'}` }),
  head: st({ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }),
  dot: st({ width: 10, height: 10, borderRadius: 999, flexShrink: 0 }),
  name: st({ fontSize: 13, fontWeight: 700, color: 'var(--pos-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  row: st({ display: 'flex', alignItems: 'flex-end', gap: 10 }),
  svg: st({ width: 88, height: 50, flexShrink: 0 }),
  track: st({ color: 'var(--pos-border)' }),
  value: st({ fill: 'var(--pos-text)' }),
  figures: st({ minWidth: 0, fontSize: 12, lineHeight: '18px' }),
  main: (low) => st({ fontWeight: 700, color: low ? '#fca5a5' : 'var(--pos-text)', fontVariantNumeric: 'tabular-nums' }),
  sub: st({ color: 'var(--pos-text3)', fontVariantNumeric: 'tabular-nums' }),
  low: st({ color: '#fca5a5', fontWeight: 700 }),
};

const STATE_COLOURS: Record<PumpState, CSSProperties> = {
  idle: { background: 'var(--pos-border)', color: 'var(--pos-text)' },
  in_use: { background: 'rgba(245,158,11,0.2)', color: '#fcd34d' },
  selected: { background: ACCENT, color: '#0b1220' },
  off: { background: 'var(--pos-surface)', color: 'var(--pos-text4)' },
  no_price: { background: 'var(--pos-surface)', color: '#fcd34d' },
};

export const DISPENSER_LOOK: DispenserLook = {
  card: (state, usable) => pressed({ textAlign: 'left', borderRadius: 16, overflow: 'hidden', padding: 0, cursor: usable ? 'pointer' : 'not-allowed',
    opacity: usable ? 1 : 0.6, background: usable ? 'var(--pos-surface)' : 'var(--pos-panel)',
    border: `${state === 'selected' ? 2 : 1}px solid ${state === 'selected' ? ACCENT : state === 'in_use' ? 'rgba(245,158,11,0.6)' : 'var(--pos-border)'}` }),
  band: st({ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }),
  grade: st({ fontSize: 13, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 2px rgba(0,0,0,0.4)' }),
  icon: st({ color: 'rgba(255,255,255,0.9)', fontSize: 15 }),
  body: st({ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }),
  head: st({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }),
  name: st({ fontSize: 15, fontWeight: 700, color: 'var(--pos-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  state: (state) => st({ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap', ...STATE_COLOURS[state] }),
  display: st({ borderRadius: 8, padding: '6px 8px', fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums',
    background: 'var(--pos-bg)', border: '1px solid var(--pos-border)' }),
  displayHead: st({ display: 'flex', justifyContent: 'space-between', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--pos-text4)' }),
  displayAmount: st({ textAlign: 'right', fontSize: 17, lineHeight: 1.2, color: '#fcd34d' }),
  displayLitres: st({ textAlign: 'right', fontSize: 12, color: 'rgba(253,230,138,0.8)' }),
  foot: st({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 12 }),
  price: st({ fontWeight: 700, color: 'var(--pos-text)' }),
  perLitre: st({ fontWeight: 400, color: 'var(--pos-text3)' }),
  noPrice: st({ color: '#fcd34d' }),
  today: st({ color: 'var(--pos-text3)' }),
};
