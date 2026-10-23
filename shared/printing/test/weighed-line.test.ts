/**
 * weighed-line.test — A577: a line sold by weight on the receipt and the kitchen ticket.
 *
 * Owner, 2026-10-23: items sold by weight (scale labels, the weight keypad) — the receipt prints "0.452 kg @ 650/kg".
 * A weighed line is ONE item on the receipt (its row's Qty is 1, "Total Qty" counts it once) with its weight and price
 * per kg on the row under it; the kitchen ticket heads it "0.750 kg   GOAT MEAT". A gram-shown item prints "452 g". A
 * fractional quantity without a unit (fuel, a line from before A577) is still printed as a measure, never as "0.452"
 * squeezed into the Qty column. Whole-number lines print exactly as before.
 *
 * MUTATION-CHECKED (each red on its own): isMeasured → false (1, 2, 3); totalQty adding line.quantity for a measured
 * line (2); the measure row not printed (1); measureText ignoring 'g' (4); the kitchen prefix line.quantity (3).
 */
import { renderTicket, kitchenPreset, receiptPreset, type Document, type OrderLine, type PrintContext } from '../src/index';
import { order as sampleOrder, business, KITCHEN } from './fixture';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const textOf = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []));
const rows = (ctx: PrintContext) => textOf(renderTicket(ctx));

const beef: OrderLine = { name: 'Beef steak', quantity: 0.452, measureUnit: 'kg', unitPrice: 65000, lineTotal: 29380,
  stationIds: [], units: [] };
const goat: OrderLine = { name: 'Goat meat', quantity: 0.75, measureUnit: 'kg', unitPrice: 120000, lineTotal: 90000,
  stationIds: [KITCHEN], units: [] };
const sweets: OrderLine = { name: 'Loose sweets', quantity: 0.125, measureUnit: 'g', unitPrice: 80000, lineTotal: 10000,
  stationIds: [], units: [] };
const soda: OrderLine = { name: 'Soda 500ml', quantity: 2, unitPrice: 8000, lineTotal: 16000, stationIds: [], units: [] };
const fuel: OrderLine = { name: 'Diesel', quantity: 20.5, unitPrice: 18000, lineTotal: 369000, stationIds: [], units: [] };
const total = (ls: OrderLine[]) => ls.reduce((s, l) => s + l.lineTotal, 0);
const orderOf = (ls: OrderLine[]) => ({ ...sampleOrder, lines: ls, total: total(ls), discount: 0, offers: undefined,
  payments: [{ label: 'CASH', amount: total(ls) }], changeGiven: 0 });

console.log('\n1. The receipt: one item, "0.452 kg @ 650/kg" under it');
for (const w of [80, 58] as const) {
  const r = rows({ order: orderOf([beef, soda]), business, station: receiptPreset('st-till', 'Till', w) });
  const at = r.findIndex(t => t.startsWith('Beef steak'));
  ok(`${w}: the item row's Qty is 1 (not "0.452")`, at >= 0 && /\s1\s+\d[\d,]*\.\d\d$/.test(r[at]) && !r[at].includes('0.452'), r[at]);
  ok(`${w}: the weight and the price per kg on the row under it`, r[at + 1]?.trim() === '0.452 kg @ 650/kg', r[at + 1]);
  ok(`${w}: Total Qty counts the weighed line once (1 + 2 sodas = 3)`, r.some(t => /^Total Qty:\s+3$/.test(t)), r.join(' | '));
  ok(`${w}: the soda prints as before (Qty 2, no measure row)`, r.some(t => t.startsWith('Soda 500ml') && /\s2\s+\d/.test(t))
    && !r.some(t => /2 @/.test(t)), r.join(' | '));
}

console.log('\n2. A fractional quantity with no unit (fuel) is a measure too');
{
  const r = rows({ order: orderOf([fuel]), business, station: receiptPreset('st-till', 'Till', 80) });
  const at = r.findIndex(t => t.startsWith('Diesel'));
  ok('"20.5 @ 180" under it, Qty 1, Total Qty 1', r[at + 1]?.trim() === '20.5 @ 180' && /\s1\s+\d/.test(r[at])
    && r.some(t => /^Total Qty:\s+1$/.test(t)), r.join(' | '));
}

console.log('\n3. The kitchen ticket: "0.750 kg   GOAT MEAT"');
for (const w of [80, 58] as const) {
  const k = rows({ order: orderOf([goat]), business, station: kitchenPreset(KITCHEN, 'Kitchen', w) });
  ok(`${w}: the weight heads the dish`, k.some(t => t.startsWith('0.750 kg   GOAT MEAT')), k.join(' | '));
}

console.log('\n4. An item shown in grams');
{
  const r = rows({ order: orderOf([sweets]), business, station: receiptPreset('st-till', 'Till', 80) });
  ok('"125 g @ 800/kg"', r.some(t => t.trim() === '125 g @ 800/kg'), r.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
