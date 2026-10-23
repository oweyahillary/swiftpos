/**
 * areas.tsx — A561: the Analytics page's "Dig into the details" tiles and the three new areas.
 *
 * The owner, on A558's tab row (2026-10-22): "this menu here its hidden it looks like all item in the page". The tabs are
 * now TILES — an icon, the name, ONE live figure as the hook ("4 stars · 2 dogs", "2 items run out this week") and an
 * amber "To do" badge when a "Do this next" card or a warning points there — in a role=tablist (arrow keys, Home / End,
 * a visible focus ring). The open tile is teal-bordered and raised. Desktop: four across, wrapping; a phone: one row that
 * scrolls sideways with the next tile partly in view and a fade at the edge. While the owner scrolls inside an area a
 * compact copy of the bar sticks to the top (the one sticky element; below the dashboard's phone header) to switch
 * without scrolling back.
 *
 * The areas: Stock ("How fast your stock goes"), Customers ("Who comes back") and Costs ("What each sale really earns",
 * with "Set these costs to see your real margins" at the top when items have no cost). Every table is the top 10 and
 * says so; no text here ever suggests a price rise (A560).
 * A565: Branches (the owner or a partner of every branch, two or more branches) — the branches side by side (a report:
 * numbers) and the stock moves to consider (recommendations in words: no quantity, no KES — the owner decides how much).
 * A575: each business type's words (lib/analyticsTerms.ts analyticsWords) — a shop's tile reads "Product performance" and
 * its Costs area "Cost of sales", "items you sell"; a restaurant or café keeps "Menu engineering" and "Food cost".
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import * as fmt from '../../lib/format';
import { DESK } from '../../components/RowMore';
import { ORDER_TYPE_LABEL, type ChartPalette, type OrderTypeKey } from './chartPalette';
import { capRows, changeCell, daysLeftWords, nextArea, type AreaHook, type AreaKey } from './chartMath';
import { ChartCard, Legend, OrderMixBars, AvgBillLine, type MixBucket } from './charts';
import { analyticsWords, type AnalyticsWords } from '../../lib/analyticsTerms';

const TOP = 10;
const pc = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

// ── The tiles ─────────────────────────────────────────────────────────────────

export const AREA_META: Record<AreaKey, { label: string; icon: string }> = {
  menu: { label: 'Menu engineering', icon: 'M4 6h16M4 12h16M4 18h10' },
  heatmap: { label: 'Busy times', icon: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
  leaks: { label: 'Money leaks', icon: 'M12 3c3 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 3-6.5 6-11Z' },
  credit: { label: 'Credit ageing', icon: 'M3 6h18v12H3zM3 10h18M7 15h4' },
  stock: { label: 'Stock', icon: 'M3 7.5 12 3l9 4.5-9 4.5-9-4.5ZM3 7.5v9L12 21l9-4.5v-9M12 12v9' },
  branches: { label: 'Branches', icon: 'M3 21h18M5 21V8l5-3v16M14 21V11l5-2v12' },
  customers: { label: 'Customers', icon: 'M16 20v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM21 20v-1a3 3 0 0 0-2.5-3M16.5 5.2a3 3 0 0 1 0 5.6' },
  costs: { label: 'Costs', icon: 'M16.5 7.5H10a2.75 2.75 0 0 0 0 5.5h4a2.75 2.75 0 0 1 0 5.5H7M12 4v3.5M12 18.5V20' },
};

function AreaIcon({ d, active }: { d: string; active: boolean }) {
  return (
    <span aria-hidden className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? 'bg-swift-strong text-white' : 'bg-gray-800 text-gray-300'}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
    </span>
  );
}

/**
 * The "Dig into the details" tiles. `areas` is the order shown (visibleAreas), `hooks` the cloud's figure per area (none
 * yet: the tile shows its name only). A compact copy sticks while the owner scrolls inside the open area (`children`).
 */
export function AreaTiles({ areas, hooks, active, onPick, stickyTop, children, labels }: {
  areas: AreaKey[]; hooks: Partial<Record<AreaKey, AreaHook>> | null; active: AreaKey; onPick: (a: AreaKey) => void;
  /** A575: a tile's name in the business type's words ("Product performance" at a shop) */
  labels?: Partial<Record<AreaKey, string>>;
  /** the sticky bar's top: below the dashboard's own sticky header on a phone */
  stickyTop: string; children: ReactNode;
}) {
  const refs = useRef<Partial<Record<AreaKey, HTMLButtonElement | null>>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [gridOut, setGridOut] = useState(false);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // shown only once the tiles have scrolled up out of view (not while they are still below it)
    const io = new IntersectionObserver(([e]) => setGridOut(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0)), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  function key(e: KeyboardEvent<HTMLButtonElement>) {
    const to = nextArea(areas, active, e.key);
    if (to === active) return;
    e.preventDefault();
    onPick(to);
    refs.current[to]?.focus();
  }
  function quick(a: AreaKey) {
    onPick(a);
    contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-white">Dig into the details</h2>
        <p className="text-sm text-gray-400">Pick an area — each one ends in what to do.</p>
      </div>
      <div className="relative print:hidden">
        <div ref={gridRef} role="tablist" aria-label="Analytics areas" data-testid="analytics-tiles"
          className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:overflow-visible">
          {areas.map((a) => {
            const on = a === active;
            const h = hooks?.[a];
            return (
              <button key={a} ref={(el) => { refs.current[a] = el; }} role="tab" id={`area-tab-${a}`} aria-selected={on} aria-controls="area-panel"
                tabIndex={on ? 0 : -1} onClick={() => onPick(a)} onKeyDown={key} data-area={a} data-active={on ? 'true' : undefined}
                className={`snap-start flex-shrink-0 w-[44%] min-[480px]:w-[31%] sm:w-auto text-left rounded-xl border p-3 flex flex-col gap-2 transition
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-swift focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950
                  ${on ? 'border-swift bg-gray-800 shadow-lg shadow-black/30 -translate-y-0.5' : 'border-gray-800 bg-gray-900 hover:border-gray-600 hover:bg-gray-800/50'}`}>
                <span className="flex items-start justify-between gap-2 w-full">
                  <AreaIcon d={AREA_META[a].icon} active={on} />
                  {h?.alert && <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400" data-testid="area-alert">To do</span>}
                </span>
                <span className={`text-sm font-semibold leading-tight ${on ? 'text-white' : 'text-gray-200'}`}>{labels?.[a] ?? AREA_META[a].label}</span>
                <span className="text-xs text-gray-400 leading-snug min-h-[2rem]" data-testid="area-hook">{h?.text ?? ' '}</span>
              </button>
            );
          })}
        </div>
        {/* a phone: the row scrolls — a fade at the edge says there is more */}
        <div aria-hidden className="sm:hidden pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-gray-950 to-transparent" />
      </div>

      <div ref={contentRef} className="scroll-mt-16 space-y-3">
        {/* the one sticky element: a compact copy of the tiles while scrolling inside the open area */}
        <div className={`sticky ${stickyTop} z-10 -mx-1 px-1 py-2 bg-gray-950 border-b border-gray-800 print:hidden ${gridOut ? '' : 'hidden'}`}
          data-testid="analytics-tiles-compact">
          <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="Switch area">
            {areas.map((a) => (
              <button key={a} onClick={() => quick(a)} aria-pressed={a === active}
                className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap border focus:outline-none focus-visible:ring-2 focus-visible:ring-swift
                  ${a === active ? 'border-swift bg-swift-strong text-white' : 'border-gray-700 text-gray-300 hover:text-white'}`}>
                {labels?.[a] ?? AREA_META[a].label}{hooks?.[a]?.alert ? ' •' : ''}
              </button>
            ))}
          </div>
        </div>
        <div id="area-panel" role="tabpanel" aria-labelledby={`area-tab-${active}`} className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function CapNote({ shown, total, by }: { shown: number; total: number; by: string }) {
  if (total <= shown) return null;
  return <p className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-800" data-testid="analytics-cap">Showing the top {shown} of {total}, {by}.</p>;
}
function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 min-w-0" data-testid={testId}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xl font-semibold text-white mt-0.5 tabular-nums truncate">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}
function Table({ title, sub, testId, children }: { title: string; sub?: string; testId?: string; children: ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden min-w-0" data-testid={testId}>
      <div className="px-3 pt-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {sub && <p className="text-xs text-gray-500">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
const th = 'p-2 font-medium';

// ── Stock ─────────────────────────────────────────────────────────────────────

export interface StockItem {
  kind: 'product' | 'ingredient'; id: string | null; name: string; unit: string | null; used: number; sold: number; wasted: number;
  prevUsed: number; change: number | null; perDay: number; onHand: number | null; daysLeft: number | null; wasteShare: number | null;
}
export interface StockAnswer {
  days: number; items: StockItem[]; runOut: StockItem[]; runOutTotal: number; wasted: StockItem[]; wastedTotal: number;
  onHandKnown: boolean; note: string | null; covers: string;
}
const unit = (x: StockItem) => (x.unit ? ` ${x.unit}` : '');
const daysTone = (d: number | null) => (d === null ? 'text-gray-500' : d < 3 ? 'text-red-400 font-semibold' : d < 7 ? 'text-amber-400 font-semibold' : 'text-gray-300');

export function StockSection({ s }: { s: StockAnswer }) {
  if (!s.items.length) return <p className="text-sm text-gray-500">Nothing that tracks stock was used in this period. Turn on stock tracking for an item, or give it a recipe, to see how fast it goes.</p>;
  const most = capRows(s.items, TOP);
  return (
    <div className="space-y-4" data-testid="analytics-stock">
      {s.note && <p className="text-sm text-amber-400" data-testid="analytics-stock-branch-note">{s.note}</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {s.onHandKnown ? (
          <Table title="What runs out soonest" sub="At your current rate — order the red ones now" testId="analytics-run-out">
            {s.runOut.length === 0 ? <p className="p-3 text-sm text-gray-500">No item with a stock level was used in this period.</p> : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                  <th className={th}>Item</th><th className={`${th} text-right`}>Left</th><th className={`${th} text-right ${DESK}`}>Used a day</th>
                  <th className={`${th} text-right`}>Lasts</th><th className={`${th} text-right ${DESK}`}>Use vs before</th>
                </tr></thead>
                <tbody>
                  {s.runOut.map((x) => (
                    <tr key={`${x.kind}-${x.id ?? x.name}`} className="border-b border-gray-800 last:border-0">
                      <td className="p-2 text-white">{x.name}{x.kind === 'ingredient' && <span className="block text-[11px] text-gray-500">Ingredient</span>}</td>
                      <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.qty(x.onHand ?? 0, 1)}{unit(x)}</td>
                      <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{fmt.qty(x.perDay, 1)}</td>
                      <td className={`p-2 text-right whitespace-nowrap ${daysTone(x.daysLeft)}`}>{daysLeftWords(x.daysLeft)}</td>
                      <td className={`p-2 text-right text-gray-400 ${DESK}`}>{changeCell(x.change, x.prevUsed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
            <CapNote shown={s.runOut.length} total={s.runOutTotal} by="the soonest out first" />
          </Table>
        ) : (
          <Table title="What you use most" sub="Days left needs one branch — pick one above" testId="analytics-used-most">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                <th className={th}>Item</th><th className={`${th} text-right`}>Used</th><th className={`${th} text-right`}>A day</th><th className={`${th} text-right ${DESK}`}>Use vs before</th>
              </tr></thead>
              <tbody>
                {most.rows.map((x) => (
                  <tr key={`${x.kind}-${x.id ?? x.name}`} className="border-b border-gray-800 last:border-0">
                    <td className="p-2 text-white">{x.name}</td>
                    <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.qty(x.used, 1)}{unit(x)}</td>
                    <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.qty(x.perDay, 1)}</td>
                    <td className={`p-2 text-right text-gray-400 ${DESK}`}>{changeCell(x.change, x.prevUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <CapNote shown={most.rows.length} total={most.total} by="by what was used" />
          </Table>
        )}
        <Table title="What you throw away most" sub="Order less at a time, or check how these are stored" testId="analytics-wasted">
          {s.wasted.length === 0 ? <p className="p-3 text-sm text-gray-500">No wastage was written off in this period.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                <th className={th}>Item</th><th className={`${th} text-right ${DESK}`}>Used</th><th className={`${th} text-right`}>Thrown away</th><th className={`${th} text-right`}>Share</th>
              </tr></thead>
              <tbody>
                {s.wasted.map((x) => (
                  <tr key={`${x.kind}-${x.id ?? x.name}`} className="border-b border-gray-800 last:border-0">
                    <td className="p-2 text-white">{x.name}</td>
                    <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{fmt.qty(x.used, 1)}{unit(x)}</td>
                    <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.qty(x.wasted, 1)}</td>
                    <td className={`p-2 text-right ${(x.wasteShare ?? 0) >= 0.15 ? 'text-amber-400 font-semibold' : 'text-gray-300'}`}>{pc(x.wasteShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <CapNote shown={s.wasted.length} total={s.wastedTotal} by="by the share thrown away" />
        </Table>
      </div>
      <p className="text-xs text-gray-500">Used = sold plus thrown away, in the unit the stock is kept in; a day = over the {s.days} days of the period. {s.covers}</p>
    </div>
  );
}

// ── Customers ─────────────────────────────────────────────────────────────────

export interface CustomerLine { customerId: string; name: string; phone: string | null; visits: number; spend: number; lastVisit: string | null; visits90: number; gap: number | null; daysSince: number | null }
export interface CustomersAnswer {
  customersHidden: boolean;
  now: { orders: number; customers: number; newCustomers: number; returning: number };
  prev: { customers: number; newCustomers: number; returning: number };
  change: { customers: number | null; newCustomers: number | null; returning: number | null };
  coverage: { share: number | null; low: boolean; note: string | null };
  top: CustomerLine[]; totalCustomers: number; frequency: { regulars: number; medianGap: number | null };
  lapsed: CustomerLine[]; avgBill: { customer: number | null; walkIn: number | null };
  mix: MixBucket[]; byWeek: boolean; mixTotals: { key: OrderTypeKey; label: string; orders: number; share: number }[];
}
const vsBefore = (now: number, prev: number, change: number | null) =>
  change === null ? (prev === 0 && now > 0 ? 'none in the period before' : 'no earlier figure') : `${changeCell(change, prev)} on the period before (${fmt.num(prev)})`;

export function CustomersSection({ c, p, currency }: { c: CustomersAnswer; p: ChartPalette; currency: string }) {
  const m0 = (n: number | null) => fmt.money(n, currency, { decimals: 0, blank: '—' });
  const lapsed = capRows(c.lapsed, TOP);
  return (
    <div className="space-y-4" data-testid="analytics-customers">
      {c.customersHidden ? (
        <p className="text-sm text-gray-400">Customer names are hidden for your role — you see how orders came in and the average bill.</p>
      ) : (
        <>
          {c.coverage.note && <p className="text-sm text-amber-400" data-testid="analytics-coverage-note">{c.coverage.note}</p>}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Stat label="Customers who came" value={fmt.num(c.now.customers)} sub={vsBefore(c.now.customers, c.prev.customers, c.change.customers)} />
            <Stat label="New this period" value={fmt.num(c.now.newCustomers)} sub="Their first visit ever" />
            <Stat label="Came back" value={fmt.num(c.now.returning)} sub={vsBefore(c.now.returning, c.prev.returning, c.change.returning)} />
            <Stat label="Average bill" value={m0(c.avgBill.customer)} sub={`With a customer · walk-ins ${m0(c.avgBill.walkIn)}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Table title="Regulars gone quiet — call or message them" sub={c.frequency.regulars ? `${c.frequency.regulars} regular${c.frequency.regulars === 1 ? '' : 's'}; the middle one comes about every ${Math.round(c.frequency.medianGap ?? 0)} days` : 'Nobody comes often enough to be a regular yet'} testId="analytics-lapsed">
              {lapsed.rows.length === 0 ? <p className="p-3 text-sm text-gray-500">Every regular has been back on time.</p> : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                    <th className={th}>Customer</th><th className={`${th} text-right`}>Usually every</th><th className={`${th} text-right`}>Last came</th><th className={`${th} text-right ${DESK}`}>Visits in 90 days</th>
                  </tr></thead>
                  <tbody>
                    {lapsed.rows.map((x) => (
                      <tr key={x.customerId} className="border-b border-gray-800 last:border-0">
                        <td className="p-2 text-white">{x.name}{x.phone && <span className="block text-[11px] text-gray-500">{x.phone}</span>}</td>
                        <td className="p-2 text-right text-gray-300">{Math.round(x.gap ?? 0)} days</td>
                        <td className="p-2 text-right text-amber-400 font-semibold whitespace-nowrap">{x.daysSince} days ago</td>
                        <td className={`p-2 text-right text-gray-300 ${DESK}`}>{x.visits90}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              <CapNote shown={lapsed.rows.length} total={lapsed.total} by="the most regular first" />
            </Table>
            <Table title="Your best customers" sub="Thank them — they keep you going" testId="analytics-top-customers">
              {c.top.length === 0 ? <p className="p-3 text-sm text-gray-500">No sale in this period was linked to a customer.</p> : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                    <th className={th}>Customer</th><th className={`${th} text-right`}>Visits</th><th className={`${th} text-right`}>Spent</th><th className={`${th} text-right ${DESK}`}>Last visit</th>
                  </tr></thead>
                  <tbody>
                    {c.top.map((x) => (
                      <tr key={x.customerId} className="border-b border-gray-800 last:border-0">
                        <td className="p-2 text-white">{x.name}</td>
                        <td className="p-2 text-right text-gray-300">{x.visits}</td>
                        <td className="p-2 text-right text-gray-300 tabular-nums">{m0(x.spend)}</td>
                        <td className={`p-2 text-right text-gray-400 whitespace-nowrap ${DESK}`}>{x.lastVisit ? fmt.dateShort(`${x.lastVisit}T12:00:00`) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              <CapNote shown={c.top.length} total={c.totalCustomers} by="by what they spent" />
            </Table>
          </div>
        </>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="How orders came in" sub={`Orders ${c.byWeek ? 'each week' : 'each day'} by type`} testId="analytics-order-mix-card"
          legend={<Legend items={c.mixTotals.map((t) => ({ label: t.label, colour: p.orderTypes[t.key], value: pc(t.share) }))} />}>
          {c.mixTotals.length ? <OrderMixBars mix={c.mix} p={p} /> : <p className="text-sm text-gray-500 py-6 text-center">No orders in this period.</p>}
          {c.mixTotals.length > 0 && (
            <ul className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1 text-xs">
              {c.mixTotals.map((t) => <li key={t.key} className="text-gray-400">{ORDER_TYPE_LABEL[t.key]} <span className="text-white font-semibold tabular-nums">{fmt.num(t.orders)}</span></li>)}
            </ul>
          )}
        </ChartCard>
        <ChartCard title="Average bill" sub={`What one order brings in, ${c.byWeek ? 'week by week' : 'day by day'}`} testId="analytics-avg-bill-card">
          {c.mixTotals.length ? <AvgBillLine mix={c.mix} p={p} currency={currency} /> : <p className="text-sm text-gray-500 py-6 text-center">No orders in this period.</p>}
        </ChartCard>
      </div>
      {!c.customersHidden && <p className="text-xs text-gray-500">A visit = a day a customer bought; new = their first visit ever. A regular comes at least 4 times in 90 days, about every two weeks or more often; gone quiet = no visit for twice their usual gap and at least two weeks.</p>}
    </div>
  );
}

// ── Costs ─────────────────────────────────────────────────────────────────────

export interface CostsAnswer {
  days: number;
  foodCost: { now: number | null; prev: number | null; change: number | null; costedShare: number | null; movers: { name: string; now: number; prev: number }[] };
  thin: { productId: string | null; name: string; qty: number; avgPrice: number; unitCost: number; unitMargin: number; marginPct: number; topIngredient: string | null }[];
  thinTotal: number;
  rises: { ingredientId: string | null; name: string; unit: string | null; from: number; to: number; change: number; usedIn: number; products: { name: string }[]; extraMonth: number }[];
  risesTotal: number; historyNote: string;
  noCost: { items: { productId: string | null; name: string; category: string | null; qty: number; revenue: number }[]; total: number; revenue: number; share: number | null; unsold: number; unsoldNames: string[] };
}
const SET_COSTS = '/dashboard/products?costs=1';
const fine = (n: number, currency: string) => fmt.money(n, currency, { decimals: Math.abs(n) < 100 && Math.round(n * 100) % 100 !== 0 ? 2 : 0 });

/** "Set these costs to see your real margins" — every item sold with no cost, the most sold first (owner: links to set it). */
function NoCostList({ n, ownerView, currency, w }: { n: CostsAnswer['noCost']; ownerView: boolean; currency: string; w: AnalyticsWords }) {
  const more = n.total - n.items.length;
  return (
    <section className="bg-gray-900 border border-amber-500/40 rounded-xl overflow-hidden" aria-label="Items without a cost" data-testid="analytics-no-cost">
      <div className="px-3 pt-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">Set these costs to see your real margins</h3>
          <p className="text-sm text-gray-300">
            {pc(n.share)} of your sales have no cost set, so margins are partly blind.
          </p>
        </div>
        {ownerView
          ? <Link to={SET_COSTS} className="px-3 py-1.5 rounded-lg text-sm bg-swift-strong hover:bg-swift-deep text-white whitespace-nowrap print:hidden" data-testid="analytics-set-costs">Set costs</Link>
          : <p className="text-xs text-gray-500">Ask the owner to set them on the Products page.</p>}
      </div>
      <div className="overflow-x-auto mt-2"><table className="w-full text-sm">
        <thead><tr className="text-gray-500 text-left text-xs border-y border-gray-800">
          <th className={th}>Item</th><th className={`${th} ${DESK}`}>Category</th><th className={`${th} text-right`}>Sold</th><th className={`${th} text-right`}>Sales</th>
          {ownerView && <th className={`${th} print:hidden`}><span className="sr-only">Set its cost</span></th>}
        </tr></thead>
        <tbody>
          {n.items.map((x) => (
            <tr key={x.productId ?? x.name} className="border-b border-gray-800 last:border-0">
              <td className="p-2 text-white">{x.name}</td>
              <td className={`p-2 text-gray-400 ${DESK}`}>{x.category ?? '—'}</td>
              <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.qty(x.qty)}</td>
              <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.money(x.revenue, currency, { decimals: 0 })}</td>
              {ownerView && <td className="p-2 text-right print:hidden"><Link to={`/dashboard/products?q=${encodeURIComponent(x.name)}`} className="text-xs text-swift-text hover:underline whitespace-nowrap">Set cost</Link></td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-800" data-testid="analytics-no-cost-more">
        {more > 0 ? `Showing the top ${n.items.length} of ${n.total}, by sales — and ${more} more. ` : ''}
        {n.unsold > 0 ? `Plus ${n.unsold} item${n.unsold === 1 ? '' : 's'} ${w.onYourList} with no cost that did not sell this period.` : ''}
        {' '}{w.costOfSales === 'Food cost' ? "A cost is the item's own cost, its recipe (ingredients with a cost) or, for a combo, its items." : "A cost is the item's own cost price or, for a combo, its items'."}
      </p>
    </section>
  );
}

export function CostsSection({ c, ownerView, currency, words }: { c: CostsAnswer; ownerView: boolean; currency: string; words?: AnalyticsWords }) {
  const f = c.foodCost;
  const w = words ?? analyticsWords(null);   // A575: a shop's "Cost of sales"; a restaurant's "Food cost"
  const what = w.costOfSales === 'Food cost' ? 'what the food costs' : 'what the goods cost';
  const pts = f.change === null ? null : Math.round(f.change * 1000) / 10;
  return (
    <div className="space-y-4" data-testid="analytics-costs">
      {c.noCost.total > 0 && <NoCostList n={c.noCost} ownerView={ownerView} currency={currency} w={w} />}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat label={w.costOfSales} value={pc(f.now)} testId="analytics-food-cost"
          sub={pts === null ? `Of every ${currency} 100 these items sell for, ${what}` : pts === 0 ? `The same as the period before (${pc(f.prev)})`
            : `${pts > 0 ? 'Up' : 'Down'} ${Math.abs(pts)} ${Math.abs(pts) === 1 ? 'point' : 'points'} from ${pc(f.prev)} the period before`} />
        <Stat label="Sales with a cost set" value={pc(f.costedShare)} sub={`${w.costOfSales} covers these; set the rest below`} />
        <Stat label="Biggest movers" value={f.movers.length ? f.movers[0].name : 'None'} sub={f.movers.length > 1 ? `Then ${f.movers.slice(1).map((x) => x.name).join(', ')} — a bigger share of ${w.costBill} than before`
          : f.movers.length ? `A bigger share of ${w.costBill} than before` : `No item takes a bigger share of ${w.costBill} than before`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Table title="The thinnest margins" sub={w.thinCheck} testId="analytics-thin">
          {c.thin.length === 0 ? <p className="p-3 text-sm text-gray-500">No item with a cost sold 5 or more.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                <th className={th}>Item</th><th className={`${th} text-right ${DESK}`}>Sold</th><th className={`${th} text-right ${DESK}`}>Sells for</th>
                <th className={`${th} text-right`}>Cost</th><th className={`${th} text-right`}>Earns</th><th className={`${th} ${DESK}`}>Costs most</th>
              </tr></thead>
              <tbody>
                {c.thin.map((x) => (
                  <tr key={x.productId ?? x.name} className="border-b border-gray-800 last:border-0">
                    <td className="p-2 text-white">{x.name}</td>
                    <td className={`p-2 text-right text-gray-300 ${DESK}`}>{fmt.qty(x.qty)}</td>
                    <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{fmt.money(x.avgPrice, currency, { decimals: 0 })}</td>
                    <td className="p-2 text-right text-gray-300 tabular-nums">{fmt.money(x.unitCost, currency, { decimals: 0 })}</td>
                    <td className={`p-2 text-right font-semibold ${x.marginPct < 0.2 ? 'text-red-400' : 'text-gray-200'}`}>{pc(Math.max(0, x.marginPct))}</td>
                    <td className={`p-2 text-gray-400 ${DESK}`}>{x.topIngredient ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <CapNote shown={c.thin.length} total={c.thinTotal} by="the thinnest margin first" />
        </Table>
        <Table title="Costs that went up" sub="Compare suppliers for these" testId="analytics-rises">
          {c.rises.length === 0 ? <p className="p-3 text-sm text-gray-500">{w.costOfSales === 'Food cost' ? 'No ingredient cost went up in this period.' : 'No cost went up in this period (costs are followed for ingredients only).'}</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                <th className={th}>Ingredient</th><th className={`${th} text-right`}>From → to</th><th className={`${th} text-right`}>Up</th><th className={`${th} text-right ${DESK}`}>Extra a month</th>
              </tr></thead>
              <tbody>
                {c.rises.map((x) => (
                  <tr key={x.ingredientId ?? x.name} className="border-b border-gray-800 last:border-0">
                    <td className="p-2 text-white">{x.name}{x.products.length > 0 && <span className="block text-[11px] text-gray-500">{x.products.slice(0, 3).map((q) => q.name).join(', ')}{x.products.length > 3 ? ` +${x.products.length - 3}` : ''}</span>}</td>
                    <td className="p-2 text-right text-gray-300 whitespace-nowrap tabular-nums">{fine(x.from, currency)} → {fine(x.to, currency)}{x.unit ? <span className="text-gray-500"> /{x.unit}</span> : null}</td>
                    <td className="p-2 text-right text-amber-400 font-semibold">{pc(x.change)}</td>
                    <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{x.extraMonth > 0 ? `≈ ${fmt.money(x.extraMonth, currency, { decimals: 0 })}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <CapNote shown={c.rises.length} total={c.risesTotal} by="the biggest rise first" />
        </Table>
      </div>
      <p className="text-xs text-gray-500">{w.costOfSales} = the cost of what was sold ÷ what it sold for, over the items with a cost; both periods at today's costs. {c.historyNote}</p>
    </div>
  );
}

/** The call-out under the summary: 5% or more of the period's sales have no cost (costs only). */
export function NoCostBanner({ share, items, onOpen }: { share: number; items: number; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10" data-testid="analytics-no-cost-banner">
      <p className="text-sm text-gray-200">
        <span className="font-semibold text-white">{items} item{items === 1 ? ' has' : 's have'} no cost</span> — {pc(share)} of your sales, so your margins are partly blind.
      </p>
      <button onClick={onOpen} className="text-sm font-semibold text-swift-text hover:underline print:hidden">See which and set them →</button>
    </div>
  );
}

// ── Branches (A565) ───────────────────────────────────────────────────────────

export interface BranchRow {
  id: string; name: string; sales: number; prevSales: number; change: number | null; orders: number; tradingDays: number;
  perDay: number | null; avgBill: number | null; margin: number | null; share: number | null; flagged: boolean; reason: string | null; slowOut: number;
}
export interface MoveLine { fromId: string; from: string; toId: string; to: string; items: { kind: 'product' | 'ingredient'; itemId: string; name: string }[] }
export interface MoveSuggestion { id: string; move: MoveLine; title: string; why: string }
export interface BranchesAnswer {
  available: boolean; branchCount: number; limited: boolean; note: string | null;
  compare: { days: number; rows: BranchRow[]; total: number; underperforming: BranchRow[]; basis: string; marginHidden: boolean } | null;
  moves: MoveSuggestion[] | null; movesTotal: number; movesNote: string | null;
}
/**
 * The transfer page with the items and the two branches filled in and the quantity LEFT BLANK (the owner's call). Products
 * only — an ingredient moves through the stock pages.
 */
export function transferLink(m: MoveLine): string {
  const q = new URLSearchParams({ from: m.fromId, to: m.toId });
  const products = m.items.filter((x) => x.kind === 'product').map((x) => x.itemId);
  if (products.length) q.set('products', products.join(','));
  return `/dashboard/stock/transfers?${q.toString()}`;
}

export function BranchesSection({ b, currency, ownerView, inView, onBranchTimes }: {
  b: BranchesAnswer; currency: string; ownerView: boolean; inView: string | null; onBranchTimes: (branchId: string) => void;
}) {
  if (!b.available || !b.compare) return <p className="text-sm text-gray-500">{b.note ?? 'Comparing branches needs two or more active branches.'}</p>;
  const c = b.compare;
  const m0 = (n: number | null) => fmt.money(n, currency, { decimals: 0, blank: '—' });
  const moves = b.moves ?? [];
  return (
    <div className="space-y-4" data-testid="analytics-branches">
      {c.underperforming.map((u) => (
        <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10" data-testid="analytics-branch-flag">
          <p className="text-sm text-gray-200"><span className="font-semibold text-white">{u.name}</span> — {u.reason}</p>
          {ownerView && <button onClick={() => onBranchTimes(u.id)} className="text-sm font-semibold text-swift-text hover:underline print:hidden">What sells when at {u.name} →</button>}
        </div>
      ))}
      <div className="grid gap-4 xl:grid-cols-2">
        <Table title="Your branches side by side" sub={`This period against each branch's own previous ${c.days} days`} testId="analytics-branch-table">
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
              <th className={th}>Branch</th><th className={`${th} text-right`}>Sales</th><th className={`${th} text-right`}>vs before</th>
              <th className={`${th} text-right ${DESK}`}>A day</th><th className={`${th} text-right ${DESK}`}>Average bill</th>
              {!c.marginHidden && <th className={`${th} text-right ${DESK}`}>Margin</th>}
            </tr></thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.id} className={`border-b border-gray-800 last:border-0 ${r.id === inView ? 'bg-gray-800/50' : ''}`} data-branch={r.name} data-flagged={r.flagged ? 'true' : undefined}>
                  <td className="p-2 text-white">{r.name}{r.flagged && <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400">Falling</span>}
                    {r.share !== null && <span className="block text-[11px] text-gray-500">{pc(r.share)} of all sales</span>}</td>
                  <td className="p-2 text-right text-gray-300 tabular-nums">{m0(r.sales)}</td>
                  <td className={`p-2 text-right whitespace-nowrap ${r.flagged ? 'text-amber-400 font-semibold' : 'text-gray-400'}`}>{changeCell(r.change, r.prevSales)}</td>
                  <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{m0(r.perDay)}</td>
                  <td className={`p-2 text-right text-gray-300 tabular-nums ${DESK}`}>{m0(r.avgBill)}</td>
                  {!c.marginHidden && <td className={`p-2 text-right text-gray-300 ${DESK}`}>{pc(r.margin)}</td>}
                </tr>
              ))}
            </tbody>
          </table></div>
          <CapNote shown={c.rows.length} total={c.total} by="by sales" />
        </Table>
        <Table title="Stock to move between branches" sub="Where stock sits at one branch and runs low at another — how much to move is your call" testId="analytics-moves">
          {b.movesNote ? <p className="p-3 text-sm text-gray-500">{b.movesNote}</p>
            : moves.length === 0 ? <p className="p-3 text-sm text-gray-500">Nothing to move — no item runs low at one branch while another holds plenty.</p> : (
            <ul className="divide-y divide-gray-800">
              {moves.map((x) => (
                <li key={x.id} className="p-3 flex flex-col gap-1 min-w-0" data-testid="analytics-move">
                  <p className="text-xs text-gray-400"><span className="text-white font-semibold">{x.move.items.map((i) => i.name).join(', ')}</span> · {x.move.from} → {x.move.to}</p>
                  <p className="text-sm text-gray-300 leading-snug">{x.why}</p>
                  {ownerView && x.move.items.some((i) => i.kind === 'product') && (
                    <Link to={transferLink(x.move)} className="self-start text-xs text-swift-text hover:underline print:hidden" data-testid="analytics-move-transfer">Start a transfer →</Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <CapNote shown={moves.length} total={b.movesTotal} by="the most urgent first" />
        </Table>
      </div>
      <p className="text-xs text-gray-500">
        A day = sales ÷ the days the branch traded. {c.basis} Stock moves compare each branch's own sales with what it holds now; no quantity is suggested — you or your manager decide how much.
        {b.limited ? ` Showing your first ${c.rows.length} branches by name.` : ''}
      </p>
    </div>
  );
}
