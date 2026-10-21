/**
 * receipt-compact.test — A530 made the receipt compact; A538 makes the classic (1.0.19) layout the standard again at
 * ~3.75 mm, with A530's compact layout an opt-in per client.
 *
 * Owner, 2026-10-19 (A530): "I feel the receipt is too long wasting paper." Owner, 2026-10-21 (A538), after printing the
 * compact receipt on a real printer: "I don't like how the print out looks, it feels congested everywhere — qty, subtotal,
 * ctl, vat, roundoff — top arrangement totally off." Chose: "go back to the old layout", "line spacing in the middle,
 * about 3.75 mm". The standard is now: classic layout, ESC 3 30 (~3.76 mm), the logo printed at <= 120 dots, 1 line fed
 * before a cut. Four switches in the admin portal (shared/posFeatures.ts), all OFF by default:
 *   receipt_compact_layout   A530's compact lines (Type + Bill, Cashier + time, no Kots, Round Off only when not zero,
 *                            Total only with a tip or fee, no Payment Detail heading, 5 rules) — opt-in
 *   receipt_classic_spacing  ESC 2 (1/6", ~4.23 mm) instead of ESC 3 30
 *   receipt_full_logo        the stored logo (up to 288 dots) instead of scaled to 120
 *   receipt_extra_feed       3 lines before the cut instead of 1
 *
 * Section 1 is the promise to a client who asks for the 1.0.19 receipt: with spacing + full logo + extra feed on (compact
 * off), every receipt in a530-cases.ts is the 1.0.19 renderer's bytes (test/golden/a530-classic.json). Section 7 is the
 * promise to a client who opts in to compact: the A530 renderer's own bytes (test/golden/a530-compact.json, written by it
 * before A538), with only its ESC 3 26 now ESC 3 30.
 *
 * MUTATION-CHECKED (rule 10/23), each red on its own: print Kots on the compact layout (2); drop the `tax.roundOff !== 0`
 * guard (2); print Total without a tip or fee (2); keep the "Payment Detail:" heading (2); emit ESC 2 at the start of a
 * receipt (3); drop the ESC 2 reset at the end (3); keep ESC 3 on a tall line (3); feed 1 on a tear-off printer (4);
 * nearest-neighbour instead of area sampling in fitMonoRaster, or a 50% ink share instead of 40% (5, the 2-dot stroke
 * case); drop the fullLogo check (6); ignore receipt_classic_layout (1, 6).
 * A538, each red on its own: the default back to compact (`full = classic.compactLayout === false`) (1b, 6, 7); the
 * spacing back to 26 (1b, 3, 7); the compact switch ignored (2, 6, 7); the old `layout` key read again (1b).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderTicket, toEscPos, toPreview, receiptPreset, kitchenPreset, dispatchPreset, splitTax, fitMonoRaster,
  monoRasterFromRGBA, monoRasterToAscii, bytesPerRow, RECEIPT_LOGO_MAX_HEIGHT, RECEIPT_LOGO_PRINT_MAX_HEIGHT,
  type PrintContext, type Document, type MonoRaster, type ReceiptClassic,
} from '../src/index';
import { rule } from '../src/layout';
import { INFO_GAP_DOTS } from '../src/render';
import { order, business, KITCHEN, DISPATCH } from './fixture';
import { cases, optsFor, bigLogo } from './a530-cases';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

/** A538: the 1.0.19 receipt — spacing, full logo and extra feed on; the classic layout is the standard (compact off). */
const CLASSIC: ReceiptClassic = { spacing: true, fullLogo: true, extraFeed: true };
/** A538: the compact opt-in, nothing else — A530's standard receipt, at the new spacing. */
const COMPACT: ReceiptClassic = { compactLayout: true };
const ESC = 0x1b, GS = 0x1d;
const bytesOf = (ctx: PrintContext) => toEscPos(renderTicket(ctx), optsFor(ctx));
const textOf = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []));
const paper = (ctx: PrintContext) => textOf(renderTicket(ctx)).map(t => t.trim());
const find = (buf: Buffer, seq: number[], from = 0) => {
  for (let i = from; i <= buf.length - seq.length; i++) if (seq.every((b, k) => buf[i + k] === b)) return i;
  return -1;
};
const count = (buf: Buffer, seq: number[]) => { let n = 0, i = -1; while ((i = find(buf, seq, i + 1)) >= 0) n++; return n; };
/** Every ESC 3 a with b (the A530 compact golden at A538's spacing). */
const respace = (buf: Buffer, a: number, b: number) => {
  const out = Buffer.from(buf);
  for (let i = 0; i + 2 < out.length; i++) if (out[i] === ESC && out[i + 1] === 0x33 && out[i + 2] === a) out[i + 2] = b;
  return out;
};
const st = (w: 58 | 80) => receiptPreset('st-till', 'Till', w);
const caseByName = (name: string, classic?: ReceiptClassic) => cases(classic).find(c => c.name === name)!.ctx;
const golden = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'golden', name), 'utf8')) as Record<string, string>;

console.log('\n1. Classic spacing + full logo + extra feed = the 1.0.19 receipt, byte for byte, except A539\'s payment block');
// A539 (owner, 2026-10-21): the payment block reads "Payment Details: Buy Goods - <n>", a rule, then the payments — on
// purpose different from 1.0.19 ("Payment Detail:", the payments, then the till line). Everything before the heading
// and everything from the block's closing rule on is still the 1.0.19 renderer's bytes (golden written by it).
{
  const g = golden('a530-classic.json');
  const all = cases(CLASSIC);
  ok('the golden covers every case', all.length === Object.keys(g).length && all.length >= 26, `${all.length} vs ${Object.keys(g).length}`);
  for (const c of all) {
    const got = bytesOf(c.ctx), want = Buffer.from(g[c.name] ?? '', 'base64');
    const ruleBytes = Buffer.from(rule(c.ctx.station.paperWidthMm === 80 ? 48 : 32), 'latin1');
    const hNew = got.indexOf(Buffer.from('Payment Details:', 'latin1'));
    const hOld = want.indexOf(Buffer.from('Payment Detail:', 'latin1'));
    if (hNew < 0 || hOld < 0) {   // a receipt with no payment block (none today) must still be 1.0.19 exactly
      ok(`classic ${c.name}`, got.equals(want), `no payment block, yet ${got.length} vs ${want.length} bytes`);
      continue;
    }
    // 1.0.19: the first rule after its heading closes the block. A539: the first is the new one under the heading.
    const closeOld = want.indexOf(ruleBytes, hOld);
    const closeNew = got.indexOf(ruleBytes, got.indexOf(ruleBytes, hNew) + ruleBytes.length);
    // A540 (owner, 2026-10-21): the thin gaps between the info lines (ESC J INFO_GAP_DOTS) and no "Round Off: 0.00" line
    // are the only other intended differences — take both out, and the rest before the block is still 1.0.19's bytes.
    const noGaps = (buf: Buffer) => {
      const out: number[] = [];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === ESC && buf[i + 1] === 0x4a && buf[i + 2] === INFO_GAP_DOTS) { i += 2; continue; }
        out.push(buf[i]);
      }
      return Buffer.from(out);
    };
    const noZeroRoundOff = (buf: Buffer) => {
      const at = buf.indexOf(Buffer.from('Round Off:', 'latin1'));
      if (at < 0) return buf;
      const end = buf.indexOf(0x0a, at);
      const lineText = buf.subarray(at, end).toString('latin1');
      return /\s0\.00$/.test(lineText) ? Buffer.concat([buf.subarray(0, at), buf.subarray(end + 1)]) : buf;
    };
    const before = noGaps(got.subarray(0, hNew)).equals(noZeroRoundOff(want.subarray(0, hOld)));
    const after = closeNew > 0 && closeOld > 0 && got.subarray(closeNew).equals(want.subarray(closeOld));
    ok(`classic ${c.name}: 1.0.19 bytes before the payment block and after it`, before && after,
      `before ${before ? 'same' : 'differs'}, after ${after ? 'same' : 'differs'}`);
  }
  // plain-80 / plain-58 are the 1.0.19 out/receipt-80.bin and receipt-58.bin exactly (checked when the golden was
  // written: 1781 and 1317 bytes, as the 1.0.19 SAMPLE-OUTPUT.txt headers say).
  ok('the golden\'s plain receipts are the 1.0.19 sample streams (1781 / 1317 bytes)',
    Buffer.from(g['plain-80'], 'base64').length === 1781 && Buffer.from(g['plain-58'], 'base64').length === 1317);
}

console.log('\n1b. A538: the standard (no switches) is the classic layout — every 1.0.19 line, ESC 3 30, small logo, 1-line feed');
for (const w of [80, 58] as const) {
  const p = paper({ order, business, station: st(w) });
  const has = (re: RegExp) => p.some(l => re.test(l));
  ok(`${w}: "Type: Takeaway" on its own line`, p.includes('Type: Takeaway'));
  ok(`${w}: "Bill No.: T1--5718" on its own line`, p.includes('Bill No.: T1--5718'));
  ok(`${w}: "Cashier: Amina" on its own line`, p.includes('Cashier: Amina'));
  ok(`${w}: "Date: 2026-08-05 19:42:11" on its own line`, p.includes('Date: 2026-08-05 19:42:11'));
  ok(`${w}: the Kots line`, has(/^Kots: \d+$/));
  // A539: "Payment Details: Buy Goods - 000000", a rule, then the payments and change; the till line is no longer under them.
  // 80 mm: one line. 58 mm (32 columns): it does not fit, so the heading and the number take a line each.
  const one = p.indexOf('Payment Details: Buy Goods - 000000');
  const two = p.indexOf('Payment Details:');
  const hd = w === 80 ? one : (p[two + 1] === 'Buy Goods - 000000' ? two + 1 : -1);
  ok(`${w}: A539 heading names the till number${w === 58 ? ' (on the next line on 58 mm)' : ''}`, hd >= 0, p.join(' | '));
  ok(`${w}: …then a rule, then the payments (CASH, CHANGE)`, /^-+$/.test(p[hd + 1] ?? '') && /^CASH\s/.test(p[hd + 2] ?? '')
    && /^CHANGE\s/.test(p[hd + 3] ?? '') && /^-+$/.test(p[hd + 4] ?? ''), p.slice(hd, hd + 5).join(' | '));
  ok(`${w}: no separate "Buy Goods: 000000" line any more`, !p.includes('Buy Goods: 000000'));
  // A540: no "Round Off: 0.00" on the standard receipt (a real round-off still prints — the round-off case below).
  ok(`${w}: no "Round Off: 0.00" (A540)`, !has(/^Round Off:\s+0\.00$/));
  {
    // A540: a thin gap (ESC J INFO_GAP_DOTS) between Bill No., Cashier, Date and Kots — three gaps for four lines.
    const blocks = renderTicket({ order, business, station: st(w) }).blocks;
    const at = (t: string) => blocks.findIndex(b => b.kind === 'text' && b.text.trim() === t);
    const between = (a: string, b: string) => blocks.slice(at(a) + 1, at(b)).filter(x => x.kind === 'gap').length;
    ok(`${w}: A540 thin gaps between Bill No., Cashier, Date and Kots`,
      between('Bill No.: T1--5718', 'Cashier: Amina') === 1 && between('Cashier: Amina', 'Date: 2026-08-05 19:42:11') === 1
        && between('Date: 2026-08-05 19:42:11', 'Kots: 2') === 1);
    const b = bytesOf({ order, business, station: st(w) });
    ok(`${w}: …sent as ESC J ${INFO_GAP_DOTS} (about 1.25 mm, not a blank line)`, count(b, [ESC, 0x4a, INFO_GAP_DOTS]) === 3);
  }
  {
    const r = cases().find(c => c.name === (w === 80 ? 'round-off-80' : 'round-off-58'));
    if (r) ok(`${w}: a real round-off still prints`, paper(r.ctx).some(l => /^Round Off:\s+-?0\.0[1-9]$/.test(l)), paper(r.ctx).join(' | '));
  }
  ok(`${w}: Total above PAY`, has(/^Total:\s+3,300\.00$/) && p.findIndex(l => l.startsWith('Total:')) < p.findIndex(l => l.startsWith('PAY:'))
    && p.includes('PAY: KES 3,300.00'));
  const rules = p.filter(l => /^-+$/.test(l)).length;
  ok(`${w}: the separate rules of the classic layout (12 with A539's, A530's compact has 5)`, rules === 12, `${rules}`);
  const doc = renderTicket({ order, business, station: st(w) });
  ok(`${w}: ESC 3 30 (~3.75 mm), a 1-line feed`, doc.lineSpacing === 30 && doc.cutFeed === 1);
  const b = bytesOf({ order, business, station: st(w) });
  ok(`${w}: the stream starts ESC @, ESC t 0, ESC 3 30`, find(b, [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x33, 30]) === 0);
}
{
  // Every case: the standard prints exactly the 1.0.19 lines (only the spacing, the logo's size and the feed differ).
  const std = cases(), old = cases(CLASSIC);
  const same = std.filter((c, i) => textOf(renderTicket(c.ctx)).join('\n') === textOf(renderTicket(old[i].ctx)).join('\n'));
  ok('every case: the standard\'s lines are the 1.0.19 lines', same.length === std.length, std.filter(c => !same.includes(c)).map(c => c.name).join(', '));
  // A538: a client who had A530's 'receipt_classic_layout' on — the old key is not read; they get the standard.
  const stale = { ...business, receiptClassic: { layout: true } as unknown as ReceiptClassic };
  ok('the retired `layout` key changes nothing (the standard receipt, byte for byte)',
    bytesOf({ order, business: stale, station: st(80) }).equals(bytesOf({ order, business, station: st(80) })));
}

console.log('\n2. The compact layout (receipt_compact_layout, opt-in) — what goes, what merges, what stays');
for (const w of [80, 58] as const) {
  const cols = w === 80 ? 48 : 32;
  const p = paper({ order, business: { ...business, receiptClassic: COMPACT }, station: st(w) });
  const has = (re: RegExp) => p.some(l => re.test(l));
  ok(`${w}: no Kots line (kitchen information)`, !has(/^Kots:/));
  ok(`${w}: no "Payment Detail:" heading`, !has(/^Payment Detail:/));
  ok(`${w}: no "Round Off: 0.00"`, !has(/^Round Off:/));
  ok(`${w}: no Total line when no tip and no fee (PAY carries it)`, !has(/^Total:/) && has(/^PAY: KES 3,300\.00$/));
  ok(`${w}: type and bill number on one line`, has(/^(Type: )?Takeaway\s+Bill No\.: T1--5718$/), p.slice(5, 8).join(' | '));
  ok(`${w}: cashier and time on one line`, has(w === 80 ? /^Cashier: Amina\s+2026-08-05 19:42:11$/ : /^Cashier: Amina\s+05\/08\/26 19:42$/));
  ok(`${w}: no separate "Date:" or "Bill No." line`, !has(/^Date:/) && !has(/^Bill No\./));
  const rules = p.filter(l => /^-+$/.test(l)).length;
  ok(`${w}: five rules (header, item heading, items, before PAY, before the closing block), was 11`, rules === 5, `${rules}`);
  for (const legal of ['Your Business', 'Main Branch', 'PIN: P051234567X', 'Tel: 0700 000 000', 'Item', '3PC Chicken Combo',
    'Wings Combo 8PC', 'Soda 500ml', 'Total Qty:', 'SubTotal:', 'CTL (2%)', 'VAT (16%)', 'PAY: KES', 'CASH', 'CHANGE',
    'Buy Goods: 000000', 'Thank you for your business!', 'For delivery call', 'TAX RECEIPT UPON REQUEST', 'Powered by ZapTill']) {
    ok(`${w}: keeps "${legal}"`, p.some(l => l.startsWith(legal)));
  }
  // A538: the standard (classic) layout prints the Voided line whole, as 1.0.19 did (on 58 mm the printer wraps it) —
  // only the compact layout wraps it (A530). Every other line fits on both.
  for (const c of [...cases().filter(x => x.name !== 'void-58'), ...cases(COMPACT)].filter(x => x.name.endsWith(`-${w}`))) {
    const wide = textOf(renderTicket(c.ctx)).filter(t => t.length > cols);
    ok(`${w}: ${c.name} — no line wider than ${cols} columns`, wide.length === 0, JSON.stringify(wide));
  }
  const tip = paper(caseByName(`tip-${w}`, COMPACT));
  ok(`${w}: with a tip — Total, Tip, then PAY`, tip.findIndex(l => l.startsWith('Total:')) >= 0
    && tip.findIndex(l => l.startsWith('Total:')) < tip.findIndex(l => l.startsWith('Tip:'))
    && tip.findIndex(l => l.startsWith('Tip:')) < tip.findIndex(l => l.startsWith('PAY:')));
  const fee = paper(caseByName(`delivery-fee-${w}`, COMPACT));
  ok(`${w}: with a delivery fee — Total, the fee, PAY; the rider kept`, fee.some(l => l.startsWith('Total:'))
    && fee.some(l => l.startsWith('Delivery fee:')) && fee.some(l => l === 'Delivery Boy: Otieno'));
  const free = paper(caseByName(`delivery-free-${w}`, COMPACT));
  ok(`${w}: a free delivery — "Delivery: FREE", no Total (PAY is the bill)`, free.some(l => /^Delivery:\s+FREE$/.test(l)) && !free.some(l => l.startsWith('Total:')));
  const ro = caseByName(`round-off-${w}`, COMPACT);
  const roundOff = splitTax(ro.order.lines.map(l => l.lineTotal), ro.order.total, 16, 2).roundOff;
  ok(`${w}: Round Off printed when it is not zero (${roundOff})`, roundOff !== 0 && paper(ro).some(l => l.startsWith('Round Off:')));
  const offer = paper(caseByName(`offer-${w}`, COMPACT));
  ok(`${w}: the offer and the discount kept`, offer.some(l => l.startsWith('Happy Hour:')) && offer.some(l => l.startsWith('Discount:')));
  const dine = paper(caseByName(`dine-in-note-${w}`, COMPACT));
  ok(`${w}: table and order note kept`, dine.includes('Table: 12') && dine.includes('Note: Birthday table'));
  const pro = paper(caseByName(`proforma-${w}`, COMPACT));
  ok(`${w}: a proforma bill — banner, type, no bill number`, pro.includes('BILL - NOT A RECEIPT') && pro.includes('Type: Takeaway') && !pro.some(l => /Bill No\./.test(l)));
  const dup = paper(caseByName(`duplicate-${w}`, COMPACT));
  ok(`${w}: a duplicate — banner and RePrint time kept`, dup.includes('Duplicate Print') && dup.some(l => l.startsWith('RePrint T.: 2026-08-05 21:06:09')));
  const vd = paper(caseByName(`void-${w}`, COMPACT));
  ok(`${w}: a void — banner and the Voided line kept`, vd.includes('VOID') && vd.join(' ').includes('Voided: 2026-08-05 20:01:00 by Manager Jane'));
  const zero = paper(caseByName(`zero-rated-${w}`, COMPACT));
  ok(`${w}: zero-rated — no TAX RECEIPT line, header lines kept`, !zero.includes('TAX RECEIPT UPON REQUEST') && zero.includes('Moi Avenue') && zero.includes('Nairobi'));
  const longName = paper(caseByName(`long-cashier-${w}`, COMPACT));
  ok(`${w}: a long cashier name — the name whole, the time still there`, longName.some(l => l.includes('Wanjiku Kamau-Njoroge')) && longName.some(l => /19:42/.test(l)));
}

console.log('\n3. Line spacing — ESC 3 30 on the receipt (A538), back to ESC 2 after; tickets untouched');
{
  const b = bytesOf({ order, business, station: st(80) });
  ok('starts ESC @, ESC t 0, ESC 3 30', find(b, [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x33, 30]) === 0);
  ok('no ESC 3 26 (A530\'s spacing) anywhere', count(b, [ESC, 0x33, 26]) === 0);
  const pay = find(b, Buffer.from('PAY:') as unknown as number[]);
  const before = b.subarray(0, pay), after = b.subarray(pay);
  ok('the tall PAY line goes at the default spacing (ESC 2 just before it)', before.lastIndexOf(Buffer.from([ESC, 0x32])) > before.lastIndexOf(Buffer.from([ESC, 0x33])));
  ok('and the next normal line is back at 30', find(after, [ESC, 0x33, 30]) > 0);
  const cut = b.lastIndexOf(Buffer.from([GS, 0x56, 0x42, 0x00]));
  const reset = b.lastIndexOf(Buffer.from([ESC, 0x32]));
  const feed = b.lastIndexOf(Buffer.from([ESC, 0x64]));
  ok('ESC 2 resets the spacing at the end, before the feed and the cut', reset > b.lastIndexOf(Buffer.from([ESC, 0x33])) && reset < feed && feed < cut);
  const compact = bytesOf({ order, business: { ...business, receiptClassic: COMPACT }, station: st(80) });
  ok('the compact opt-in is at the same ESC 3 30', find(compact, [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x33, 30]) === 0 && count(compact, [ESC, 0x33, 26]) === 0);
  const spaced = bytesOf({ order, business: { ...business, receiptClassic: { spacing: true } }, station: st(80) });
  ok('receipt_classic_spacing: ESC 2 at the start and no ESC 3 anywhere', find(spaced, [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x32]) === 0 && count(spaced, [ESC, 0x33]) === 0);
  for (const [name, station] of [['kitchen', kitchenPreset(KITCHEN, 'Kitchen')], ['dispatch', dispatchPreset(DISPATCH, 'Dispatch')],
    ['kitchen-58', kitchenPreset(KITCHEN, 'Kitchen', 58)]] as const) {
    // A543: a kitchen ticket is Font B at ESC 3 24 now (kitchen-font.test); with 'kitchen_font_a' it is the Font A ticket
    // these switches never touched — the committed kitchen-*-font-a.bin (the pre-A543 kitchen bytes with A547's layout fixes).
    const kb = name === 'dispatch' ? business : { ...business, kitchenFontA: true };
    const ctx = { order, business: kb, station };
    const t = bytesOf(ctx);
    ok(`${name}: no ESC 3, the same bytes with or without the switches, the committed ticket`,
      count(t, [ESC, 0x33]) === 0 && t.equals(bytesOf({ ...ctx, business: { ...kb, receiptClassic: CLASSIC } }))
      && t.equals(bytesOf({ ...ctx, business: { ...kb, receiptClassic: COMPACT } }))
      && t.equals(readFileSync(join(__dirname, '..', '..', 'out', `${name === 'kitchen' ? 'kitchen-80-font-a' : name === 'dispatch' ? 'dispatch-80' : 'kitchen-58-font-a'}.bin`))));
  }
}

console.log('\n4. The feed before the cut — 1 line when the printer cuts, 3 on a tear-off printer or with the switch');
{
  const tail = (b: Buffer) => b.subarray(b.lastIndexOf(Buffer.from([ESC, 0x64])));
  const cutting = bytesOf({ order, business, station: st(80) });
  ok('cutting: ESC d 1 then GS V 66 0', tail(cutting).equals(Buffer.from([ESC, 0x64, 1, GS, 0x56, 0x42, 0x00])));
  const tear = bytesOf({ order, business, station: { ...st(80), cutPaper: false } });
  ok('tear-off: ESC d 3 and no cut', tail(tear).equals(Buffer.from([ESC, 0x64, 3])) && count(tear, [GS, 0x56]) === 0);
  const extra = bytesOf({ order, business: { ...business, receiptClassic: { extraFeed: true } }, station: st(80) });
  ok('receipt_extra_feed: ESC d 3 then the cut', tail(extra).equals(Buffer.from([ESC, 0x64, 3, GS, 0x56, 0x42, 0x00])));
}

console.log('\n5. The logo — stored up to 288 dots, printed at 120, scaled down by area, not dropped to holes');
{
  // Owner, 2026-10-19 ("that's okay"): storage stays full size so 'receipt_full_logo' works for every logo, old or new.
  ok('stored up to 288 dots (36 mm), printed at 120 (15 mm)', RECEIPT_LOGO_MAX_HEIGHT === 288 && RECEIPT_LOGO_PRINT_MAX_HEIGHT === 120);
  const tallPx = new Uint8ClampedArray(100 * 960 * 4).fill(0);
  ok('a new upload is stored at up to 288 tall', monoRasterFromRGBA(tallPx, 100, 960).height === 288);
  const fresh = monoRasterFromRGBA(new Uint8ClampedArray(384 * 288 * 4).fill(0), 384, 288);
  const freshCtx = { ...caseByName('logo-80'), business: { ...business, logoRaster: fresh } };
  const printed = renderTicket(freshCtx).blocks.find(b => b.kind === 'image');
  const kept = renderTicket({ ...freshCtx, business: { ...freshCtx.business, receiptClassic: { fullLogo: true } } }).blocks.find(b => b.kind === 'image');
  ok('a NEW upload prints at 120, and at its full 288 with receipt_full_logo', printed?.kind === 'image' && printed.raster.height === 120
    && kept?.kind === 'image' && kept.raster.height === 288);
  const big = bigLogo();
  const small = fitMonoRaster(big, 384, 120);
  ok('288 tall becomes 120, aspect kept (300x288 -> 125x120)', small.height === 120 && small.width === 125, `${small.width}x${small.height}`);
  ok('packed for GS v 0', small.bytes.length === bytesPerRow(small.width) * small.height);
  const ink = (r: MonoRaster) => monoRasterToAscii(r).join('').split('').filter(ch => ch === '#').length / (r.width * r.height);
  ok('neither all white nor all black', ink(small) > 0.05 && ink(small) < 0.95, `${ink(small)}`);
  ok('the share of black is kept (within 15%)', Math.abs(ink(small) - ink(big)) / ink(big) < 0.15, `${ink(big).toFixed(3)} -> ${ink(small).toFixed(3)}`);
  const rows = monoRasterToAscii(small);
  ok('the ring is still a ring (black on its edge, white in its middle)', rows[46][62] === ' ' && rows[46].slice(0, 40).includes('#') && rows[46].slice(85).includes('#'));
  ok('the bar under it is unbroken', rows.some(r => r.slice(14, 110) === '#'.repeat(96)));
  // 2-dot black lines every 5 dots: 40% ink. Area sampling keeps them as grey-ish stripes or a tone; nearest neighbour
  // samples one dot in 2.4 and turns the pattern into arbitrary solid lines with gaps (it keeps or loses whole lines).
  const stripesPx = new Uint8ClampedArray(240 * 288 * 4);
  for (let y = 0; y < 288; y++) for (let x = 0; x < 240; x++) { const p = (y * 240 + x) * 4; const k = x % 5 < 2 ? 0 : 255; stripesPx[p] = stripesPx[p + 1] = stripesPx[p + 2] = k; stripesPx[p + 3] = 255; }
  const stripes = monoRasterFromRGBA(stripesPx, 240, 288, { maxHeight: 288 });
  const shrunk = fitMonoRaster(stripes, 384, 120);
  ok('fine detail is averaged, not sampled: every row of the stripes is the same', new Set(monoRasterToAscii(shrunk)).size === 1);
  // A 2-dot stroke at every position across a 12-dot period (all the phases a 2.4 scale has): area sampling keeps it
  // everywhere; nearest neighbour samples columns 0, 2, 4, 7, 9, 12, … and loses the stroke at 5-6, 10-11, 17-18, …
  const lost: number[] = [];
  for (let at = 0; at < 22; at++) {
    const px = new Uint8ClampedArray(24 * 288 * 4).fill(255);
    for (let y = 0; y < 288; y++) for (const x of [at, at + 1]) { const p = (y * 24 + x) * 4; px[p] = px[p + 1] = px[p + 2] = 0; }
    const line = fitMonoRaster(monoRasterFromRGBA(px, 24, 288, { maxHeight: 288 }), 384, 120);
    if (!monoRasterToAscii(line)[60].includes('#')) lost.push(at);
  }
  ok('a 2-dot stroke survives the shrink wherever it lies', lost.length === 0, `lost at ${lost.join(', ')}`);
  ok('a logo already within 120 is printed as it is (same object)', fitMonoRaster(small, 384, 120) === small);
  const wide = fitMonoRaster(big, 150, 288);
  ok('the width cap applies too (300 -> 150 wide)', wide.width === 150 && wide.height === 144, `${wide.width}x${wide.height}`);
  const img = (ctx: PrintContext) => renderTicket(ctx).blocks.find(b => b.kind === 'image');
  const stdImg = img(caseByName('logo-80'));
  ok('the standard receipt (A538: classic layout) prints the stored 288-dot logo at 120', stdImg?.kind === 'image' && stdImg.raster.height === 120);
  ok('the preview says so', toPreview(renderTicket(caseByName('logo-80'))).includes('[logo 125x120]'));
}

console.log('\n6. Each switch on its own changes its own part, and only that');
{
  const ctx = caseByName('logo-80');
  const withSw = (c: ReceiptClassic) => ({ ...ctx, business: { ...ctx.business, receiptClassic: c } });
  const fullImg = renderTicket(withSw({ fullLogo: true })).blocks.find(b => b.kind === 'image');
  ok('receipt_full_logo: the stored logo as it is (288 tall)', fullImg?.kind === 'image' && fullImg.raster.height === 288);
  const compactDoc = renderTicket(withSw(COMPACT));
  const compactFull = renderTicket(withSw({ compactLayout: true, fullLogo: true, spacing: true, extraFeed: true }));
  ok('receipt_compact_layout: the compact lines, whatever the other switches', textOf(compactDoc).join('\n') === textOf(compactFull).join('\n')
    && !textOf(compactDoc).some(t => t.startsWith('Kots:')));
  ok('receipt_compact_layout alone keeps the standard spacing, feed and logo', compactDoc.lineSpacing === 30 && compactDoc.cutFeed === 1
    && compactDoc.blocks.some(b => b.kind === 'image' && b.raster.height === 120));
  const spacingDoc = renderTicket(withSw({ spacing: true }));
  ok('receipt_classic_spacing alone: default spacing, classic layout', spacingDoc.lineSpacing === undefined && textOf(spacingDoc).some(t => t.startsWith('Kots:')));
  const feedDoc = renderTicket(withSw({ extraFeed: true }));
  ok('receipt_extra_feed alone: the caller\'s feed, classic layout, 3.75 mm', feedDoc.cutFeed === undefined && feedDoc.lineSpacing === 30
    && textOf(feedDoc).some(t => t.startsWith('Kots:')));
  const none = renderTicket(ctx);
  ok('no switches: classic layout, 3.75 mm, 1-line feed, small logo', none.lineSpacing === 30 && none.cutFeed === 1
    && textOf(none).some(t => t.startsWith('Kots:')) && none.blocks.some(b => b.kind === 'image' && b.raster.height === 120));
}

console.log('\n7. A538: the compact opt-in is A530\'s compact receipt (its renderer\'s bytes), at ESC 3 30 instead of 26');
{
  const g = golden('a530-compact.json');
  const all = cases(COMPACT);
  ok('the A530 compact golden covers every case', all.length === Object.keys(g).length && all.length >= 26, `${all.length} vs ${Object.keys(g).length}`);
  for (const c of all) {
    const want = Buffer.from(g[c.name] ?? '', 'base64');
    const got = bytesOf(c.ctx);
    ok(`compact ${c.name}`, count(want, [ESC, 0x33, 26]) > 0 && got.equals(respace(want, 26, 30)),
      `${got.length} vs ${want.length}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
