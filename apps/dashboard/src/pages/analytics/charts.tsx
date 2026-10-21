/**
 * charts.tsx — A553 (Analytics v2): the analytics page's charts, drawn with recharts (the dashboard's one chart library,
 * loaded only with this page's chunk). Every colour comes from chartPalette.ts for the current mode (light / dark); text
 * stays in the dashboard's gray classes (never a series colour); marks are thin (bars ≤ 24 px with a 4 px rounded end,
 * 2 px lines, a 2 px surface gap between stacked parts); every chart has a hover readout and the tables stay below.
 */
import { useState, type ReactNode } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, ComposedChart, Line, BarChart, Bar, Cell, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ScatterChart, Scatter, ReferenceArea, ReferenceLine, PieChart, Pie, LabelList,
} from 'recharts';
import * as fmt from '../../lib/format';
import {
  CLASS_ORDER, CLASS_SHAPE, LEAK_ORDER, LEAK_LABEL, BUCKET_ORDER, BUCKET_LABEL, heatColour,
  type ChartPalette, type ClassKey, type LeakKey,
} from './chartPalette';
import { deltaOf, compact, dayLabel, byHour, byWeekday, topBy, leakParts, leakTotal, shares } from './chartMath';

// ── Pieces ────────────────────────────────────────────────────────────────────

export function ChartCard({ title, sub, legend, children, testId }: { title: string; sub?: string; legend?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-3 sm:p-4 min-w-0" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {sub && <p className="text-xs text-gray-500">{sub}</p>}
        </div>
        {legend}
      </div>
      {children}
    </section>
  );
}

/** A legend: a swatch (or a short line for a line series) beside each name — identity never by colour alone. */
export function Legend({ items }: { items: { label: string; colour: string; line?: boolean; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block flex-shrink-0" style={i.line
            ? { width: 14, height: 2, borderRadius: 1, background: i.colour }
            : { width: 10, height: 10, borderRadius: 3, background: i.colour }} />
          <span>{i.label}</span>
          {i.value && <span className="text-gray-300 font-medium">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

interface TipRow { label: string; value: string; colour?: string }
/** The hover readout: the value leads, the name follows; a short line keys each row. */
function TipBox({ title, rows }: { title?: string; rows: TipRow[] }) {
  return (
    <div className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-lg pointer-events-none max-w-[16rem]">
      {title && <p className="text-gray-400 mb-1">{title}</p>}
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2 leading-5">
          {r.colour && <span aria-hidden style={{ width: 10, height: 2, borderRadius: 1, background: r.colour, flexShrink: 0 }} />}
          <span className="font-semibold text-white">{r.value}</span>
          <span className="text-gray-400">{r.label}</span>
        </p>
      ))}
    </div>
  );
}

// recharts hands the tooltip content its own props; only these are read here
interface TipProps { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }>; label?: unknown }
const first = <T,>(p: TipProps): T | null => (p.active && p.payload && p.payload[0] ? (p.payload[0].payload as T) : null);

const axisTick = (p: ChartPalette) => ({ fill: p.muted, fontSize: 11 });
const noAnim = { isAnimationActive: false } as const;

// ── KPI tiles ─────────────────────────────────────────────────────────────────

export interface KpiTileProps {
  label: string; value: string; change: number | null | undefined; upIsGood: boolean; points?: boolean;
  compareLabel: string; spark?: number[]; p: ChartPalette; note?: string; testId?: string;
}
export function KpiTile({ label, value, change, upIsGood, points, compareLabel, spark, p, note, testId }: KpiTileProps) {
  const d = deltaOf(change, { upIsGood, points });
  const tone = d.good === null ? undefined : d.good ? p.deltaGood : p.deltaBad;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 min-w-0 flex flex-col" data-testid={testId}>
      <p className="text-xs text-gray-500 truncate">{label}</p>
      <p className="text-xl sm:text-2xl font-semibold text-white mt-0.5 truncate">{value}</p>
      <p className="text-xs mt-0.5 truncate">
        <span className={tone ? 'font-semibold' : 'text-gray-500'} style={tone ? { color: tone } : undefined} data-direction={d.direction}>{d.text}</span>
        {d.direction !== 'none' && <span className="text-gray-500"> vs {compareLabel}</span>}
      </p>
      {note && <p className="text-[11px] text-gray-500 mt-0.5 truncate">{note}</p>}
      {spark && spark.length > 1 && (
        <div className="h-9 mt-auto pt-1" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
              <Area type="monotone" dataKey="v" stroke={p.accent} strokeWidth={1.5} fill={p.accent} fillOpacity={0.12} dot={false} {...noAnim} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Revenue trend ─────────────────────────────────────────────────────────────

export interface TrendDay { day: string; revenue: number; orders: number; prevDay: string; prevRevenue: number; prevOrders: number }
export function RevenueTrend({ days, p, currency }: { days: TrendDay[]; p: ChartPalette; currency: string }) {
  const data = days.map((d) => ({ ...d, label: dayLabel(d.day) }));
  return (
    <div className="h-56 sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={p.grid} />
          <XAxis dataKey="label" tick={axisTick(p)} tickLine={false} axisLine={{ stroke: p.axis }} minTickGap={24} />
          <YAxis tick={axisTick(p)} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => compact(v)} />
          <Tooltip cursor={{ stroke: p.axis, strokeWidth: 1 }} content={(t: TipProps) => {
            const d = first<TrendDay>(t);
            return d ? <TipBox title={`${dayLabel(d.day)} (against ${dayLabel(d.prevDay)})`} rows={[
              { label: `this period · ${d.orders} orders`, value: fmt.money(d.revenue, currency, { decimals: 0 }), colour: p.accent },
              { label: `previous · ${d.prevOrders} orders`, value: fmt.money(d.prevRevenue, currency, { decimals: 0 }), colour: p.compare },
            ]} /> : null;
          }} />
          <Line type="monotone" dataKey="prevRevenue" stroke={p.compare} strokeWidth={1.5} strokeOpacity={0.8} dot={false} activeDot={{ r: 3, fill: p.compare, stroke: p.surface, strokeWidth: 2 }} {...noAnim} />
          <Area type="monotone" dataKey="revenue" stroke={p.accent} strokeWidth={2} fill={p.accent} fillOpacity={0.08} dot={false}
            activeDot={{ r: 4, fill: p.accent, stroke: p.surface, strokeWidth: 2 }} {...noAnim} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Donut (payment mix, leak split) ───────────────────────────────────────────

export interface Slice { key: string; label: string; value: number; colour: string }
export function Donut({ slices, p, currency, centre, testId }: { slices: Slice[]; p: ChartPalette; currency: string; centre: string; testId?: string }) {
  const s = shares(slices);
  if (!s.length) return <p className="text-sm text-gray-500 py-6 text-center">Nothing in this period.</p>;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4" data-testid={testId}>
      <div className="relative w-44 h-44 flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={s} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="96%" paddingAngle={s.length > 1 ? 1 : 0}
              stroke={p.surface} strokeWidth={2} startAngle={90} endAngle={-270} {...noAnim}>
              {s.map((x) => <Cell key={x.key} fill={x.colour} />)}
            </Pie>
            <Tooltip content={(t: TipProps) => {
              const x = first<Slice & { share: number }>(t);
              return x ? <TipBox rows={[{ label: `${x.label} · ${(x.share * 100).toFixed(1)}%`, value: fmt.money(x.value, currency, { decimals: 0 }), colour: x.colour }]} /> : null;
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-6">
          <span className="text-[11px] text-gray-500">Total</span>
          <span className="text-sm font-semibold text-white leading-tight">{centre}</span>
        </div>
      </div>
      <ul className="w-full space-y-1.5 text-sm">
        {s.map((x) => (
          <li key={x.key} className="flex items-center gap-2">
            <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: x.colour }} />
            <span className="text-gray-300 flex-1 min-w-0">{x.label}</span>
            <span className="text-white font-medium tabular-nums">{fmt.money(x.value, currency, { decimals: 0 })}</span>
            <span className="text-gray-500 tabular-nums w-12 text-right">{(x.share * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Menu engineering ──────────────────────────────────────────────────────────

export interface MenuPoint { productId: string | null; name: string; qty: number; revenue: number; share: number; unitMargin: number | null; class: ClassKey | null }
const CLASS_LABEL: Record<ClassKey, string> = { star: 'Stars', plowhorse: 'Plowhorses', puzzle: 'Puzzles', dog: 'Dogs', no_cost: 'No cost set' };

export function classLegend(p: ChartPalette, withNoCost = false) {
  return CLASS_ORDER.filter((k) => withNoCost || k !== 'no_cost').map((k) => ({ label: CLASS_LABEL[k], colour: p.classes[k] }));
}

/** Popularity across, unit margin up, the four quadrants tinted, each item a bubble sized by its revenue. */
export function MenuScatter({ items, threshold, avgMargin, p, currency }: { items: MenuPoint[]; threshold: number; avgMargin: number; p: ChartPalette; currency: string }) {
  const pts = items.filter((i) => i.unitMargin !== null && i.class && i.class !== 'no_cost').map((i) => ({ ...i, x: i.share * 100, y: i.unitMargin as number }));
  const maxX = Math.max(threshold * 2, ...pts.map((q) => q.share)) * 100 * 1.1;
  const ys = pts.map((q) => q.y);
  const lo = Math.min(0, avgMargin, ...ys), hi = Math.max(avgMargin, ...ys);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  const minY = lo < 0 ? lo - pad : 0, maxY = hi + pad;
  const tx = threshold * 100;
  const quad = (k: ClassKey, x1: number, x2: number, y1: number, y2: number) => (
    <ReferenceArea key={k} x1={x1} x2={x2} y1={y1} y2={y2} fill={p.classes[k]} fillOpacity={p.quadrantOpacity} stroke="none" ifOverflow="hidden"
      label={{ value: CLASS_LABEL[k], position: x1 === 0 ? (y1 === avgMargin ? 'insideTopLeft' : 'insideBottomLeft') : (y1 === avgMargin ? 'insideTopRight' : 'insideBottomRight'), fill: p.inkSoft, fontSize: 12, fontWeight: 600 }} />
  );
  return (
    <div className="h-72 sm:h-80" data-testid="analytics-menu-scatter">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
          {quad('puzzle', 0, tx, avgMargin, maxY)}
          {quad('star', tx, maxX, avgMargin, maxY)}
          {quad('dog', 0, tx, minY, avgMargin)}
          {quad('plowhorse', tx, maxX, minY, avgMargin)}
          <CartesianGrid stroke={p.grid} strokeOpacity={0.6} />
          <XAxis type="number" dataKey="x" domain={[0, maxX]} tick={axisTick(p)} tickLine={false} axisLine={{ stroke: p.axis }}
            tickFormatter={(v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`} allowDecimals
            label={{ value: 'Popularity (share of items sold)', position: 'insideBottom', offset: -10, fill: p.muted, fontSize: 11 }} />
          <YAxis type="number" dataKey="y" domain={[minY, maxY]} tick={axisTick(p)} tickLine={false} axisLine={false} width={44}
            tickFormatter={(v: number) => compact(v)} />
          <ZAxis type="number" dataKey="revenue" range={[60, 700]} />
          <ReferenceLine x={tx} stroke={p.axis} strokeWidth={1} />
          <ReferenceLine y={avgMargin} stroke={p.axis} strokeWidth={1} />
          <Tooltip cursor={false} content={(t: TipProps) => {
            const d = first<MenuPoint>(t);
            return d && d.class ? <TipBox title={`${d.name} · ${CLASS_LABEL[d.class].replace(/s$/, '')}`} rows={[
              { label: 'sold', value: fmt.qty(d.qty), colour: p.classes[d.class] },
              { label: 'margin a unit', value: fmt.money(d.unitMargin, currency, { decimals: 0 }) },
              { label: 'revenue', value: fmt.money(d.revenue, currency, { decimals: 0 }) },
            ]} /> : null;
          }} />
          {(['star', 'plowhorse', 'puzzle', 'dog'] as ClassKey[]).map((k) => (
            <Scatter key={k} name={CLASS_LABEL[k]} data={pts.filter((q) => q.class === k)} fill={p.classes[k]} fillOpacity={0.85}
              stroke={p.surface} strokeWidth={1.5} shape={CLASS_SHAPE[k]} {...noAnim} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The ten best sellers by revenue, each bar in its class colour (the accent when classes are hidden). */
export function TopItemsBar({ items, p, currency }: { items: MenuPoint[]; p: ChartPalette; currency: string }) {
  const top = topBy(items, (i) => i.revenue, 10);
  const colour = (i: MenuPoint) => (i.class ? p.classes[i.class] : p.accent);
  return (
    <div style={{ height: Math.max(120, top.length * 30 + 16) }} data-testid="analytics-top-items">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={top} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="name" width={112} tick={{ fill: p.inkSoft, fontSize: 12 }} tickLine={false} axisLine={false}
            tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
          <Tooltip cursor={{ fill: p.grid, fillOpacity: 0.5 }} content={(t: TipProps) => {
            const d = first<MenuPoint>(t);
            return d ? <TipBox title={d.name} rows={[
              { label: 'revenue', value: fmt.money(d.revenue, currency, { decimals: 0 }), colour: colour(d) },
              { label: 'sold', value: fmt.qty(d.qty) },
              ...(d.class ? [{ label: 'class', value: CLASS_LABEL[d.class].replace(/s$/, '') }] : []),
            ]} /> : null;
          }} />
          <Bar dataKey="revenue" radius={[0, 4, 4, 0]} maxBarSize={20} {...noAnim}>
            {top.map((i) => <Cell key={i.productId ?? i.name} fill={colour(i)} />)}
            <LabelList dataKey="revenue" position="right" formatter={(v: unknown) => compact(Number(v))} style={{ fill: p.muted, fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Busy times ────────────────────────────────────────────────────────────────

const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

export interface HeatData { revenue: number[][]; orders: number[][]; maxRevenue: number; tradingHours: { from: number; to: number } | null }

/** The weekday × hour grid on the sequential ramp, a hover readout above it and the ramp's legend below. */
export function Heatmap({ h, p, currency }: { h: HeatData; p: ChartPalette; currency: string }) {
  const [hover, setHover] = useState<{ d: number; k: number } | null>(null);
  if (!h.tradingHours) return null;
  const hours: number[] = [];
  for (let k = h.tradingHours.from; k <= h.tradingHours.to; k++) hours.push(k);
  const read = hover ? { label: `${DAYS_SHORT[hover.d]} ${hh(hover.k)}–${hh(hover.k + 1)}`, rev: h.revenue[hover.d]?.[hover.k] ?? 0, ord: h.orders[hover.d]?.[hover.k] ?? 0 } : null;
  return (
    <div>
      <p className="text-xs text-gray-400 h-5 mb-1" aria-live="polite">
        {read ? <><span className="text-white font-semibold">{fmt.money(read.rev, currency, { decimals: 0 })}</span> · {read.ord} orders · {read.label}</> : 'Point at a square to see its sales.'}
      </p>
      <div className="overflow-x-auto">
        <table className="border-separate text-[11px] w-full min-w-[32rem] table-fixed" style={{ borderSpacing: 2 }} data-testid="analytics-heatmap" onMouseLeave={() => setHover(null)}>
          <thead><tr>
            <th className="w-10" />
            {hours.map((k) => <th key={k} className="font-normal text-gray-500 px-0.5">{String(k).padStart(2, '0')}</th>)}
          </tr></thead>
          <tbody>
            {DAYS_SHORT.map((d, di) => (
              <tr key={d}>
                <th className="text-left font-normal text-gray-500 pr-1">{d}</th>
                {hours.map((k) => {
                  const v = h.revenue[di]?.[k] ?? 0, o = h.orders[di]?.[k] ?? 0;
                  const bg = heatColour(p, v, h.maxRevenue);
                  const on = hover?.d === di && hover.k === k;
                  return (
                    <td key={k} tabIndex={0} className="h-8 rounded border border-gray-800 cursor-default outline-none"
                      style={{ background: bg ?? undefined, boxShadow: on ? `0 0 0 2px ${p.ink}` : undefined }}
                      onMouseEnter={() => setHover({ d: di, k })} onFocus={() => setHover({ d: di, k })}
                      title={`${d} ${hh(k)}–${hh(k + 1)}: ${fmt.money(v, currency)} · ${o} orders`} />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 mt-2 text-[11px] text-gray-500">
        <span>Less</span>
        <span aria-hidden className="h-2.5 w-32 rounded" style={{ background: `linear-gradient(to right, ${p.ramp.slice(1).join(', ')})` }} />
        <span>More</span>
        <span className="ml-2">busiest hour {fmt.money(h.maxRevenue, currency, { decimals: 0 })}</span>
      </div>
    </div>
  );
}

export function HourColumns({ h, p, currency }: { h: HeatData; p: ChartPalette; currency: string }) {
  const data = byHour(h.revenue, h.orders, h.tradingHours);
  return (
    <div className="h-52" data-testid="analytics-by-hour">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={p.grid} />
          <XAxis dataKey="label" tick={axisTick(p)} tickLine={false} axisLine={{ stroke: p.axis }} tickFormatter={(v: string) => v.slice(0, 2)} minTickGap={4} />
          <YAxis tick={axisTick(p)} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => compact(v)} />
          <Tooltip cursor={{ fill: p.grid, fillOpacity: 0.5 }} content={(t: TipProps) => {
            const d = first<{ label: string; hour: number; revenue: number; orders: number }>(t);
            return d ? <TipBox title={`${d.label}–${hh(d.hour + 1)}, every day`} rows={[{ label: `${d.orders} orders`, value: fmt.money(d.revenue, currency, { decimals: 0 }), colour: p.accent }]} /> : null;
          }} />
          <Bar dataKey="revenue" fill={p.accent} radius={[4, 4, 0, 0]} maxBarSize={24} {...noAnim} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function WeekdayBars({ h, p, currency }: { h: HeatData; p: ChartPalette; currency: string }) {
  const data = byWeekday(h.revenue, h.orders);
  return (
    <div className="h-52" data-testid="analytics-by-weekday">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={5}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="day" width={36} tick={{ fill: p.inkSoft, fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: p.grid, fillOpacity: 0.5 }} content={(t: TipProps) => {
            const d = first<{ day: string; revenue: number; orders: number }>(t);
            return d ? <TipBox title={d.day} rows={[{ label: `${d.orders} orders`, value: fmt.money(d.revenue, currency, { decimals: 0 }), colour: p.accent }]} /> : null;
          }} />
          <Bar dataKey="revenue" fill={p.accent} radius={[0, 4, 4, 0]} maxBarSize={20} {...noAnim}>
            <LabelList dataKey="revenue" position="right" formatter={(v: unknown) => (Number(v) > 0 ? compact(Number(v)) : '')} style={{ fill: p.muted, fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Money leaks ───────────────────────────────────────────────────────────────

export interface LeakCashier { cashierId: string | null; name: string; voidValue: number; itemVoidValue: number; refundValue: number; discountValue: number; wastageValue: number | null; flags: unknown[] }

/** One stacked bar per cashier (the 12 with the most at stake); a flagged cashier's name carries a red flag mark. */
export function LeakStack({ cashiers, p, currency, wastageHidden }: { cashiers: LeakCashier[]; p: ChartPalette; currency: string; wastageHidden: boolean }) {
  const keys = LEAK_ORDER.filter((k) => !(wastageHidden && k === 'wastage'));
  const rows = cashiers.map((c) => ({ id: c.cashierId ?? 'none', name: c.name, flagged: c.flags.length > 0, ...leakParts(c) }))
    .map((r) => ({ ...r, total: leakTotal(r) })).filter((r) => r.total > 0)
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.total - a.total).slice(0, 12);
  if (!rows.length) return <p className="text-sm text-gray-500 py-6 text-center">No voids, refunds, discounts or wastage in this period.</p>;
  const flagged = new Set(rows.filter((r) => r.flagged).map((r) => r.name));
  const Tick = (t: { x?: number | string; y?: number | string; payload?: { value?: string } }) => {
    const name = String(t.payload?.value ?? '');
    const isFlagged = flagged.has(name);
    const short = name.length > 14 ? `${name.slice(0, 13)}…` : name;
    return (
      <g transform={`translate(${Number(t.x ?? 0)},${Number(t.y ?? 0)})`}>
        {isFlagged && <path d="M-104 -6 v12 M-104 -6 h7 l-2 3 l2 3 h-7" stroke={p.flagged} strokeWidth={1.6} fill="none" />}
        <text x={-4} y={4} textAnchor="end" fill={isFlagged ? p.ink : p.inkSoft} fontSize={12} fontWeight={isFlagged ? 700 : 400}>{short}</text>
      </g>
    );
  };
  return (
    <div style={{ height: rows.length * 32 + 16 }} data-testid="analytics-leak-stack">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="name" width={112} tick={Tick} tickLine={false} axisLine={false} interval={0} />
          <Tooltip cursor={{ fill: p.grid, fillOpacity: 0.5 }} content={(t: TipProps) => {
            const d = first<(typeof rows)[number]>(t);
            return d ? <TipBox title={`${d.name}${d.flagged ? ' · flagged' : ''}`} rows={[
              ...keys.map((k) => ({ label: LEAK_LABEL[k].toLowerCase(), value: fmt.money(d[k], currency, { decimals: 0 }), colour: p.leaks[k] })),
              { label: 'in all', value: fmt.money(d.total, currency, { decimals: 0 }) },
            ]} /> : null;
          }} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="leak" fill={p.leaks[k]} stroke={p.surface} strokeWidth={2} maxBarSize={22}
              radius={i === keys.length - 1 ? [0, 4, 4, 0] : 0} {...noAnim}>
              {i === keys.length - 1 && <LabelList dataKey="total" position="right" formatter={(v: unknown) => compact(Number(v))} style={{ fill: p.muted, fontSize: 11 }} />}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function leakLegend(p: ChartPalette, wastageHidden: boolean) {
  return LEAK_ORDER.filter((k: LeakKey) => !(wastageHidden && k === 'wastage')).map((k) => ({ label: LEAK_LABEL[k], colour: p.leaks[k] }));
}

// ── Credit ageing ─────────────────────────────────────────────────────────────

export interface Buckets { d0_30: number; d31_60: number; d61_90: number; d90_plus: number }

/** The four age buckets as one bar, green (new) to red (over 90 days), each labelled with its amount below. */
export function AgeingBar({ totals, p, currency }: { totals: Buckets; p: ChartPalette; currency: string }) {
  const all = BUCKET_ORDER.reduce((s, k) => s + (totals[k] || 0), 0);
  if (all <= 0) return <p className="text-sm text-gray-500">Nothing owed.</p>;
  return (
    <div data-testid="analytics-ageing-bar">
      <div className="flex h-7 w-full overflow-hidden rounded-md" style={{ gap: 2, background: p.surface }}>
        {BUCKET_ORDER.filter((k) => totals[k] > 0).map((k) => (
          <div key={k} title={`${BUCKET_LABEL[k]}: ${fmt.money(totals[k], currency)} (${((totals[k] / all) * 100).toFixed(0)}%)`}
            style={{ width: `${(totals[k] / all) * 100}%`, minWidth: 4, background: p.buckets[k] }} />
        ))}
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        {BUCKET_ORDER.map((k) => (
          <li key={k} className="flex items-start gap-2 min-w-0">
            <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-sm mt-1 flex-shrink-0" style={{ background: p.buckets[k] }} />
            <span className="min-w-0">
              <span className="block text-xs text-gray-500">{BUCKET_LABEL[k]}</span>
              <span className="block text-sm font-semibold text-white truncate">{fmt.money(totals[k], currency, { decimals: 0 })}</span>
              <span className="block text-[11px] text-gray-500">{((totals[k] / all) * 100).toFixed(0)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Debtor extends Buckets { customerId: string; name: string; owed: number }
/** The ten who owe the most, each bar split by age (the same green → red). */
export function TopDebtors({ customers, p, currency }: { customers: Debtor[]; p: ChartPalette; currency: string }) {
  const top = topBy(customers, (c) => c.owed, 10);
  if (!top.length) return <p className="text-sm text-gray-500">Nobody owes on credit.</p>;
  return (
    <div style={{ height: top.length * 30 + 16 }} data-testid="analytics-top-debtors">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={top} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="name" width={112} tick={{ fill: p.inkSoft, fontSize: 12 }} tickLine={false} axisLine={false} interval={0}
            tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
          <Tooltip cursor={{ fill: p.grid, fillOpacity: 0.5 }} content={(t: TipProps) => {
            const d = first<Debtor>(t);
            return d ? <TipBox title={d.name} rows={[
              ...BUCKET_ORDER.filter((k) => d[k] > 0).map((k) => ({ label: BUCKET_LABEL[k], value: fmt.money(d[k], currency, { decimals: 0 }), colour: p.buckets[k] })),
              { label: 'owed', value: fmt.money(d.owed, currency, { decimals: 0 }) },
            ]} /> : null;
          }} />
          {BUCKET_ORDER.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="age" fill={p.buckets[k]} stroke={p.surface} strokeWidth={2} maxBarSize={20}
              radius={i === BUCKET_ORDER.length - 1 ? [0, 4, 4, 0] : 0} {...noAnim}>
              {i === BUCKET_ORDER.length - 1 && <LabelList dataKey="owed" position="right" formatter={(v: unknown) => compact(Number(v))} style={{ fill: p.muted, fontSize: 11 }} />}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
