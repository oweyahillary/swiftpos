/**
 * offers.ts — A445: offers a manager creates, applied by themselves at the till, the web POS and the cloud.
 *
 * Owner, 2026-10-11: "a manager can create an offer i.e runs on specific days or on a certain duration" — % or amount
 * off, a special price, buy X get Y free ("buy one or buy 2 and get this for free"), spend over X get money off, and "a
 * custom meal" (chosen items together for one price). Timing: optional dates, chosen weekdays and an optional time window,
 * on the till's own clock (works offline). The owner sets offers for every or chosen branches; a manager for their own.
 * A manual discount still applies on top, capped as before on what is left after the offers.
 *
 * ONE engine for every surface — the till's cart, the web POS's cart and the cloud's check of a sale (which recomputes
 * the offers a sale claims on its own prices and never lets a sale claim more than this gives). Pure; ONE file, copied
 * to the till (shared + main), the dashboard and the cloud (check-shared-sync).
 *
 * How a cart is priced (each unit of an item takes part in at most one item offer — no stacking on the same unit):
 *   1. custom meals   — a set of components ("any burger" + "any side" + "any soda") for one price; the most expensive
 *                       matching items are used, and only when the meal is cheaper than them;
 *   2. buy X get Y    — of the same items (the cheapest of each group is free) or of a named item ("buy 2 burgers, get a
 *                       soda free" — the soda must be in the cart);
 *   3. per item       — % off, amount off, or a special price; each unit takes the best one that applies to it;
 *   4. spend over X   — % or amount off what is left after 1–3, the best single one.
 */

export type OfferKind = 'percent_off' | 'amount_off' | 'special_price' | 'buy_get' | 'spend_get' | 'meal';
export const OFFER_KINDS: OfferKind[] = ['percent_off', 'amount_off', 'special_price', 'buy_get', 'spend_get', 'meal'];

export interface MealPart { label: string; product_ids: string[]; category_ids: string[]; qty: number }

export interface Offer {
  id: string;
  name: string;
  kind: OfferKind;
  /** percent_off: the %; amount_off: off each item; special_price: the item's price; spend_get: the reward; meal: its price. */
  value: number;
  /** spend_get only: the reward is a % of the bill or an amount. */
  spend_type: 'percent' | 'amount';
  /** Which items: every item, chosen products, or chosen categories (not used by spend_get and meal). */
  applies_to: 'all' | 'products' | 'categories';
  product_ids: string[];
  category_ids: string[];
  buy_qty: number;
  get_qty: number;
  /** buy_get: the free item; null = the same items as bought (the cheapest of each group is free). */
  get_product_id: string | null;
  min_spend: number;
  meal_items: MealPart[];
  start_date: string | null;   // YYYY-MM-DD, inclusive
  end_date: string | null;     // YYYY-MM-DD, inclusive
  days: number[] | null;       // 0 = Sunday … 6 = Saturday; null = every day
  start_time: string | null;   // HH:MM
  end_time: string | null;     // HH:MM; before start_time = runs past midnight
  branch_ids: string[] | null; // null = every branch
  active: boolean;
}

export interface OfferLine { key: string; product_id: string | null; category_id: string | null; unit_price: number; quantity: number }
export interface AppliedOffer { offer_id: string; name: string; amount: number }
export interface OfferResult {
  total: number;
  applied: AppliedOffer[];
  /** What the item offers took off each line (by key). The spend offer is on the bill, not a line. */
  byLine: Record<string, number>;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((x) => x.trim() !== '') : []);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── Cleaning what a screen or the cloud hands in ────────────────────────────

/** An offer from a form, the cloud or the till's copy → a clean Offer, or the reason it is not one. */
export function cleanOffer(raw: any): { ok: true; offer: Offer } | { ok: false; error: string } {
  const r = raw ?? {};
  const kind = String(r.kind ?? '') as OfferKind;
  if (!OFFER_KINDS.includes(kind)) return { ok: false, error: 'Choose what kind of offer this is.' };
  const name = String(r.name ?? '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Give the offer a name the cashier and the receipt will show.' };
  const value = round2(num(r.value));
  const applies_to = (['all', 'products', 'categories'].includes(r.applies_to) ? r.applies_to : 'all') as Offer['applies_to'];
  const product_ids = ids(r.product_ids);
  const category_ids = ids(r.category_ids);
  const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : null;
  const start_date = DATE_RE.test(String(r.start_date ?? '')) ? String(r.start_date) : null;
  const end_date = DATE_RE.test(String(r.end_date ?? '')) ? String(r.end_date) : null;
  const start_time = TIME_RE.test(String(r.start_time ?? '').slice(0, 5)) ? String(r.start_time).slice(0, 5) : null;
  const end_time = TIME_RE.test(String(r.end_time ?? '').slice(0, 5)) ? String(r.end_time).slice(0, 5) : null;
  const meal_items: MealPart[] = (Array.isArray(r.meal_items) ? r.meal_items : []).map((m: any) => ({
    label: String(m?.label ?? '').trim().slice(0, 40), product_ids: ids(m?.product_ids), category_ids: ids(m?.category_ids),
    qty: Math.max(1, Math.floor(num(m?.qty, 1))),
  })).filter((m: MealPart) => m.product_ids.length || m.category_ids.length);
  const offer: Offer = {
    id: String(r.id ?? ''), name, kind, value,
    spend_type: r.spend_type === 'percent' ? 'percent' : 'amount',
    applies_to, product_ids, category_ids,
    buy_qty: Math.max(0, Math.floor(num(r.buy_qty))), get_qty: Math.max(0, Math.floor(num(r.get_qty))),
    get_product_id: r.get_product_id ? String(r.get_product_id) : null,
    min_spend: Math.max(0, round2(num(r.min_spend))),
    meal_items,
    start_date, end_date,
    days: days && days.length && days.length < 7 ? days : null,
    start_time, end_time,
    branch_ids: Array.isArray(r.branch_ids) && ids(r.branch_ids).length ? ids(r.branch_ids) : null,
    active: r.active !== false && r.active !== 0,
  };
  if (start_date && end_date && end_date < start_date) return { ok: false, error: 'The offer ends before it starts.' };
  if ((start_time && !end_time) || (!start_time && end_time)) return { ok: false, error: 'Give both a start and an end time, or neither.' };
  if (start_time && start_time === end_time) return { ok: false, error: 'The start and end times are the same.' };
  if (applies_to === 'products' && !product_ids.length && kind !== 'meal' && kind !== 'spend_get') return { ok: false, error: 'Choose the products this offer is for.' };
  if (applies_to === 'categories' && !category_ids.length && kind !== 'meal' && kind !== 'spend_get') return { ok: false, error: 'Choose the categories this offer is for.' };
  switch (kind) {
    case 'percent_off': if (!(value > 0 && value <= 100)) return { ok: false, error: 'The % off must be between 1 and 100.' }; break;
    case 'amount_off': if (!(value > 0)) return { ok: false, error: 'Enter the amount off each item.' }; break;
    case 'special_price': if (!(value >= 0)) return { ok: false, error: 'Enter the special price.' }; break;
    case 'buy_get':
      if (offer.buy_qty < 1 || offer.get_qty < 1) return { ok: false, error: 'Enter how many to buy and how many are free.' };
      break;
    case 'spend_get':
      if (!(offer.min_spend > 0)) return { ok: false, error: 'Enter how much the customer must spend.' };
      if (!(value > 0) || (offer.spend_type === 'percent' && value > 100)) return { ok: false, error: 'Enter the reward (an amount, or 1–100 %).' };
      break;
    case 'meal':
      if (!meal_items.length) return { ok: false, error: 'Add the items that make up the meal.' };
      if (!(value > 0)) return { ok: false, error: 'Enter the meal\'s price.' };
      break;
  }
  return { ok: true, offer };
}

// ── When an offer runs ───────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Does the offer run at `at` (the till's local clock) for `branchId`? */
export function offerRunsAt(o: Offer, at: Date, branchId: string | null): boolean {
  if (!o.active) return false;
  if (o.branch_ids && (!branchId || !o.branch_ids.includes(branchId))) return false;
  let day = new Date(at.getTime());
  if (o.start_time && o.end_time) {
    const t = localTime(at);
    const overnight = o.end_time < o.start_time;
    const inside = overnight ? (t >= o.start_time || t < o.end_time) : (t >= o.start_time && t < o.end_time);
    if (!inside) return false;
    // Past midnight in an overnight window, the night belongs to the day it started.
    if (overnight && t < o.end_time) day = new Date(at.getTime() - 24 * 3600 * 1000);
  }
  const date = localDate(day);
  if (o.start_date && date < o.start_date) return false;
  if (o.end_date && date > o.end_date) return false;
  if (o.days && !o.days.includes(day.getDay())) return false;
  return true;
}

// ── Pricing a cart ───────────────────────────────────────────────────────────

interface Unit { key: string; product_id: string | null; category_id: string | null; price: number; weight: number; taken: boolean }

function matches(o: { applies_to: Offer['applies_to']; product_ids: string[]; category_ids: string[] }, u: Unit): boolean {
  if (o.applies_to === 'all') return true;
  if (o.applies_to === 'products') return !!u.product_id && o.product_ids.includes(u.product_id);
  return !!u.category_id && o.category_ids.includes(u.category_id);
}
const inPart = (p: MealPart, u: Unit) =>
  (!!u.product_id && p.product_ids.includes(u.product_id)) || (!!u.category_id && p.category_ids.includes(u.category_id));

/**
 * The offers on a cart. `offers` are the till's (or the cloud's) copy; those not running at `at` for `branchId` are
 * skipped — unless `ignoreTiming` (the cloud re-checking a sale the till already priced: the timing was the till's call,
 * and an offline sale reaches the cloud later).
 */
export function applyOffers(lines: OfferLine[], offers: Offer[],
  opts: { at?: Date; branchId?: string | null; ignoreTiming?: boolean } = {}): OfferResult {
  const at = opts.at ?? new Date();
  const live = (offers ?? []).filter((o) => o && (opts.ignoreTiming ? o.active && (!o.branch_ids || !opts.branchId || o.branch_ids.includes(opts.branchId)) : offerRunsAt(o, at, opts.branchId ?? null)));
  const units: Unit[] = [];
  for (const l of lines ?? []) {
    const q = num(l.quantity), p = Math.max(0, num(l.unit_price));
    if (!(q > 0)) continue;
    if (Number.isInteger(q)) for (let i = 0; i < q; i++) units.push({ key: l.key, product_id: l.product_id, category_id: l.category_id, price: p, weight: 1, taken: false });
    // A weighed or measured line (2.5 kg, 30 litres) is one unit of its whole amount: % / amount / special price only.
    else units.push({ key: l.key, product_id: l.product_id, category_id: l.category_id, price: p, weight: q, taken: false });
  }
  const whole = (u: Unit) => u.weight === 1;
  const applied = new Map<string, AppliedOffer>();
  const byLine: Record<string, number> = {};
  const give = (o: Offer, amount: number, perUnit: Array<[Unit, number]>) => {
    if (!(amount > 0)) return;
    const a = applied.get(o.id) ?? { offer_id: o.id, name: o.name, amount: 0 };
    a.amount = round2(a.amount + amount);
    applied.set(o.id, a);
    for (const [u, v] of perUnit) byLine[u.key] = round2((byLine[u.key] ?? 0) + v);
  };
  const free = () => units.filter((u) => !u.taken);
  const byPriceDesc = (a: Unit, b: Unit) => b.price - a.price;

  // 1. Custom meals — repeat while a full meal can be made from what is not yet in an offer, and it saves money.
  for (const o of live.filter((x) => x.kind === 'meal')) {
    for (let guard = 0; guard < 100; guard++) {
      const picked: Unit[] = [];
      let complete = true;
      for (const part of o.meal_items) {
        const pool = free().filter((u) => whole(u) && !picked.includes(u) && inPart(part, u)).sort(byPriceDesc);
        if (pool.length < part.qty) { complete = false; break; }
        picked.push(...pool.slice(0, part.qty));
      }
      if (!complete) break;
      const full = round2(picked.reduce((s, u) => s + u.price, 0));
      const saving = round2(full - o.value);
      if (!(saving > 0)) break;
      picked.forEach((u) => { u.taken = true; });
      // Spread the saving over the meal's items in proportion to their prices (the last takes the rounding).
      let left = saving;
      const parts: Array<[Unit, number]> = picked.map((u, i) => {
        const v = i === picked.length - 1 ? left : round2(saving * (u.price / full));
        left = round2(left - v);
        return [u, v];
      });
      give(o, saving, parts);
    }
  }

  // 2. Buy X get Y free.
  for (const o of live.filter((x) => x.kind === 'buy_get' && x.buy_qty > 0 && x.get_qty > 0)) {
    if (!o.get_product_id) {
      const pool = free().filter((u) => whole(u) && matches(o, u)).sort(byPriceDesc);
      const size = o.buy_qty + o.get_qty;
      for (let i = 0; i + size <= pool.length; i += size) {
        const group = pool.slice(i, i + size);
        group.forEach((u) => { u.taken = true; });
        const gifts = group.slice(o.buy_qty);   // the cheapest of the group
        give(o, round2(gifts.reduce((s, u) => s + u.price, 0)), gifts.map((u) => [u, u.price] as [Unit, number]));
      }
    } else {
      const gifts = free().filter((u) => whole(u) && u.product_id === o.get_product_id).sort((a, b) => a.price - b.price);
      const buys = free().filter((u) => whole(u) && matches(o, u) && u.product_id !== o.get_product_id).sort(byPriceDesc);
      const groups = Math.min(Math.floor(buys.length / o.buy_qty), Math.floor(gifts.length / o.get_qty));
      if (groups > 0) {
        buys.slice(0, groups * o.buy_qty).forEach((u) => { u.taken = true; });
        const given = gifts.slice(0, groups * o.get_qty);
        given.forEach((u) => { u.taken = true; });
        give(o, round2(given.reduce((s, u) => s + u.price, 0)), given.map((u) => [u, u.price] as [Unit, number]));
      }
    }
  }

  // 3. Per item: each unit not yet in an offer takes the best % / amount / special price that applies to it.
  const perItem = live.filter((x) => x.kind === 'percent_off' || x.kind === 'amount_off' || x.kind === 'special_price');
  for (const u of free()) {
    let best: { o: Offer; off: number } | null = null;
    for (const o of perItem) {
      if (!matches(o, u)) continue;
      const each = o.kind === 'percent_off' ? u.price * Math.min(o.value, 100) / 100
        : o.kind === 'amount_off' ? Math.min(o.value, u.price)
        : Math.max(0, u.price - o.value);
      const off = round2(each * u.weight);
      if (off > 0 && (!best || off > best.off)) best = { o, off };
    }
    if (best) { u.taken = true; give(best.o, best.off, [[u, best.off]]); }
  }

  // 4. Spend over X: the best single reward on what is left of the bill.
  const itemOff = round2([...applied.values()].reduce((s, a) => s + a.amount, 0));
  const billLeft = round2(units.reduce((s, u) => s + u.price * u.weight, 0) - itemOff);
  let bestSpend: { o: Offer; off: number } | null = null;
  for (const o of live.filter((x) => x.kind === 'spend_get')) {
    if (billLeft + 0.005 < o.min_spend) continue;
    const off = round2(Math.min(billLeft, o.spend_type === 'percent' ? billLeft * Math.min(o.value, 100) / 100 : o.value));
    if (off > 0 && (!bestSpend || off > bestSpend.off)) bestSpend = { o, off };
  }
  if (bestSpend) give(bestSpend.o, bestSpend.off, []);

  const list = [...applied.values()].filter((a) => a.amount > 0);
  return { total: round2(list.reduce((s, a) => s + a.amount, 0)), applied: list, byLine };
}

// ── Words for the screens ────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Fri · 16:00–19:00 · 1 Oct – 31 Oct" — or "Every day". */
export function offerWhenLabel(o: Pick<Offer, 'days' | 'start_time' | 'end_time' | 'start_date' | 'end_date'>): string {
  const parts: string[] = [];
  if (o.days && o.days.length && o.days.length < 7) {
    const d = [...o.days].sort();
    const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    parts.push(run && d.length > 2 ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', '));
  } else parts.push('Every day');
  if (o.start_time && o.end_time) parts.push(`${o.start_time}–${o.end_time}`);
  if (o.start_date || o.end_date) parts.push(`${o.start_date ?? '…'} to ${o.end_date ?? '…'}`);
  return parts.join(' · ');
}

/** "20% off", "Buy 2 get 1 free", "Spend 2,000 get 10% off", "Meal for 850". */
export function offerWhatLabel(o: Offer, productName: (id: string) => string = (id) => id): string {
  const m = (v: number) => v.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  switch (o.kind) {
    case 'percent_off': return `${m(o.value)}% off`;
    case 'amount_off': return `${m(o.value)} off each`;
    case 'special_price': return `Special price ${m(o.value)}`;
    case 'buy_get': return `Buy ${o.buy_qty} get ${o.get_qty} ${o.get_product_id ? `${productName(o.get_product_id)} ` : ''}free`;
    case 'spend_get': return `Spend ${m(o.min_spend)} get ${o.spend_type === 'percent' ? `${m(o.value)}%` : m(o.value)} off`;
    case 'meal': return `Meal for ${m(o.value)}: ${o.meal_items.map((p) => `${p.qty} × ${p.label || 'item'}`).join(' + ')}`;
  }
}
