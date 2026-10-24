// Renders the site's receipts through the REAL print renderer (shared/printing), so the slips on the website are
// exactly what the thermal printer prints: the customer receipt, the kitchen and dispatch tickets, and the shift
// close (Z-report). Made-up demo data only: the FICTIONAL demo brands (src/assets/demo-brands: Mama Lishe Grill, Kijani
// Basket, Kifaru Fuel & Mart, Mvua Café), each with its receipt logo as the product stores it (logo_receipt, a mono1
// raster from scripts/make-brands.mjs) and prints it (business.logoRaster, A310/A530); never a client's.
//
// Run from apps/website after building shared/printing (cd shared/printing && npm run build):
//   node scripts/render-slips.mjs
// It writes src/lib/slips.generated.json, which src/components/screens/Receipt.astro reads.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(join(here, '../../../shared/printing/dist/index.js'));
const { renderTicket, toPreview, kitchenPreset, dispatchPreset, receiptPreset, renderShiftReport, toUnits, stationsForCategory, monoRasterFromString } = P;
const RASTERS = JSON.parse(readFileSync(join(here, '../src/lib/demo-brands.rasters.json'), 'utf8'));
const logo = (id) => monoRasterFromString(RASTERS[id]) ?? undefined;

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
  header: 'Nyama choma & more',
  logoRaster: logo('mama-lishe-grill'),
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
function lines(doc, logoId) {
  const cols = doc.columns;
  const out = [];
  for (const b of doc.blocks) {
    if (b.kind === 'feed') { for (let i = 0; i < b.lines; i++) out.push({ t: '' }); continue; }
    if (b.kind === 'image') {
      // The logo: the preview's own tag line ("[logo 384x113]"), and which brand's printed logo the site draws there
      // (public/demo-brands/<id>-receipt.png is that same fitted raster, one pixel a dot).
      const tag = `[logo ${b.raster.width}x${b.raster.height}]`;
      out.push({ t: ' '.repeat(Math.max(0, Math.floor((cols - tag.length) / 2))) + tag.slice(0, cols), logo: logoId, w: b.raster.width, h: b.raster.height });
      continue;
    }
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
function text(doc, logoId) {
  const r = lines(doc, logoId);
  const spaced = (t) => t.replace(/^( *)(.*)$/, (_, sp, x) => sp + x.split('').join(' '));
  const ours = r.lines.map((l) => (l.s === 'wide' || l.s === 'large' ? spaced(l.t) : l.t));
  const theirs = toPreview(doc).split('\n').filter((l) => !/^=+$/.test(l)).map((l) => l.replace(/\s+$/, ''));
  while (theirs.length && !theirs[theirs.length - 1]) theirs.pop();
  if (ours.join('\n') !== theirs.join('\n')) {
    throw new Error('slip text differs from toPreview:\n' + ours.join('\n') + '\n---\n' + theirs.join('\n'));
  }
  return r;
}

// A shop sale: Kijani Basket's bill from the till shot (tools/till-shots, EXTRA=shop.js): milk, bread, flour, eggs and
// beef weighed at 0.640 kg (A577: "0.640 kg @ 650/kg"), paid by M-Pesa.
const shopLines = [
  ['Fresh Milk 500ml', 2, 130], ['White Bread 400g', 1, 65], ['Maize Flour 2kg', 1, 185], ['Eggs (tray of 30)', 1, 450],
].map(([name, quantity, shillings]) => ({ name, quantity, stationIds: [], unitPrice: Math.round((shillings * 100) / quantity), lineTotal: shillings * 100, units: [] }));
shopLines.push({ name: 'Beef (per kg)', quantity: 0.64, measureUnit: 'kg', stationIds: [], unitPrice: 65000, lineTotal: 41600, units: [] });
const shopTotal = shopLines.reduce((a, l) => a + l.lineTotal, 0);   // 1,246.00
const shop = {
  business: { ...business, name: 'Kijani Basket', branchName: 'Kahawa West', header: 'Fresh every morning', logoRaster: logo('kijani-basket'), kitchenTickets: false,
    thankYouMessage: 'Asante! Fresh again tomorrow.' },
  order: {
    billNumber: 'KW-2318', orderType: 'counter', cashierName: 'Kevin', soldAt: new Date(2026, 9, 21, 12, 44, 10), kotCount: 0,
    lines: shopLines, total: shopTotal, payments: [{ label: 'M-Pesa', amount: shopTotal }], changeGiven: 0,
  },
};

// A forecourt sale: Kifaru Fuel & Mart's bill from the pumps shot: KES 2,000 of diesel on Pump 3 (11.655 L at 171.60; fuel
// carries no unit on paper today, so it prints as "11.655 @ 171.60") with engine oil and water from the shop.
const fuelLines = [
  { name: 'Diesel', quantity: 11.655, stationIds: [], unitPrice: 17160, lineTotal: 200000, units: [] },
  { name: 'Engine Oil 1L', quantity: 1, stationIds: [], unitPrice: 85000, lineTotal: 85000, units: [] },
  { name: 'Water 1L', quantity: 1, stationIds: [], unitPrice: 7000, lineTotal: 7000, units: [] },
];
const fuelTotal = fuelLines.reduce((a, l) => a + l.lineTotal, 0);   // 2,920.00
const fuel = {
  business: { ...business, name: 'Kifaru Fuel & Mart', branchName: 'Thika Road', header: 'Fuel, food and the road ahead', logoRaster: logo('kifaru-fuel'), kitchenTickets: false,
    thankYouMessage: 'Asante! Safe journey.' },
  order: {
    billNumber: 'TR-0871', orderType: 'counter', cashierName: 'Brian', soldAt: new Date(2026, 9, 21, 7, 52, 30), kotCount: 0,
    lines: fuelLines, total: fuelTotal, payments: [{ label: 'M-Pesa', amount: fuelTotal }], changeGiven: 0,
  },
};

// A café's takeaway: Mvua Café, Kilimani.
const cafeLines = [['Cafe Latte', 2, 700], ['Masala Tea', 1, 150], ['Samosa (2)', 1, 120]]
  .map(([name, quantity, shillings]) => ({ name, quantity, stationIds: [], unitPrice: Math.round((shillings * 100) / quantity), lineTotal: shillings * 100, units: [] }));
const cafeTotal = cafeLines.reduce((a, l) => a + l.lineTotal, 0);   // 970.00
const cafe = {
  business: { ...business, name: 'Mvua Cafe', branchName: 'Kilimani', header: 'Coffee for every weather', logoRaster: logo('mvua-cafe'),
    thankYouMessage: 'Asante! See you when it rains.' },
  order: {
    billNumber: 'KL-0412', orderType: 'takeaway', cashierName: 'Achieng', soldAt: new Date(2026, 9, 21, 8, 15, 0), kotCount: 0,
    lines: cafeLines, total: cafeTotal, payments: [{ label: 'M-Pesa', amount: cafeTotal }], changeGiven: 0,
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
    out[`sale${mm}`] = text(renderTicket({ order, business, station: receiptPreset('st-till', 'Till', mm) }), 'mama-lishe-grill');
    out[`kitchen${mm}`] = text(renderTicket({ order, business, station: kitchenPreset(KITCHEN, 'Kitchen', mm) }));
    out[`dispatch${mm}`] = text(renderTicket({ order, business, station: dispatchPreset(DISPATCH, 'Dispatch', mm) }));
    out[`close${mm}`] = text(renderShiftReport(shift, mm));
    out[`shop${mm}`] = text(renderTicket({ order: shop.order, business: shop.business, station: receiptPreset('st-till', 'Till', mm) }), 'kijani-basket');
    out[`fuel${mm}`] = text(renderTicket({ order: fuel.order, business: fuel.business, station: receiptPreset('st-till', 'Till', mm) }), 'kifaru-fuel');
    out[`cafe${mm}`] = text(renderTicket({ order: cafe.order, business: cafe.business, station: receiptPreset('st-till', 'Till', mm) }), 'mvua-cafe');
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
