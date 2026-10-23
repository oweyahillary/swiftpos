/**
 * receipt-kots-shop.test — A580: no "Kots: 0" on a shop's receipt.
 *
 * Owner, 2026-10-23 (on A573's leftovers): a shop has no kitchen, so its customer receipt does not carry the Kots line
 * (how many kitchen tickets the order made). `business.kitchenTickets === false` (the caller's answer from the business
 * type: retail, minimart, petrol_station, parking, other) leaves it out; absent or true — a restaurant or a café, or a
 * type not known yet — prints it exactly as before, byte for byte (the golden bytes are unchanged: bytes.js --check).
 * The compact opt-in never printed it.
 *
 * MUTATION-CHECKED: the render's `business.kitchenTickets !== false` dropped → 1 fails; the check inverted → 2 fails.
 */
import { renderTicket, toEscPos, receiptPreset, type PrintContext, type BusinessConfig } from '../src/index';
import { order, business } from './fixture';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const st = (w: 58 | 80) => receiptPreset('st-till', 'Till', w);
const bytesOf = (ctx: PrintContext) => toEscPos(renderTicket(ctx), { cut: ctx.station.cutPaper, openDrawer: ctx.station.openCashDrawer,
  feedBeforeCut: ctx.station.feedBeforeCut });
const lines = (ctx: PrintContext) => renderTicket(ctx).blocks.flatMap(b => (b.kind === 'text' ? [b.text.trim()] : []));

console.log('\n1. a shop (kitchenTickets false): no Kots line, everything else as the restaurant\'s receipt');
for (const w of [80, 58] as const) {
  const shop: BusinessConfig = { ...business, kitchenTickets: false };
  const s = lines({ order, business: shop, station: st(w) });
  const r = lines({ order, business, station: st(w) });
  ok(`${w}: no "Kots:" line on the shop's receipt`, !s.some(t => /^Kots:/.test(t)), JSON.stringify(s.filter(t => /Kots/.test(t))));
  ok(`${w}: the restaurant's receipt has it`, r.some(t => /^Kots: /.test(t)));
  ok(`${w}: the only difference is that line`, JSON.stringify(r.filter(t => !/^Kots:/.test(t))) === JSON.stringify(s));
}

console.log('\n2. a restaurant / café (absent or true): the same bytes as before');
for (const w of [80, 58] as const) {
  const before = bytesOf({ order, business, station: st(w) });
  const withTrue = bytesOf({ order, business: { ...business, kitchenTickets: true }, station: st(w) });
  ok(`${w}: kitchenTickets true = absent, byte for byte`, before.equals(withTrue));
  ok(`${w}: and the bytes carry "Kots: "`, before.indexOf(Buffer.from('Kots: ', 'latin1')) >= 0);
  const shop = bytesOf({ order, business: { ...business, kitchenTickets: false }, station: st(w) });
  ok(`${w}: the shop's bytes do not`, shop.indexOf(Buffer.from('Kots', 'latin1')) < 0);
}

console.log('\n3. the compact opt-in never printed it (unchanged)');
{
  const compact: BusinessConfig = { ...business, receiptClassic: { compactLayout: true } };
  ok('compact restaurant: no Kots', !lines({ order, business: compact, station: st(80) }).some(t => /Kots/.test(t)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
