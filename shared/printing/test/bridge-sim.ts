/**
 * Simulate a real desktop cart through the SAME conversion escposBridge does,
 * then render kitchen and dispatch and diff against SAMPLE-OUTPUT.
 *
 * The bridge itself lives in apps/desktop and imports better-sqlite3, so this
 * copies its pure conversion logic verbatim. If they drift, this stops being
 * evidence — which is why every line here is a straight lift.
 */
import { renderTicket, toPreview, kitchenPreset, dispatchPreset, receiptPreset, hasPrintableContent } from '../src/index';
import type { OrderLine, OrderUnit, UnitAttribute } from '../src/types';

const KITCHEN_IDS = ['st-kitchen'];
const DISPATCH_IDS = ['st-dispatch'];
const toCents = (v: number) => Math.round(v * 100);

/** Stands in for stationsForCategory: food is cooked, everything else is bagged. */
function routeFor(categoryId?: string | null): string[] {
  return categoryId === 'c-food' ? KITCHEN_IDS : DISPATCH_IDS;
}

interface CartLine {
  product: { id: string; name: string; category_id?: string | null };
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  selectedVariants?: Array<{ groupName?: string; optionName?: string }>;
  selectedModifiers?: Array<{ name?: string; price?: number }>;
  comboComponents?: Array<{ name: string; quantity: number; is_kitchen?: boolean; category_id?: string | null }>;
}

// ── verbatim from escposBridge.toUnits ──────────────────────────────────────
function toUnits(line: CartLine): OrderUnit[] {
  const units: OrderUnit[] = [];

  for (const c of line.comboComponents ?? []) {
    units.push({
      productId: c.name,
      name: c.name,
      quantity: c.quantity,
      portions: 1,
      priceDelta: 0,
      chosen: false,
      attributes: [],
      stationIds: c.category_id
        ? routeFor(c.category_id)
        : (c.is_kitchen ? KITCHEN_IDS : DISPATCH_IDS),
    });
  }

  const attrs: UnitAttribute[] = (line.selectedVariants ?? [])
    .filter(v => v.optionName)
    .map(v => ({ group: v.groupName ?? '', option: v.optionName as string, count: 1, priceDelta: 0 }));
  if (attrs.length) {
    if (units.length) {
      units[0].attributes = attrs;
      units[0].chosen = true;
    } else {
      units.push({
        productId: line.product.id,
        name: line.product.name,
        quantity: 1,
        portions: 1,
        priceDelta: 0,
        chosen: true,
        attributes: attrs,
        stationIds: routeFor(line.product.category_id),
      });
    }
  }

  for (const m of line.selectedModifiers ?? []) {
    if (!m.name) continue;
    units.push({
      productId: m.name,
      name: m.name,
      quantity: 1,
      portions: 1,
      priceDelta: toCents(m.price ?? 0),
      chosen: true,
      attributes: [],
      stationIds: DISPATCH_IDS,
    });
  }

  return units;
}

// The cart the sample receipt was rung from.
const cart: CartLine[] = [
  {
    product: { id: 'p1', name: '3PC Chicken Combo', category_id: 'c-food' },
    quantity: 1, unitPrice: 890, lineTotal: 890,
    selectedVariants: [{ groupName: 'Spice', optionName: 'all spicy' }],
    comboComponents: [
      { name: '3PC Chicken',     quantity: 1, is_kitchen: true,  category_id: 'c-food' },
      { name: 'Fries large',     quantity: 1, is_kitchen: true,  category_id: 'c-food' },
      { name: 'Popcorn chicken', quantity: 1, is_kitchen: true,  category_id: 'c-food' },
      // No category routing configured for these two — is_kitchen is the
      // fallback, and it must still keep them off the kitchen ticket.
      { name: 'Cole slaw',       quantity: 1, is_kitchen: false },
      { name: 'Soda 1.25L',      quantity: 1, is_kitchen: false },
    ],
  },
  {
    product: { id: 'p2', name: 'Wings Combo 8PC', category_id: 'c-food' },
    quantity: 2, unitPrice: 1090, lineTotal: 2180,
    selectedVariants: [{ groupName: 'Spice', optionName: 'all spicy' }],
    selectedModifiers: [{ name: 'BBQ Sauce', price: 0 }, { name: 'Garlic Sauce', price: 0 }],
    comboComponents: [
      { name: '8PC Hot Wings', quantity: 1, is_kitchen: true, category_id: 'c-food' },
      { name: 'Fries medium',  quantity: 1, is_kitchen: true, category_id: 'c-food' },
    ],
  },
  {
    product: { id: 'p3', name: 'Soda 500ml', category_id: 'c-drinks' },
    quantity: 1, unitPrice: 120, lineTotal: 120,
  },
  // NOT a combo. One cooked product with a choice on it — the shape that
  // printed as a bare title, because the choice was dropped when there were no
  // components to attach it to.
  {
    product: { id: 'p4', name: 'Chicken Burger', category_id: 'c-food' },
    quantity: 1, unitPrice: 450, lineTotal: 450,
    selectedVariants: [{ groupName: 'Size', optionName: 'Large' }],
  },
];


const lines: OrderLine[] = cart.map(l => ({
  name: l.product.name,
  quantity: l.quantity,
  stationIds: routeFor(l.product.category_id),
  unitPrice: toCents(l.unitPrice),
  lineTotal: toCents(l.lineTotal),
  units: toUnits(l),
}));

const order = {
  billNumber: 'T1--5718',
  orderType: 'takeaway' as const,
  cashierName: 'grace wanjiku',
  soldAt: new Date('2026-08-05T19:42:11'),
  lines,
  payments: [{ label: 'CASH', amount: toCents(3500) }],
  changeGiven: toCents(200),
  total: toCents(3300),
  kotCount: 2,
};

const business = {
  name: 'KUDO KUDO', branchName: 'Kilimani Branch',
  currencyCode: 'KES', vatRate: 16, ctlRate: 2,
  footerCredit: 'Powered by SwiftPOS',
};

// ── The description fallback, verbatim from escposBridge.describeFromText ──
function describeFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const raw = text.trim();
  if (!raw || raw.length > 200) return [];
  const SEPARATORS = [/\r?\n/, /\s*[•·]\s*/, /\s+\+\s+/, /\s*,\s*/, /\s*\/\s*/];
  for (const sep of SEPARATORS) {
    const parts = raw.split(sep).map(t => t.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 12) continue;
    if (!parts.every(t => t.length <= 40 && t.split(/\s+/).length <= 6 && !/[.;:!?]$/.test(t))) continue;
    return parts;
  }
  return [];
}

const out: Record<string, string> = {};
for (const [label, station] of [
  ['KITCHEN',  kitchenPreset('st-kitchen', 'Kitchen', 80)],
  ['DISPATCH', dispatchPreset('st-dispatch', 'Dispatch', 80)],
] as const) {
  out[label] = toPreview(renderTicket({ order, business, station }), { showMargins: true });
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
  console.log(out[label]);
}

// ── Assertions ──────────────────────────────────────────────────────────────
// The tickets are checked for the things that actually went wrong on hardware,
// rather than compared whole — a whole-file compare breaks on a station rename
// and teaches everyone to ignore it.
let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};

console.log('\nAssertions');

const K = out.KITCHEN, D = out.DISPATCH;

check('kitchen lists the cooked components',
  K.includes('3PC Chicken') && K.includes('Fries large') && K.includes('Popcorn chicken'));
check('kitchen does NOT list what is only bagged',
  !K.includes('Cole slaw') && !K.includes('Soda 1.25L') && !K.includes('BBQ Sauce'));
check('kitchen does NOT list a drink sold on its own',
  !K.includes('SODA 500ML'));
// 5 cooked components across the two combos + the synthesised Chicken Burger
// unit. Counting UNITS, not lines, is the point: three lines, six things to make.
check('kitchen counts the items to cook, not the lines',
  K.includes('6 items to cook'));
check('kitchen puts an attribute on its own line',
  /3PC Chicken\s*\|[\s\S]*?all spicy/.test(K) && !K.includes('(all spicy)'));

check('dispatch lists everything in the bag',
  ['3PC Chicken', 'Cole slaw', 'Soda 1.25L', 'BBQ Sauce', 'Garlic Sauce', 'SODA 500ML']
    .every(t => D.includes(t)));
check('dispatch puts a simple attribute inline',
  D.includes('3PC Chicken (all spicy)'));
// Four lines reach dispatch, so four bags. Counting LINES here, not units, is
// equally deliberate — the packer counts parcels, the cook counts dishes.
check('dispatch counts bags, not items',
  D.includes('4 bags'));

check('a plain product reaches the KITCHEN with its choice, not as a bare title',
  K.includes('CHICKEN BURGER') && /Large/.test(K));
check('the choice is not silently dropped',
  K.includes('Large'));
// ── The fallback has to work for ANY menu, and refuse prose ────────────────
// A restaurant types a flat menu with a line of prose. Requiring structured
// components before a kitchen ticket is useful would make every new client
// unusable on day one and force every menu into one shape.
check('a "+" list is read as components',
  describeFromText('3pc chicken + cole slaw + popcorn + medium fries').length === 4);
check('a comma list is read as components',
  describeFromText('Burger, fries, drink').length === 3);
check('a slash list is read as components',
  describeFromText('Pizza slice / garlic bread / soda').length === 3);
check('a line-per-item list is read as components',
  describeFromText('2 samosas\n1 chai\n1 mandazi').length === 3);
check('a bulleted list is read as components',
  describeFromText('Ugali • sukuma • beef stew').length === 3);

check('PROSE is refused, not split into nonsense',
  describeFromText('Our famous crispy chicken, marinated for 24 hours and served with a smile.').length === 0);
check('a bare phrase is refused',
  describeFromText('Shared platter box').length === 0);
check('a size word is refused',
  describeFromText('Medium').length === 0);
check('a paragraph is refused outright',
  describeFromText('x'.repeat(201)).length === 0);

// ── Owner-stated kitchen exclusions ────────────────────────────────────────
// Verbatim from escposBridge.isExcludedFromKitchen.
function isExcludedFromKitchen(name: string, exclusions: string[]): boolean {
  if (!name) return false;
  const hay = name.toLowerCase();
  return exclusions.some(term => {
    const t = term.trim().toLowerCase();
    if (!t) return false;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay);
  });
}

const EX = ['soda', 'soft drink', 'sauce', 'cole slaw'];
check('an exact name is excluded',        isExcludedFromKitchen('Cole Slaw', EX));
check('a name with a size is excluded',   isExcludedFromKitchen('Soda 1.25L', EX));
check('a leading quantity is excluded',   isExcludedFromKitchen('1L soft drink', EX));
check('matching is case-insensitive',     isExcludedFromKitchen('SODA 500ML', EX));
check('a cooked item is NOT excluded',    !isExcludedFromKitchen('3PC Chicken', EX));
check('a partial word does NOT match',    !isExcludedFromKitchen('Sodalite Special', EX));
check('an empty list excludes nothing',   !isExcludedFromKitchen('Soda 1.25L', []));
check('regex characters in a term are safe', (() => {
  try { return !isExcludedFromKitchen('Chicken', ['7-up (500ml)', '*']); }
  catch { return false; }
})());

// ── A ticket with nothing on it must not print at all ──────────────────────
// A drinks-only order rendered a kitchen slip saying "0 items to cook". The
// kitchen had to stop, read it, and bin it — during service.
const drinksOnly = {
  ...order,
  lines: [{
    name: 'Soda 500ml', quantity: 2, stationIds: ['st-dispatch'],
    unitPrice: 12000, lineTotal: 24000, units: [],
  }],
};
check('a drinks-only order prints NO kitchen ticket',
  !hasPrintableContent({ order: drinksOnly, business, station: kitchenPreset('st-kitchen','Kitchen',80) }));
check('the same order DOES print a dispatch ticket',
  hasPrintableContent({ order: drinksOnly, business, station: dispatchPreset('st-dispatch','Dispatch',80) }));
check('the same order DOES print a receipt',
  hasPrintableContent({ order: drinksOnly, business, station: receiptPreset('st-till','Till',80) }));
check('a normal order still prints a kitchen ticket',
  hasPrintableContent({ order, business, station: kitchenPreset('st-kitchen','Kitchen',80) }));
check('an EMPTY order prints no production ticket',
  !hasPrintableContent({ order: { ...order, lines: [] }, business, station: kitchenPreset('st-kitchen','Kitchen',80) }));
check('an empty order still prints a receipt — the total is owed',
  hasPrintableContent({ order: { ...order, lines: [] }, business, station: receiptPreset('st-till','Till',80) }));

check('neither production ticket shows prices',
  !K.includes('754.24') && !D.includes('754.24'));

console.log(`\n${failed ? `${failed} FAILED` : 'all assertions passed'}\n`);
process.exit(failed ? 1 : 0);
