// Renders the site's receipts through the REAL print renderer (shared/printing), so the slips on the website are
// exactly what the thermal printer prints: the customer receipt, the kitchen and dispatch tickets, and the shift
// close (Z-report). Made-up demo data only ("Mama Lishe Grill"); never a client's.
//
// Run from apps/website after building shared/printing (cd shared/printing && npm run build):
//   node scripts/render-slips.mjs
// It writes src/lib/slips.generated.json, which src/components/screens/Receipt.astro reads.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(join(here, '../../../shared/printing/dist/index.js'));
const { renderTicket, toPreview, kitchenPreset, dispatchPreset, receiptPreset, renderShiftReport, toUnits, stationsForCategory } = P;

const KITCHEN = 'st-kitchen';
const DISPATCH = 'st-dispatch';
const ids = { kitchen: [KITCHEN], dispatch: [DISPATCH] };
const routing = {
  byCategory: { 'cat-grill': [KITCHEN, DISPATCH], 'cat-sides': [KITCHEN, DISPATCH], 'cat-drinks': [DISPATCH], 'cat-burgers': [KITCHEN, DISPATCH] },
  kitchenCategories: new Set(['cat-grill', 'cat-sides', 'cat-burgers']),
};

// The cart as the till hands it to the printer (escposBridge.printSale -> toUnits). Shillings here, cents below.
const cart = [
  { product: { id: 'p-nyama', name: 'Nyama Choma 1kg', category_id: 'cat-grill' }, quantity: 1, lineTotal: 1450 },
  { product: { id: 'p-chips', name: 'Chips Masala', category_id: 'cat-sides' }, quantity: 2, lineTotal: 600,
    selectedVariants: [{ groupName: 'Spice', optionName: 'Spicy' }] },
  { product: { id: 'p-burger', name: 'Chicken Burger', category_id: 'cat-burgers' }, quantity: 1, lineTotal: 650,
    selectedVariants: [{ groupName: 'Spice', optionName: 'Chicken Burger Spicy' }] },
  { product: { id: 'p-kach', name: 'Kachumbari', category_id: 'cat-sides' }, quantity: 1, lineTotal: 150 },
  { product: { id: 'p-passion', name: 'Passion Juice', category_id: 'cat-drinks' }, quantity: 2, lineTotal: 500 },
];
const orderLines = cart.map((l) => {
  const lineStationIds = stationsForCategory(l.product.category_id, ids, routing);
  const cents = Math.round(l.lineTotal * 100);
  return { name: l.product.name, quantity: l.quantity, stationIds: lineStationIds,
    unitPrice: Math.round(cents / l.quantity), lineTotal: cents, units: toUnits(l, ids, lineStationIds, routing) };
});
const total = orderLines.reduce((a, l) => a + l.lineTotal, 0);   // 3,350.00

const business = {
  name: 'Mama Lishe Grill',
  branchName: 'Ngong Road',
  telephone: '0700 000 000',
  tillLabel: 'Buy Goods',
  tillNumber: '123456',
  thankYouMessage: 'Asante! Karibu tena.',
  footerCredit: 'Powered by ZapTill',
  currencyCode: 'KES',
  vatRate: 16,
  ctlRate: 0,
};

const order = {
  billNumber: 'T1-1042',
  orderType: 'dine_in',
  tableNumber: '4',
  cashierName: 'Wanjiru',
  soldAt: new Date(2026, 9, 21, 12, 41, 5),
  kotCount: 1,
  lines: orderLines,
  total,
  payments: [{ label: 'M-Pesa', amount: 200000 }, { label: 'Cash', amount: total - 200000 }],
  changeGiven: 0,
};

// Each printed line as { t: text, s: size, b: bold }. The text is laid out exactly as toPreview lays it out (the same
// centring and truncation), except that a double-width line keeps its own letters instead of spacing them out: the
// site draws it twice as wide with CSS instead. Blank feeds are kept; the cut and the drawer kick are dropped.
function lines(doc) {
  const cols = doc.columns;
  const out = [];
  for (const b of doc.blocks) {
    if (b.kind === 'feed') { for (let i = 0; i < b.lines; i++) out.push({ t: '' }); continue; }
    if (b.kind !== 'text') continue;
    const wide = b.size === 'wide' || b.size === 'large';
    const eff = wide ? Math.floor(cols / 2) : cols;
    let t = b.text.length > eff ? b.text.slice(0, eff) : b.text;
    if (b.align === 'center') t = ' '.repeat(Math.max(0, Math.floor((eff - t.length) / 2))) + t;
    else if (b.align === 'right') t = ' '.repeat(Math.max(0, eff - t.length)) + t;
    const line = { t: t.replace(/\s+$/, '') };
    if (b.size && b.size !== 'normal') line.s = b.size;
    if (b.bold) line.b = 1;
    out.push(line);
  }
  while (out.length && !out[out.length - 1].t) out.pop();
  return { cols, lines: out };
}

// The check: with double-width letters spaced out again, our lines must equal toPreview's, line for line.
function text(doc) {
  const r = lines(doc);
  const spaced = (t) => t.replace(/^( *)(.*)$/, (_, sp, x) => sp + x.split('').join(' '));
  const ours = r.lines.map((l) => (l.s === 'wide' || l.s === 'large' ? spaced(l.t) : l.t));
  const theirs = toPreview(doc).split('\n').filter((l) => !/^=+$/.test(l)).map((l) => l.replace(/\s+$/, ''));
  while (theirs.length && !theirs[theirs.length - 1]) theirs.pop();
  if (ours.join('\n') !== theirs.join('\n')) {
    throw new Error('slip text differs from toPreview:\n' + ours.join('\n') + '\n---\n' + theirs.join('\n'));
  }
  return r;
}

// A shop sale for the retail page: counter sale, no kitchen, M-Pesa and cash.
const shopLines = [
  ['Bar Soap 800g', 1, 240], ['Cooking Oil 1L', 2, 680], ['Toothpaste 100ml', 1, 180], ['Soda 500ml', 3, 240], ['Biscuits 200g', 1, 120],
].map(([name, quantity, shillings]) => ({ name, quantity, stationIds: [], unitPrice: Math.round((shillings * 100) / quantity), lineTotal: shillings * 100, units: [] }));
const shopTotal = shopLines.reduce((a, l) => a + l.lineTotal, 0);   // 1,460.00
const shop = {
  business: { ...business, name: 'Demo Mini Mart', branchName: 'Main Street', thankYouMessage: 'Thank you, come again!' },
  order: {
    billNumber: 'T1-2207', orderType: 'counter', cashierName: 'Amina', soldAt: new Date(2026, 9, 21, 17, 12, 40), kotCount: 0,
    lines: shopLines, total: shopTotal, payments: [{ label: 'M-Pesa', amount: 100000 }, { label: 'Cash', amount: shopTotal - 100000 }], changeGiven: 0,
  },
};

// A559: extras and notes on the kitchen ticket. A second demo order (Table 6): a burger with Extra Cheese and the
// cashier's note "No onions", and a Chips Masala "well done". Only its kitchen ticket is shown on the site.
const extrasCart = [
  { product: { id: 'p-burger', name: 'Chicken Burger', category_id: 'cat-burgers' }, quantity: 1, lineTotal: 720,
    selectedModifiers: [{ optionName: 'Extra Cheese', price: 70 }], note: 'No onions' },
  { product: { id: 'p-chips', name: 'Chips Masala', category_id: 'cat-sides' }, quantity: 1, lineTotal: 300, note: 'Well done' },
];
const extrasLines = extrasCart.map((l) => {
  const lineStationIds = stationsForCategory(l.product.category_id, ids, routing);
  const cents = Math.round(l.lineTotal * 100);
  return { name: l.product.name, quantity: l.quantity, stationIds: lineStationIds, note: l.note,
    unitPrice: Math.round(cents / l.quantity), lineTotal: cents, units: toUnits(l, ids, lineStationIds, routing) };
});
const extrasOrder = {
  billNumber: 'T1-1047', orderType: 'dine_in', tableNumber: '6', cashierName: 'Wanjiru',
  soldAt: new Date(2026, 9, 21, 12, 52, 30), kotCount: 1, lines: extrasLines,
  total: extrasLines.reduce((a, l) => a + l.lineTotal, 0), payments: [], changeGiven: 0,
};

const k = (s) => Math.round(s * 100);
const shift = {
  businessName: 'Mama Lishe Grill',
  branchName: 'Ngong Road',
  currencyCode: 'KES',
  cashierName: 'Wanjiru',
  shiftRef: 'S-0217',
  openedAt: new Date(2026, 9, 21, 7, 58),
  closedAt: new Date(2026, 9, 21, 22, 36),
  status: 'closed',
  byMethod: [
    { method: 'cash', orders: 41, amount: k(12550) },
    { method: 'mpesa', orders: 63, amount: k(26300) },
    { method: 'card', orders: 4, amount: k(2400) },
  ],
  orderCount: 108,
  grossSales: k(41250),
  voidCount: 1,
  openingFloat: k(2000),
  cashSales: k(12550),
  floatIn: 0,
  floatOut: 0,
  expectedCash: k(14550),
  countedCash: k(14200),
  variance: k(-350),
  printedAt: new Date(2026, 9, 21, 22, 37),
  footerCredit: 'Powered by ZapTill',
};

/** Every slip the site shows, on 80 mm paper (48 columns) and 58 mm paper (32 columns). */
export function renderSlips() {
  const out = { note: 'Generated by scripts/render-slips.mjs from shared/printing. Do not edit by hand.' };
  for (const mm of [80, 58]) {
    out[`sale${mm}`] = text(renderTicket({ order, business, station: receiptPreset('st-till', 'Till', mm) }));
    out[`kitchen${mm}`] = text(renderTicket({ order, business, station: kitchenPreset(KITCHEN, 'Kitchen', mm) }));
    out[`dispatch${mm}`] = text(renderTicket({ order, business, station: dispatchPreset(DISPATCH, 'Dispatch', mm) }));
    out[`close${mm}`] = text(renderShiftReport(shift, mm));
    out[`shop${mm}`] = text(renderTicket({ order: shop.order, business: shop.business, station: receiptPreset('st-till', 'Till', mm) }));
    out[`extras${mm}`] = text(renderTicket({ order: extrasOrder, business, station: kitchenPreset(KITCHEN, 'Kitchen', mm) }));
  }
  return out;
}

export const SLIPS_FILE = join(here, '../src/lib/slips.generated.json');

// Run directly: write the file. Imported (test/slips.test.mjs): only renderSlips() is used.
if (process.argv[1]?.endsWith('render-slips.mjs')) {
  const out = renderSlips();
  writeFileSync(SLIPS_FILE, JSON.stringify(out, null, 2) + '\n');
  for (const [name, t] of Object.entries(out)) {
    if (name === 'note') continue;
    console.log(`\n==== ${name} (${t.cols} columns)`);
    for (const l of t.lines) console.log((l.s ? `[${l.s}] ` : '') + (l.b ? '* ' : '') + l.t);
  }
}
