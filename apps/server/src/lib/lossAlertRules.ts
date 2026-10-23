/**
 * lossAlertRules.ts — A576: loss-prevention alerts. Every rule, pure (no database, no clock): the owner's settings, the
 * detectors over plain rows, the ranking and the cap, the plain words, who is told, and when a notification goes.
 *
 * Owner, 2026-10-23: voids and discounts are a WARNING ONLY, for investigation — never an accusation, never "KES to
 * recover"; decisions in plain words; at most 10; alerts go to the owner and managers, never to the cashier's screen. And
 * "let us not forget other business in the tills … based on how they operate": each detector says which kinds of business
 * it fits, and the words follow the business type (lib/businessTerms.ts).
 *
 * What the data records, and so what is detected (per branch and per staff member, over a day and over the last 7 days):
 *   paid_voids          orders voided after a payment was taken (payments row 'completed', amount > 0)
 *   many_voids          one person's voids against the others who worked at that branch in the same period
 *   many_refunds        one person's refunds against the others
 *   big_discounts       manual discounts at or above a percentage of the bill or an amount
 *   frequent_discounts  one person's manual discounts against the others
 *   free_sales          a bill brought to nothing by a manual discount (a comp at a restaurant or café)
 *   cash_short          a drawer counted short or over beyond a tolerance at the manager's confirm; a person short again and
 *                       again over 7 days; a branch's day closed short or over (the till's day close)
 *   price_below_list    a till's sale priced below the price list (order_price_variances, migration 133)
 *   kitchen_removed     items taken off an order after they went to the kitchen (kitchen_voids) — restaurants and cafés
 *   parking_no_charge   parked vehicles let out with the session voided, no charge (parking_sessions) — car parks
 *
 * What is NOT recorded, so not detected (listed for the owner in LOSS_NEEDS_DATA): a drawer opened with no sale, sales
 * outside opening hours (no opening hours are stored), a refund without its original sale (every refund is recorded ON
 * its sale), a void after the receipt printed (receipt prints are not recorded), a line removed from a retail basket
 * before payment, a table closed unpaid, fuel sold against the pump meters (no meter readings), who let a car out of
 * the park.
 */
import { businessTypeOf, isFoodService, type BusinessTypeKey } from './businessTerms';

// ── kinds and settings ───────────────────────────────────────────────────────

export const LOSS_KINDS = [
  'paid_voids', 'many_voids', 'many_refunds', 'big_discounts', 'frequent_discounts', 'free_sales',
  'cash_short', 'price_below_list', 'kitchen_removed', 'parking_no_charge',
] as const;
export type LossKind = (typeof LOSS_KINDS)[number];

/** At most this many alerts on the watch list, in the daily email, and new notifications per run. */
export const LOSS_TOP = 10;
/** The rolling period, in business days (today included). */
export const LOSS_WEEK_DAYS = 7;
/** A shortage counts toward "short again and again" from this amount (smaller is rounding and coins). */
export const SMALL_SHORT = 100;

export interface LossSettings {
  enabled: boolean;
  kinds: Record<LossKind, boolean>;
  /** Voids after payment by one person in a day. */
  paid_void_count: number;
  /** Voids by one person in a day (and above the others). */
  void_count: number;
  /** Refunds by one person in a day (and above the others). */
  refund_count: number;
  /** How many times the others' usual (their median, at least 1) one person must reach. */
  peer_multiple: number;
  /** A manual discount this big (percent of the bill) … */
  discount_percent: number;
  /** … or this big (amount) is a big discount. */
  discount_amount: number;
  /** Big discounts by one person in a day. */
  big_discount_count: number;
  /** Manual discounts by one person in a day (and above the others). */
  discount_count: number;
  /** Bills brought to nothing by one person in a day. */
  free_count: number;
  /** A drawer (or a day) short or over by this much. */
  cash_tolerance: number;
  /** Short this many times in 7 days. */
  cash_repeat: number;
  /** Sales priced below the list by one person in a day. */
  price_count: number;
  /** Items taken back from the kitchen by one person in a day (and above the others). */
  kitchen_count: number;
  /** Parked vehicles let out with no charge at a branch in a day. */
  parking_count: number;
  recipients: { owner: boolean; partners: boolean; managers: boolean };
  /** The day's alerts in the owner's daily email (when the daily email is on). */
  daily_email: boolean;
}

const ALL_ON = Object.fromEntries(LOSS_KINDS.map((k) => [k, true])) as Record<LossKind, boolean>;

export const LOSS_DEFAULTS: Readonly<LossSettings> = Object.freeze({
  enabled: true,
  kinds: Object.freeze({ ...ALL_ON }) as Record<LossKind, boolean>,
  paid_void_count: 2,
  void_count: 3,
  refund_count: 2,
  peer_multiple: 3,
  discount_percent: 20,
  discount_amount: 1000,
  big_discount_count: 2,
  discount_count: 5,
  free_count: 2,
  cash_tolerance: 500,
  cash_repeat: 3,
  price_count: 2,
  kitchen_count: 3,
  parking_count: 3,
  recipients: Object.freeze({ owner: true, partners: true, managers: true }) as LossSettings['recipients'],
  daily_email: true,
});

type NumKey = Exclude<keyof LossSettings, 'enabled' | 'kinds' | 'recipients' | 'daily_email'>;
/** The bounds each number may take; outside them (or not a number) its default applies. */
export const LOSS_LIMITS: Readonly<Record<NumKey, readonly [number, number]>> = Object.freeze({
  paid_void_count: [1, 100], void_count: [1, 100], refund_count: [1, 100], peer_multiple: [1.5, 20],
  discount_percent: [1, 100], discount_amount: [1, 100_000_000], big_discount_count: [1, 100], discount_count: [1, 500],
  free_count: [1, 100], cash_tolerance: [1, 100_000_000], cash_repeat: [2, 30], price_count: [1, 100],
  kitchen_count: [1, 100], parking_count: [1, 500],
});
export const LOSS_NUM_KEYS = Object.keys(LOSS_LIMITS) as NumKey[];

const parseObj = (v: unknown): Record<string, unknown> | null => {
  let o: unknown = v;
  for (let i = 0; i < 2 && typeof o === 'string'; i++) { try { o = JSON.parse(o); } catch { return null; } }
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
};
const sw = (v: unknown, dflt: boolean): boolean => (v === false || v === 'false' ? false : v === true || v === 'true' ? true : dflt);
const numIn = (v: unknown, dflt: number, [lo, hi]: readonly [number, number]): number => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt;
  return Math.round(n * 100) / 100;
};

/** The owner's settings from the stored value (business_settings 'loss_alerts') — every missing or bad key its default. */
export function readLossSettings(stored: unknown): LossSettings {
  const s = parseObj(stored) ?? {};
  const d = LOSS_DEFAULTS;
  const k = parseObj(s.kinds) ?? {};
  const r = parseObj(s.recipients) ?? {};
  const out = {
    enabled: sw(s.enabled, d.enabled),
    kinds: Object.fromEntries(LOSS_KINDS.map((x) => [x, sw(k[x], d.kinds[x])])) as Record<LossKind, boolean>,
    recipients: { owner: sw(r.owner, d.recipients.owner), partners: sw(r.partners, d.recipients.partners), managers: sw(r.managers, d.recipients.managers) },
    daily_email: sw(s.daily_email, d.daily_email),
  } as LossSettings;
  for (const key of LOSS_NUM_KEYS) (out as any)[key] = numIn(s[key], d[key], LOSS_LIMITS[key]);
  return out;
}

/** What the settings route stores: the known keys only, each cleaned. null = not settings at all. */
export function cleanLossSettings(value: unknown): LossSettings | null {
  return parseObj(value) ? readLossSettings(value) : null;
}

// ── business types ───────────────────────────────────────────────────────────

/** Which kinds fit a business of this type (unknown yet → a restaurant's, as the dashboard reads). */
export function kindsFor(rawType: string | null | undefined): LossKind[] {
  const t = businessTypeOf(rawType);
  return LOSS_KINDS.filter((k) => {
    if (k === 'kitchen_removed') return isFoodService(rawType);
    if (k === 'parking_no_charge') return t === 'parking';
    return true;
  });
}

export interface LossWords {
  type: BusinessTypeKey | null;
  /** What a bill is called: "order" at a restaurant or café, "ticket" at a car park, "sale" elsewhere. */
  order: string; orders: string;
  /** Who rings it up: "cashier", "attendant" (petrol, parking), "staff member" (restaurant, café). */
  staff: string; staffs: string;
  /** What a free bill is called. */
  free: string;
}

export function lossWords(rawType: string | null | undefined): LossWords {
  const t = businessTypeOf(rawType);
  if (isFoodService(rawType)) return { type: t, order: 'order', orders: 'orders', staff: 'staff member', staffs: 'staff', free: 'comps (orders at no charge)' };
  if (t === 'parking') return { type: t, order: 'ticket', orders: 'tickets', staff: 'attendant', staffs: 'attendants', free: 'tickets at no charge' };
  if (t === 'petrol_station') return { type: t, order: 'sale', orders: 'sales', staff: 'attendant', staffs: 'attendants', free: 'sales at no charge' };
  return { type: t, order: 'sale', orders: 'sales', staff: 'cashier', staffs: 'cashiers', free: 'sales at no charge' };
}

/** The settings page's words for one kind at this business. */
export function kindLabel(kind: LossKind, rawType: string | null | undefined): { label: string; hint: string } {
  const w = lossWords(rawType);
  switch (kind) {
    case 'paid_voids': return { label: `${cap(w.orders)} voided after payment`, hint: `A ${w.staff} voids ${w.orders} that were already paid.` };
    case 'many_voids': return { label: 'Many voids by one person', hint: `More voids than the other ${w.staffs} at the branch.` };
    case 'many_refunds': return { label: 'Many refunds by one person', hint: `More refunds than the other ${w.staffs} at the branch.` };
    case 'big_discounts': return { label: 'Big discounts', hint: 'Discounts typed in at the till above the percentage or the amount.' };
    case 'frequent_discounts': return { label: 'Frequent discounts', hint: `More discounts typed in than the other ${w.staffs}.` };
    case 'free_sales': return { label: cap(w.free), hint: `A ${w.order} discounted to nothing.` };
    case 'cash_short': return { label: 'Cash short or over', hint: 'A drawer counted short or over at the manager\'s confirm, a drawer short again and again, or a day closed short or over.' };
    case 'price_below_list': return { label: 'Priced below the list', hint: `${cap(w.orders)} rung up below the price list — often an old price on the till.` };
    case 'kitchen_removed': return { label: 'Items taken back from the kitchen', hint: 'Items removed after they were sent to the kitchen.' };
    case 'parking_no_charge': return { label: 'Vehicles let out with no charge', hint: 'Parking sessions voided — the vehicle left without paying.' };
  }
}

/** What the data does not record, so no alert can be built yet — shown to the owner on the settings page. */
export function lossNeedsData(rawType: string | null | undefined): string[] {
  const t = businessTypeOf(rawType);
  const food = isFoodService(rawType);
  const out = [
    'A drawer opened with no sale — the till does not record a "no sale" opening.',
    'Sales outside opening hours — no opening hours are stored.',
    'A void after the receipt printed — receipt prints are not recorded.',
  ];
  if (food) out.push('A table closed with no payment — the till does not record it apart from a credit or room-charge sale.');
  if (!food && t !== 'parking') out.push('An item removed from the basket before payment — only whole voided sales are recorded.');
  if (t === 'petrol_station') out.push('Fuel sold against the pump meters — no meter readings are recorded.');
  if (t === 'parking') out.push('Who let a vehicle out with no charge — a parking session does not record who closed it.');
  out.push('A refund with no original sale — not possible: every refund is recorded on its sale.');
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── the rows the detectors read (the job builds them; tests give them directly) ──

/** `date` is the event's business date (YYYY-MM-DD, the business's own day cut-off) — worked out by the job. */
interface At { branch_id: string | null; date: string }
export interface VoidRow extends At { id: string; by: string | null; total: number; paid: boolean }
export interface RefundRow extends At { id: string; by: string | null; amount: number }
export interface DiscountRow extends At { id: string; by: string | null; subtotal: number; manual: number; total: number }
export interface ShiftCashRow extends At { id: string; staff_id: string | null; difference: number }
export interface DayCloseRow extends At { id: string; difference: number }
export interface PriceRow extends At { id: string; by: string | null; difference: number }
export interface KitchenRow extends At { id: string; by: string | null; cooked: boolean; amount: number }
export interface ParkingRow extends At { id: string }
/** Who worked where and when (a shift opened) — the "others" each person is compared with. */
export interface WorkerRow extends At { staff_id: string }

export interface LossInput {
  businessType: string | null | undefined;
  currency: string;
  /** Today's business date. */
  today: string;
  /** The business dates a day alert is made for (today and yesterday — a till may sync late). */
  days: string[];
  /** The 7 business dates of the rolling period, oldest first, ending today. */
  week: string[];
  branches: Map<string, string>;
  people: Map<string, string>;
  workers: WorkerRow[];
  voids: VoidRow[];
  refunds: RefundRow[];
  discounts: DiscountRow[];
  shifts: ShiftCashRow[];
  dayCloses: DayCloseRow[];
  prices: PriceRow[];
  kitchen: KitchenRow[];
  parking: ParkingRow[];
}

export interface LossAlert {
  key: string;
  kind: LossKind;
  period: 'day' | 'week';
  /** The day (period 'day') or the last day of the 7 (period 'week'). */
  business_date: string;
  branch_id: string | null;
  staff_id: string | null;
  count: number;
  amount: number | null;
  peer_low: number | null;
  peer_high: number | null;
  score: number;
  message: string;
  link: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prevDate = (d: string, n = 1): string => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
};
export { prevDate as lossPrevDate };

/** "today", "yesterday", "on 21 Oct", "in the last 7 days". */
export function whenWords(period: 'day' | 'week', date: string, today: string): string {
  if (period === 'week') return `in the last ${LOSS_WEEK_DAYS} days`;
  if (date === today) return 'today';
  if (date === prevDate(today)) return 'yesterday';
  const [, m, d] = date.split('-').map(Number);
  return `on ${d} ${MON[m - 1]}`;
}

const wholeMoney = (cur: string, n: number) => `${cur} ${Math.round(Math.abs(n)).toLocaleString('en-KE')}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The others' range: "(others: 0–1)" — or the words when no one else worked there. */
function othersWords(lo: number | null, hi: number | null, branch: string, when: string): string {
  if (lo === null || hi === null) return `(no one else worked at ${branch} ${when})`;
  return `(others: ${lo === hi ? lo : `${lo}–${hi}`})`;
}

/**
 * The peer rule: at least `min`; with others — above every one of them AND at least `multiple` × their median (at least 1);
 * with no one else in the period, at least twice `min`.
 */
export function aboveOthers(count: number, others: number[], min: number, multiple: number): boolean {
  if (count < min) return false;
  if (!others.length) return count >= min * 2;
  const s = [...others].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return count > s[s.length - 1] && count >= multiple * Math.max(1, mid);
}

const WEIGHT: Record<LossKind, number> = {
  paid_voids: 9, cash_short: 8, kitchen_removed: 7, many_voids: 7, free_sales: 7, many_refunds: 6,
  big_discounts: 5, frequent_discounts: 5, parking_no_charge: 5, price_below_list: 3,
};

interface Ev { branch_id: string | null; date: string; by: string | null }

/** Group events by branch and person within a set of dates. */
function group<T extends Ev>(rows: T[], dates: Set<string>): Map<string, Map<string, T[]>> {
  const out = new Map<string, Map<string, T[]>>();
  for (const r of rows) {
    if (!r.by || !dates.has(r.date)) continue;
    const b = r.branch_id ?? '';
    const m = out.get(b) ?? new Map<string, T[]>();
    m.set(r.by, [...(m.get(r.by) ?? []), r]);
    out.set(b, m);
  }
  return out;
}

/** Who worked at a branch within a set of dates (shifts), plus anyone with an event there. */
function crew(input: LossInput, branch: string, dates: Set<string>, extra: Iterable<string>): Set<string> {
  const s = new Set<string>(extra);
  for (const w of input.workers) if ((w.branch_id ?? '') === branch && dates.has(w.date)) s.add(w.staff_id);
  return s;
}

function key(kind: LossKind, period: 'day' | 'week', date: string, branch: string | null, staff: string | null, ref = ''): string {
  return [kind, period, date, branch || '-', staff || '-', ref].filter((x, i) => i < 5 || x).join(':');
}

/** The link to the list behind an alert (the period, the branch, the person). */
export function alertLink(kind: LossKind, period: 'day' | 'week', date: string, branch: string | null, staff: string | null): string {
  const from = period === 'week' ? prevDate(date, LOSS_WEEK_DAYS - 1) : date;
  const p = new URLSearchParams({ from, to: date });
  if (branch) p.set('branch', branch);
  if (staff) p.set('staff', staff);
  switch (kind) {
    case 'many_refunds': p.set('tab', 'refunds'); return `/dashboard/reports?${p}`;
    case 'paid_voids': case 'many_voids': case 'price_below_list': p.set('tab', 'voids'); return `/dashboard/reports?${p}`;
    case 'cash_short': return `/dashboard/shift-reports?${p}`;
    case 'parking_no_charge': return `/dashboard/watch-list?${p}`;
    default: p.set('tab', 'master'); return `/dashboard/reports?${p}`;   // discounts, comps, kitchen: the master report for that person
  }
}

// ── the detectors ────────────────────────────────────────────────────────────

interface Built { kind: LossKind; period: 'day' | 'week'; date: string; branch: string | null; staff: string | null; ref?: string;
  count: number; amount?: number | null; lo?: number | null; hi?: number | null; ratio: number; message: string }

/** Every alert the rows show, for the kinds switched on that fit this business — ranked (most worth a look first). */
export function detectLossAlerts(input: LossInput, settings: LossSettings): LossAlert[] {
  if (!settings.enabled) return [];
  const fits = new Set(kindsFor(input.businessType));
  const on = (k: LossKind) => settings.kinds[k] && fits.has(k);
  const w = lossWords(input.businessType);
  const name = (id: string | null) => (id && input.people.get(id)) || `A ${w.staff}`;
  const branchName = (id: string | null) => (id && input.branches.get(id)) || 'the branch';
  const out: Built[] = [];
  const windows: Array<{ period: 'day' | 'week'; date: string; dates: Set<string>; scale: number }> = [
    ...input.days.map((d) => ({ period: 'day' as const, date: d, dates: new Set([d]), scale: 1 })),
    { period: 'week' as const, date: input.today, dates: new Set(input.week), scale: 2 },
  ];

  /** One person against the others at the branch. */
  const peerKind = <T extends Ev>(kind: LossKind, rows: T[], min: number, say: (who: string, n: number, rs: T[], others: string, when: string) => string, needPeers = true) => {
    if (!on(kind)) return;
    for (const win of windows) {
      for (const [branch, byPerson] of group(rows, win.dates)) {
        const team = crew(input, branch, win.dates, byPerson.keys());
        for (const [who, rs] of byPerson) {
          const others = [...team].filter((p) => p !== who).map((p) => byPerson.get(p)?.length ?? 0);
          const n = rs.length;
          const hit = needPeers ? aboveOthers(n, others, min * win.scale, settings.peer_multiple)
            : n >= min * win.scale && (!others.length || n > Math.max(...others));
          if (!hit) continue;
          const lo = others.length ? Math.min(...others) : null, hi = others.length ? Math.max(...others) : null;
          const when = whenWords(win.period, win.date, input.today);
          out.push({ kind, period: win.period, date: win.date, branch: branch || null, staff: who, count: n, lo, hi,
            ratio: n / Math.max(1, hi ?? 0), message: say(name(who), n, rs, othersWords(lo, hi, branchName(branch || null), when), when) });
        }
      }
    }
  };

  /** A count by one person, no comparison (big discounts, comps, prices below the list). */
  const countKind = <T extends Ev>(kind: LossKind, rows: T[], min: number, say: (who: string, n: number, rs: T[], when: string) => string, amountOf?: (rs: T[]) => number) => {
    if (!on(kind)) return;
    for (const win of windows) {
      for (const [branch, byPerson] of group(rows, win.dates)) {
        for (const [who, rs] of byPerson) {
          const n = rs.length;
          if (n < min * win.scale) continue;
          const when = whenWords(win.period, win.date, input.today);
          out.push({ kind, period: win.period, date: win.date, branch: branch || null, staff: who, count: n,
            amount: amountOf ? amountOf(rs) : null, ratio: n / (min * win.scale), message: say(name(who), n, rs, when) });
        }
      }
    }
  };

  peerKind('paid_voids', input.voids.filter((v) => v.paid), settings.paid_void_count,
    (who, n, _r, others, when) => `${who} voided ${plural(n, `paid ${w.order}`, `paid ${w.orders}`)} ${when} ${others}. Worth a look.`, false);
  peerKind('many_voids', input.voids, settings.void_count,
    (who, n, _r, others, when) => `${who} voided ${plural(n, w.order, w.orders)} ${when} ${others}. Worth a look.`);
  peerKind('many_refunds', input.refunds, settings.refund_count,
    (who, n, _r, others, when) => `${who} refunded ${plural(n, w.order, w.orders)} ${when} ${others}. Worth a look.`);

  const manual = input.discounts.filter((d) => d.manual > 0);
  const isBig = (d: DiscountRow) => d.manual >= settings.discount_amount
    || (d.subtotal > 0 && (d.manual / d.subtotal) * 100 >= settings.discount_percent);
  // A bill brought to nothing is a comp (its own line while that is watched), not also a "big discount".
  const isFree = (d: DiscountRow) => d.subtotal > 0 && d.total <= 0;
  countKind('big_discounts', manual.filter((d) => isBig(d) && !(on('free_sales') && isFree(d))), settings.big_discount_count,
    (who, n, rs, when) => `${who} gave ${plural(n, 'discount', 'discounts')} of ${settings.discount_percent}% or ${wholeMoney(input.currency, settings.discount_amount)} or more ${when} (largest ${wholeMoney(input.currency, Math.max(...rs.map((r) => r.manual)))}). Worth a look.`,
    (rs) => Math.max(...rs.map((r) => r.manual)));
  peerKind('frequent_discounts', manual, settings.discount_count,
    (who, n, _r, others, when) => `${who} typed in ${plural(n, 'discount', 'discounts')} ${when} ${others}. Worth a look.`);
  countKind('free_sales', manual.filter(isFree), settings.free_count,
    (who, n, _r, when) => `${who} rang up ${n} ${w.free} ${when}. Worth a look.`);
  countKind('price_below_list', input.prices.filter((p) => p.difference > 0), settings.price_count,
    (who, n, rs, when) => `${n} of ${who}'s ${w.orders} ${n === 1 ? 'was' : 'were'} priced below the price list ${when} (${wholeMoney(input.currency, rs.reduce((s, r) => s + r.difference, 0))} below in all). Often an old price on the till — worth a look.`,
    (rs) => Math.round(rs.reduce((s, r) => s + r.difference, 0) * 100) / 100);
  peerKind('kitchen_removed', input.kitchen, settings.kitchen_count,
    (who, n, rs, others, when) => {
      const cooked = rs.filter((r) => r.cooked).length;
      return `${who} took ${plural(n, 'item', 'items')} off ${w.orders} after they went to the kitchen ${when} ${others}${cooked ? `, ${cooked} already made` : ''}. Worth a look.`;
    });

  if (on('cash_short')) {
    const tol = settings.cash_tolerance;
    const drawer = w.type === 'petrol_station' ? 'cash' : 'drawer';
    // One drawer counted short or over beyond the tolerance (a day alert, one per shift).
    for (const s of input.shifts) {
      if (!input.days.includes(s.date) || Math.abs(s.difference) < tol) continue;
      const when = whenWords('day', s.date, input.today);
      out.push({ kind: 'cash_short', period: 'day', date: s.date, branch: s.branch_id, staff: s.staff_id, ref: s.id, count: 1,
        amount: s.difference, ratio: Math.abs(s.difference) / tol,
        message: `${name(s.staff_id)}'s ${drawer} at ${branchName(s.branch_id)} was counted ${wholeMoney(input.currency, s.difference)} ${s.difference < 0 ? 'short' : 'over'} ${when}. Worth a look.` });
    }
    // The same person short again and again over the 7 days (each shortage at least SMALL_SHORT).
    const weekSet = new Set(input.week);
    const shorts = new Map<string, ShiftCashRow[]>();
    for (const s of input.shifts) {
      if (!s.staff_id || !weekSet.has(s.date) || s.difference > -SMALL_SHORT) continue;
      const k = `${s.branch_id ?? ''}|${s.staff_id}`;
      shorts.set(k, [...(shorts.get(k) ?? []), s]);
    }
    for (const [k, rs] of shorts) {
      if (rs.length < settings.cash_repeat) continue;
      const [branch, staff] = k.split('|');
      const total = rs.reduce((x, r) => x + r.difference, 0);
      out.push({ kind: 'cash_short', period: 'week', date: input.today, branch: branch || null, staff, count: rs.length,
        amount: Math.round(total * 100) / 100, ratio: rs.length / settings.cash_repeat,
        message: `${name(staff)}'s ${drawer} at ${branchName(branch || null)} was short ${times(rs.length)} in the last ${LOSS_WEEK_DAYS} days (${wholeMoney(input.currency, total)} in all). Worth a look.` });
    }
    // A branch's day closed short or over (the till's day close).
    for (const d of input.dayCloses) {
      if (!input.days.includes(d.date) || Math.abs(d.difference) < tol) continue;
      out.push({ kind: 'cash_short', period: 'day', date: d.date, branch: d.branch_id, staff: null, ref: d.id, count: 1,
        amount: d.difference, ratio: Math.abs(d.difference) / tol,
        message: `The day at ${branchName(d.branch_id)} closed ${wholeMoney(input.currency, d.difference)} ${d.difference < 0 ? 'short' : 'over'} ${whenWords('day', d.date, input.today)}. Worth a look.` });
    }
  }

  if (on('parking_no_charge')) {
    // Per branch per day (a parking session does not record who let the vehicle out); "usual" = the branch's other days.
    const byBranchDay = new Map<string, Map<string, number>>();
    for (const p of input.parking) {
      const b = p.branch_id ?? '';
      const m = byBranchDay.get(b) ?? new Map<string, number>();
      m.set(p.date, (m.get(p.date) ?? 0) + 1);
      byBranchDay.set(b, m);
    }
    for (const [branch, perDay] of byBranchDay) {
      for (const day of input.days) {
        const n = perDay.get(day) ?? 0;
        if (n < settings.parking_count) continue;
        const usual = input.week.filter((d) => d !== day && d < day).map((d) => perDay.get(d) ?? 0);
        if (usual.length && n <= Math.max(...usual)) continue;
        const lo = usual.length ? Math.min(...usual) : null, hi = usual.length ? Math.max(...usual) : null;
        const when = whenWords('day', day, input.today);
        out.push({ kind: 'parking_no_charge', period: 'day', date: day, branch: branch || null, staff: null, count: n, lo, hi,
          ratio: n / Math.max(1, hi ?? 0),
          message: `${plural(n, 'parked vehicle', 'parked vehicles')} at ${branchName(branch || null)} left with no charge ${when}${hi === null ? '' : ` (usual: ${lo === hi ? lo : `${lo}–${hi}`} a day)`}. Worth a look.` });
      }
    }
  }

  // A rolling alert says nothing new when the same person already has a day alert of that kind (today or yesterday).
  const dayHas = new Set(out.filter((a) => a.period === 'day').map((a) => `${a.kind}|${a.branch ?? ''}|${a.staff ?? ''}`));
  // "Voided 6 paid orders" already says "voided 6 orders" for that person and period: one line, not two.
  const paidHas = new Set(out.filter((a) => a.kind === 'paid_voids').map((a) => `${a.period}|${a.date}|${a.branch ?? ''}|${a.staff ?? ''}`));
  const kept = out.filter((a) => (a.period === 'day' || !dayHas.has(`${a.kind}|${a.branch ?? ''}|${a.staff ?? ''}`))
    && !(a.kind === 'many_voids' && paidHas.has(`${a.period}|${a.date}|${a.branch ?? ''}|${a.staff ?? ''}`)));

  return rankLoss(kept.map((a) => ({
    key: key(a.kind, a.period, a.date, a.branch, a.staff, a.ref),
    kind: a.kind, period: a.period, business_date: a.date, branch_id: a.branch, staff_id: a.staff,
    count: a.count, amount: a.amount ?? null, peer_low: a.lo ?? null, peer_high: a.hi ?? null,
    score: Math.round((WEIGHT[a.kind] * 10 + Math.min(9, a.ratio) + (a.period === 'day' ? 1 : 0)) * 100) / 100,
    message: a.message,
    link: alertLink(a.kind, a.period, a.date, a.branch, a.staff),
  })));
}

/** Most worth a look first: the score, then the newest day, then the count. */
export function rankLoss<T extends { score: number; business_date: string; count: number; key?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || b.business_date.localeCompare(a.business_date) || b.count - a.count
    || String(a.key ?? '').localeCompare(String(b.key ?? '')));
}

/** At most LOSS_TOP, ranked. */
export function topLoss<T extends { score: number; business_date: string; count: number }>(rows: T[]): T[] {
  return rankLoss(rows).slice(0, LOSS_TOP);
}

// ── who is told, and when ────────────────────────────────────────────────────

export interface Person {
  id: string;
  /** On the owner's role (owner / admin) — told as the owner, never as a manager. */
  ownerRole: boolean;
  /** A live partner (web dashboard access the owner gave). */
  partner: boolean;
  /** Holds reports.voids (the voids & exceptions report). */
  seesVoids: boolean;
  /** Branches assigned; none = every branch. */
  branches: string[];
}

/**
 * The people (users ids) a team copy goes to — partners and managers per the owner's choice, at the alert's branch, and
 * NEVER the person the alert is about. The owner's own copy is separate (ownerTold). A cashier (no reports.voids) never.
 */
export function teamRecipients(alert: { branch_id: string | null; staff_id: string | null }, people: Person[], s: LossSettings): string[] {
  const out: string[] = [];
  for (const p of people) {
    if (p.ownerRole || p.id === alert.staff_id) continue;
    const here = !p.branches.length || !alert.branch_id || p.branches.includes(alert.branch_id);
    if (!here) continue;
    if ((s.recipients.partners && p.partner) || (s.recipients.managers && p.seesVoids && !p.partner)) out.push(p.id);
  }
  return [...new Set(out)];
}

/** The owner is told unless they switched it off, or the alert is about the owner's own sign-in. */
export const ownerTold = (alert: { staff_id: string | null }, ownerUserIds: string[], s: LossSettings): boolean =>
  s.recipients.owner && !(alert.staff_id && ownerUserIds.includes(alert.staff_id));

export interface StoredAlert { alert_key: string; kind: string; period: string; branch_id: string | null; staff_id: string | null;
  business_date: string; notified_at: string | null }

/**
 * Which alerts to notify now: never twice (the key already notified); a day alert only for today or yesterday (the first
 * run does not ring for a week of history); a rolling alert not again within 7 days of the last one for that kind, branch
 * and person; at most LOSS_TOP per run, the most worth a look first.
 */
export function toNotify(alerts: LossAlert[], stored: StoredAlert[], today: string): LossAlert[] {
  const done = new Set(stored.filter((r) => r.notified_at).map((r) => r.alert_key));
  const since = prevDate(today, LOSS_WEEK_DAYS - 1);
  const recentWeek = new Set(stored.filter((r) => r.period === 'week' && r.notified_at && r.business_date >= since)
    .map((r) => `${r.kind}|${r.branch_id ?? ''}|${r.staff_id ?? ''}`));
  const fresh = alerts.filter((a) => {
    if (done.has(a.key)) return false;
    if (a.period === 'day') return a.business_date >= prevDate(today);
    return !recentWeek.has(`${a.kind}|${a.branch_id ?? ''}|${a.staff_id ?? ''}`);
  });
  return topLoss(fresh);
}

/** The notification's title (short, plain). */
export function notificationTitle(kind: LossKind, rawType: string | null | undefined): string {
  return `Worth a look: ${kindLabel(kind, rawType).label.toLowerCase()}`;
}

/**
 * The daily email's lines: today's alerts (dismissed ones out), at most LOSS_TOP — and none about a person the email goes
 * to (the daily email has one set of recipients, branch managers among them).
 */
export function emailLines<T extends { staff_id: string | null; score: number; business_date: string; count: number }>(
  alerts: T[], subjectEmails: Map<string, string>, recipients: string[]): T[] {
  const to = new Set(recipients.map((r) => r.trim().toLowerCase()));
  return topLoss(alerts.filter((a) => !(a.staff_id && to.has(String(subjectEmails.get(a.staff_id) ?? '').toLowerCase()))));
}

/** Words an alert must never use (an accusation, or money "to recover") — checked by the tests over every message. */
export const LOSS_BANNED = /\b(theft|thief|stole|steal|stealing|fraud|fraudulent|suspicious|suspect|recover|recovered|owes|owed|caught|loss|losses|dishonest|cheat)\b/i;
