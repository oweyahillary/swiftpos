/**
 * Forecourt.tsx — A588: the web POS's petrol pieces (owner, 2026-10-24: "FIX the petrol pos shop item, make it feel
 * petrol-like, you can add gauges"). Grade colours and the gauge rule are the till's (lib/forecourt.ts, shared).
 *
 *   - FuelStrip: the fuel grades as pump nozzles above the shop's grid — the grades are never shop tiles any more (the
 *     grid used to list ONLY the fuel, so a petrol station's shop items could only be scanned). A grade tapped opens the
 *     fuel entry (amount or litres) as before; the open pump's own grade comes first.
 *   - PumpGrade: on a pump's card, its grade's colour and name and, when the cloud holds its tank, the tank's level as a
 *     small gauge ("x L left"; red under 20 % or at the reorder level). No tank linked → no gauge (nothing made up).
 */
import { gradeColour, gradeGauge, LOW_PCT, type ForecourtData } from '@zaptill/core/forecourt';

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

/** The tank(s) a pump draws from, as the gauge rule reads them. */
function tankData(productId: string, tanks: PumpTank[]): ForecourtData {
  return {
    pumps: [], grades: [], tanksAt: null,
    tanks: tanks.map((t) => ({ id: t.id, name: t.name ?? '', product_id: productId, capacity_litres: Number(t.capacity_litres) || 0,
      current_level: Math.max(0, Number(t.current_level) || 0),
      reorder_level: t.reorder_level === null || t.reorder_level === undefined ? null : Number(t.reorder_level) })),
  };
}

export function PumpGrade({ name, productId, categoryColour, index, tanks }: {
  name: string | null; productId: string | null; categoryColour?: string | null; index: number; tanks?: PumpTank | PumpTank[] | null;
}) {
  const colour = gradeColour(name, categoryColour ?? null, index);
  const list = (Array.isArray(tanks) ? tanks : tanks ? [tanks] : []).filter((t) => Number(t.capacity_litres) > 0);
  const gauge = productId && list.length > 0 ? gradeGauge(productId, tankData(productId, list)) : null;
  const tank = gauge && gauge.kind === 'tank' ? gauge : null;
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: colour, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        ⛽ {name ?? 'Pump'}
      </span>
      {tank && (
        <div data-testid="pump-tank" data-low={tank.low ? '1' : '0'} title={`${Math.round(tank.left).toLocaleString('en-KE')} L left of ${Math.round(tank.capacity).toLocaleString('en-KE')} L`}
          style={{ width: '86%' }}>
          <div style={{ position: 'relative', height: 6, borderRadius: 3, background: 'var(--pos-border)' }}>
            <div style={{ position: 'absolute', inset: 0, width: `${tank.pct}%`, borderRadius: 3, background: tank.low ? '#ef4444' : colour }} />
            <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${LOW_PCT}%`, width: 1, background: '#ef4444' }} />
          </div>
          <div style={{ fontSize: 10, color: tank.low ? '#fca5a5' : 'var(--pos-text4)', marginTop: 2 }}>
            {Math.round(tank.left).toLocaleString('en-KE')} L left{tank.low ? ' · Low' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
