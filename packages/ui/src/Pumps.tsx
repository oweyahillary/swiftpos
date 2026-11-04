/**
 * Pumps — the petrol station's pumps and gauges on both POS (owner decision 2026-11-04, "6 yes": the web POS takes the
 * desktop's forecourt; docs/POS-SCREEN-COMPARISON.html). The rules are @zaptill/core/forecourt's (gradeGauge, pumpState).
 *
 *   - GradeGauge: one fuel grade's gauge, a semicircle — the tanks' level (red at the low mark) when the POS knows it, else
 *     the litres sold today against yesterday (the desktop's own count); "–" when nothing is known.
 *   - Dispenser: one pump drawn as a dispenser — the grade's colour band, its state (Idle / In use / Selected / Off / No
 *     price), the display with its last sale (when the POS knows it), the price per litre and the litres today.
 *
 * Each app passes its look (./paint.ts) and keeps its own layout around them (the web's phone grid, the desktop's).
 */
import type { ReactNode } from 'react';
import { LOW_PCT, PUMP_STATE_LABEL, litresText, moneyText, type Gauge, type PumpState } from '@zaptill/core/forecourt';
import { painted, type Paint } from './paint';

export interface GradeGaugeLook {
  card: (low: boolean) => Paint;
  head: Paint;
  dot: Paint;
  name: Paint;
  row: Paint;
  svg: Paint;
  track: Paint;
  value: Paint;
  figures: Paint;
  main: (low: boolean) => Paint;
  sub: Paint;
  low: Paint;
}

/** One grade's gauge. */
export function GradeGauge({ name, colour, gauge, look }: { name: string; colour: string; gauge: Gauge | null; look: GradeGaugeLook }) {
  const r = 40, len = Math.PI * r;
  const pct = gauge?.pct ?? 0;
  const low = gauge?.kind === 'tank' && gauge.low;
  const stroke = low ? '#ef4444' : colour;
  const fmtL = (n: number) => `${Math.round(n).toLocaleString('en-KE')} L`;
  const mark = (k: number) => ({ x: 50 - 40 * Math.cos(Math.PI * LOW_PCT / 100) * k, y: 50 - 40 * Math.sin(Math.PI * LOW_PCT / 100) * k });
  return (
    <div {...painted(look.card(!!low))} data-testid="grade-gauge" data-kind={gauge?.kind ?? 'none'} data-low={low ? '1' : '0'}>
      <div {...painted(look.head)}>
        <span {...painted(look.dot)} style={{ ...painted(look.dot).style, background: colour }} />
        <span {...painted(look.name)}>{name}</span>
      </div>
      <div {...painted(look.row)}>
        <svg viewBox="0 0 100 56" {...painted(look.svg)} role="img" aria-label={gauge ? `${name}: ${Math.round(pct)}%` : `${name}: not known yet`}>
          <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" {...painted(look.track)} />
          {gauge && pct > 0 && (
            <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke={stroke} strokeWidth="9" strokeLinecap="round"
              strokeDasharray={`${(len * pct) / 100} ${len}`} data-testid="gauge-fill" />
          )}
          {gauge?.kind === 'tank' && (
            // the low mark
            <line x1={mark(0.78).x} y1={mark(0.78).y} x2={mark(1.12).x} y2={mark(1.12).y} stroke="#ef4444" strokeWidth="2" />
          )}
          <text x="50" y="48" textAnchor="middle" fontSize="15" fontWeight="700" {...painted(look.value)}>
            {gauge ? `${Math.round(pct)}%` : '–'}
          </text>
        </svg>
        <div {...painted(look.figures)}>
          {!gauge ? (
            <span {...painted(look.sub)}>…</span>
          ) : gauge.kind === 'tank' ? (
            <>
              <div {...painted(look.main(!!low))} data-testid="gauge-left">{fmtL(gauge.left)} left</div>
              <div {...painted(look.sub)}>of {fmtL(gauge.capacity)}{gauge.tanks > 1 ? ` · ${gauge.tanks} tanks` : ''}</div>
              {low && <div {...painted(look.low)}>Low</div>}
            </>
          ) : (
            <>
              <div {...painted(look.main(false))} data-testid="gauge-today">{litresText(gauge.today)} today</div>
              <div {...painted(look.sub)}>{litresText(gauge.yesterday)} yesterday</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a dispenser shows about a pump. */
export interface DispenserPump {
  id: string;
  name: string;
  fuel_product_name?: string | null;
  price_per_litre?: number | null;
}

/** The pump's day on this POS (the desktop's own count; the web has none). */
export interface DispenserDay {
  litres_today: number;
  last_sale_at: string | null;
  last_sale_litres: number | null;
  last_sale_amount: number | null;
}

export interface DispenserLook {
  card: (state: PumpState, usable: boolean) => Paint;
  band: Paint;
  grade: Paint;
  icon: Paint;
  body: Paint;
  head: Paint;
  name: Paint;
  state: (state: PumpState) => Paint;
  display: Paint;
  displayHead: Paint;
  displayAmount: Paint;
  displayLitres: Paint;
  foot: Paint;
  price: Paint;
  perLitre: Paint;
  noPrice: Paint;
  today: Paint;
}

/** One pump, drawn as a dispenser. `extra`: what the app adds under it (the web: the open sale's items and time). */
export function Dispenser<P extends DispenserPump>({ pump, currency, colour, state, day, onTap, look, extra }: {
  pump: P; currency: string; colour: string; state: PumpState; day?: DispenserDay | null;
  onTap: (p: P) => void; look: DispenserLook; extra?: ReactNode;
}) {
  const usable = state !== 'off' && state !== 'no_price';
  const last = day?.last_sale_at ? new Date(day.last_sale_at) : null;
  return (
    <button type="button" onClick={() => onTap(pump)} disabled={!usable} data-testid="pump-card" data-state={state} {...painted(look.card(state, usable))}>
      <div {...painted(look.band)} style={{ ...painted(look.band).style, background: colour }}>
        <span {...painted(look.grade)}>{pump.fuel_product_name ?? 'No fuel product'}</span>
        <span aria-hidden {...painted(look.icon)}>⛽</span>
      </div>
      <div {...painted(look.body)}>
        <div {...painted(look.head)}>
          <span {...painted(look.name)}>{pump.name}</span>
          <span {...painted(look.state(state))}>{PUMP_STATE_LABEL[state]}</span>
        </div>
        {/* The dispenser's display: the last sale */}
        <div {...painted(look.display)} data-testid="pump-display">
          <div {...painted(look.displayHead)}><span>Last sale</span><span>{last ? last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
          <div {...painted(look.displayAmount)}>{day?.last_sale_amount != null ? `${currency} ${moneyText(day.last_sale_amount)}` : '— —'}</div>
          <div {...painted(look.displayLitres)}>{day?.last_sale_litres != null ? litresText(day.last_sale_litres) : ''}</div>
        </div>
        <div {...painted(look.foot)}>
          {state === 'no_price'
            ? <span {...painted(look.noPrice)}>Map a fuel product in the dashboard</span>
            : <span {...painted(look.price)}>{currency} {moneyText(pump.price_per_litre ?? 0)}<span {...painted(look.perLitre)}>/L</span></span>}
          {day && <span {...painted(look.today)} data-testid="pump-today">Today {litresText(day.litres_today)}</span>}
        </div>
        {extra}
      </div>
    </button>
  );
}
