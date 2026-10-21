/**
 * kitchen-font.test — A543: kitchen tickets in the printer's smaller Font B; 'kitchen_font_a' brings Font A back.
 *
 * Owner, 2026-10-21: "change the font of the kitchen printer, packing is okay" — chose "Smaller / condensed font — the
 * printer's smaller Font B so long orders fit on less paper". And: "if the manager/owner adds address and social media on
 * the footer it should be the same font like the others" — every receipt line stays in Font A, normal size.
 *
 * Font B is 9x17 dots: 64 characters a line on 80 mm (576 dots), 42 on 58 mm (384). The kitchen ticket starts ESC M 1
 * (after ESC @, ESC t 0, ESC 3 24), resets ESC M 0 at the end, and its normal lines are 24 dots apart (ESC 3 24) — Font B's
 * 17-dot glyph at ESC 2 would leave the line height as it was. Dispatch (packing), receipts and the Z-report never
 * change: no ESC M byte, the committed out/*.bin.
 *
 * MUTATION-CHECKED (rule 10/23), each red on its own: Font B on dispatch too (`station.kind !== 'receipt'`) (2, 6);
 * kitchenFontA ignored (3); columnsFor('B') at 48 (1, 4); the ESC M 0 reset dropped (1, 7); ESC M 1 sent for every
 * document (2, 6); the dish-name width not halved at Font B (4); no ESC 3 24 on the kitchen ticket (1, 5).
 *
 * A547 (owner, 2026-10-21: "you can also finish the leftovers"): the two layout quirks A543 left alone are fixed, in
 * Font A and Font B — a wrapped dish name keeps the three spaces after its quantity (hangingWrap keeps the prefix and
 * wraps only the name, in width - 4), and a wrapped component / attribute / note keeps its indent on its first row
 * (indentedWrap). So 'kitchen_font_a' now reproduces the FIXED Font A ticket: out/kitchen-58-font-a.bin was regenerated
 * (the sample's 58 mm ticket wraps a dish name; the 80 mm one wraps nothing, its bytes are the pre-A543 ones still).
 * Section 8. MUTATION-CHECKED, each red on its own: hangingWrap back to wrap(text) (3, 4, 8); its width not less the
 * prefix (4, 8); indentedWrap back to subRow's first-row behaviour (3, 8); indentedWrap wrapping at cols (8).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderTicket, toEscPos, toPreview, kitchenPreset, dispatchPreset, receiptPreset, columnsFor, renderShiftReport,
  type PrintContext, type Document, type BusinessConfig,
} from '../src/index';
import { KITCHEN_FONT_B_LINE_SPACING_DOTS } from '../src/render';
import { order, business, KITCHEN, DISPATCH } from './fixture';
import { longOrder, productionPaperMm } from './a543-cases';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

const ESC = 0x1b, GS = 0x1d;
const FONT_B = [ESC, 0x4d, 1], FONT_A = [ESC, 0x4d, 0];
const optsOf = (ctx: PrintContext) => ({ cut: ctx.station.cutPaper, openDrawer: ctx.station.openCashDrawer, feedBeforeCut: ctx.station.feedBeforeCut });
const bytesOf = (ctx: PrintContext) => toEscPos(renderTicket(ctx), optsOf(ctx));
const textOf = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []));
const find = (buf: Buffer, seq: number[], from = 0) => {
  for (let i = from; i <= buf.length - seq.length; i++) if (seq.every((b, k) => buf[i + k] === b)) return i;
  return -1;
};
const count = (buf: Buffer, seq: number[]) => { let n = 0, i = -1; while ((i = find(buf, seq, i + 1)) >= 0) n++; return n; };
const committed = (name: string) => readFileSync(join(__dirname, '..', '..', 'out', `${name}.bin`));
const FONT_A_BIZ: BusinessConfig = { ...business, kitchenFontA: true };
const kitchen = (w: 58 | 80 = 80) => kitchenPreset(KITCHEN, 'Kitchen', w);

console.log('\n1. The kitchen ticket is Font B: ESC M 1 at the start, ESC M 0 at the end, 64 / 42 columns');
for (const w of [80, 58] as const) {
  const ctx: PrintContext = { order, business, station: kitchen(w) };
  const doc = renderTicket(ctx);
  const b = bytesOf(ctx);
  const want = w === 80 ? 64 : 42;
  ok(`${w}: columnsFor(${w}, 'B') = ${want}, and the document is laid out at it`, columnsFor(w, 'B') === want && doc.columns === want && doc.font === 'B');
  ok(`${w}: starts ESC @, ESC t 0, ESC 3 ${KITCHEN_FONT_B_LINE_SPACING_DOTS}, ESC M 1`,
    find(b, [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x33, KITCHEN_FONT_B_LINE_SPACING_DOTS, ...FONT_B]) === 0 && count(b, FONT_B) === 1);
  const lastLf = b.lastIndexOf(0x0a);
  const reset = find(b, FONT_A);
  const feed = b.lastIndexOf(Buffer.from([ESC, 0x64]));
  const cut = b.lastIndexOf(Buffer.from([GS, 0x56, 0x42, 0x00]));
  ok(`${w}: ESC M 0 once, after the last line, with the other resets, before the feed and the cut`,
    count(b, FONT_A) === 1 && reset > lastLf && reset > b.lastIndexOf(Buffer.from([ESC, 0x32])) && reset < feed && feed < cut
    && find(b, [ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x32, ...FONT_A]) === reset - 11);
  const widest = Math.max(...textOf(doc).map(t => t.length));
  ok(`${w}: the order line uses the Font B width (TAKEAWAY against the right margin at ${want})`,
    textOf(doc).some(t => t.length === want && t.startsWith('Order  T1--5718') && t.endsWith('TAKEAWAY')) && widest === want);
  ok(`${w}: the footer count centred on ${want}`, textOf(doc).includes(' '.repeat(Math.floor((want - '5 items to cook'.length) / 2)) + '5 items to cook'));
}

console.log('\n2. Dispatch (packing), receipts and the Z-report: Font A, no ESC M, the committed bytes');
{
  for (const [name, station] of [['dispatch-80', dispatchPreset(DISPATCH, 'Dispatch', 80)], ['receipt-80', receiptPreset('st-till', 'Till', 80)],
    ['receipt-58', receiptPreset('st-till', 'Till', 58)]] as const) {
    const b = bytesOf({ order, business, station });
    ok(`${name}: no ESC M, the same with the switch on, the committed ${name}.bin`,
      count(b, [ESC, 0x4d]) === 0 && b.equals(bytesOf({ order, business: FONT_A_BIZ, station })) && b.equals(committed(name)));
    ok(`${name}: laid out at Font A (${columnsFor(station.paperWidthMm)})`, renderTicket({ order, business, station }).columns === columnsFor(station.paperWidthMm)
      && renderTicket({ order, business, station }).font === undefined);
  }
  const z = renderShiftReport({ businessName: 'B', currencyCode: 'KES', cashierName: 'A', shiftRef: 'x', openedAt: new Date(0), closedAt: new Date(0),
    status: 'closed', byMethod: [], orderCount: 0, grossSales: 0, voidCount: 0, openingFloat: 0, cashSales: 0, floatIn: 0, floatOut: 0,
    expectedCash: 0, printedAt: new Date(0) } as any, 80);
  ok('the Z-report: Font A, 48 columns, no ESC M', z.columns === 48 && z.font === undefined && count(toEscPos(z, { cut: true }), [ESC, 0x4d]) === 0);
}

console.log('\n3. kitchen_font_a: the kitchen ticket in Font A as before A543, with A547\'s layout fixes');
for (const w of [80, 58] as const) {
  const ctx: PrintContext = { order, business: FONT_A_BIZ, station: kitchen(w) };
  const b = bytesOf(ctx);
  const doc = renderTicket(ctx);
  // A547: kitchen-58-font-a.bin is the pre-A543 ticket with its wrapped dish name's quantity gap kept (the
  // regenerated bin); kitchen-80-font-a.bin wraps nothing and is still the pre-A543 kitchen-80.bin byte for byte.
  ok(`${w}: no ESC M, no ESC 3, Font A columns (${columnsFor(w)}), the committed kitchen-${w}-font-a.bin (A547's fixed Font A layout)`,
    count(b, [ESC, 0x4d]) === 0 && count(b, [ESC, 0x33]) === 0 && doc.columns === columnsFor(w) && doc.font === undefined
    && doc.lineSpacing === undefined && b.equals(committed(`kitchen-${w}-font-a`)));
  ok(`${w}: only a real true switches it (a stale "yes" is Font B)`,
    renderTicket({ order, business: { ...business, kitchenFontA: 'yes' as unknown as boolean }, station: kitchen(w) }).font === 'B');
}

console.log('\n4. Long dish names wrap at the Font B width; the double-height name has half of it');
{
  for (const w of [80, 58] as const) {
    const cols = columnsFor(w, 'B');
    const doc = renderTicket({ order: longOrder, business, station: kitchen(w) });
    const dish = doc.blocks.flatMap(b => (b.kind === 'text' && b.size === 'tall' && !b.text.includes('* *') ? [b.text] : []));
    // As before A543, at the new width: the name is wrapped at half the columns (render.ts's double-width allowance) and
    // each continuation hangs under the name (+4). A547: the first row keeps the three spaces after the quantity, and a
    // continuation no longer runs 4 past the half (the name is wrapped in half - 4).
    const half = Math.floor(cols / 2);
    ok(`${w}: the emphasised dish names wrap at ${half} (half of ${cols}), continuations hung under the name`,
      dish.length > 0 && dish.every(t => t.length <= half)
      && dish.some(t => t.length > columnsFor(w) / 2) && dish.some(t => t.startsWith('    ')), dish.join(' | '));
    ok(`${w}: "FAMILY FEAST BUCKET ..." wraps as words at ${half}`,
      JSON.stringify(dish.slice(0, 3)) === JSON.stringify(w === 80
        ? ['1   FAMILY FEAST BUCKET 12PC', '    WITH TWO LARGE SIDES', '2   GRILLED TILAPIA WHOLE FISH']
        : ['1   FAMILY FEAST', '    BUCKET 12PC WITH', '    TWO LARGE SIDES']), JSON.stringify(dish.slice(0, 3)));
    const flat = renderTicket({ order: longOrder, business, station: { ...kitchen(w), emphasizeParent: false } });
    const heads = textOf(flat).filter(t => /^\d+ {3}[A-Z]/.test(t));
    ok(`${w}: without emphasis the dish name has the full ${cols}`, heads.some(t => t.length > columnsFor(w)) && textOf(flat).every(t => t.length <= cols),
      heads.join(' | '));
    ok(`${w}: no line on the Font B ticket is wider than ${cols}`, textOf(doc).every(t => t.length <= cols));
  }
  const p = toPreview(renderTicket({ order: longOrder, business, station: kitchen(80) }), { showMargins: true }).split('\n');
  ok('the text preview is drawn at the Font B width (64 between the margins)', p[0] === '+' + '-'.repeat(64) + '+' && p.every(l => l.length === 66));
}

console.log('\n5. Line spacing: normal lines 24 dots apart, double-height lines at ESC 2; less paper on the long order');
{
  const b = bytesOf({ order: longOrder, business, station: kitchen(80) });
  // Every switch to a double-height line is preceded by ESC 2 and the next normal line goes back to ESC 3 24.
  const tallAt = find(b, [GS, 0x21, 0x01]);
  ok('a dish name (double height) prints at ESC 2, the next normal line at ESC 3 24',
    tallAt > 0 && find(b, [ESC, 0x32], tallAt) > tallAt && find(b, [ESC, 0x33, 24], tallAt) > find(b, [ESC, 0x32], tallAt));
  const st = kitchen(80);
  const before = renderTicket({ order: longOrder, business: FONT_A_BIZ, station: st });
  const after = renderTicket({ order: longOrder, business, station: st });
  const mmA = productionPaperMm(before, st.feedBeforeCut), mmB = productionPaperMm(after, st.feedBeforeCut);
  ok(`the long order: fewer lines (${textOf(before).length} -> ${textOf(after).length}) and less paper (${mmA.toFixed(0)} -> ${mmB.toFixed(0)} mm)`,
    textOf(after).length < textOf(before).length && mmB < mmA * 0.8);
}

console.log('\n6. The receipt\'s owner lines — address, social media — in the receipt\'s font and size like the others');
{
  const owner: BusinessConfig = { ...business, header: 'Moi Avenue, Nairobi\nIG: @tjspizza\nwww.tjspizza.co.ke',
    thankYouMessage: 'IG: @tjspizza\nwww.tjspizza.co.ke', deliveryMessage: 'Moi Avenue, Nairobi' };
  for (const w of [80, 58] as const) {
    const station = receiptPreset('st-till', 'Till', w);
    const b = bytesOf({ order, business: owner, station });
    ok(`${w}: no ESC M anywhere on the receipt (the kitchen switch on or off)`, count(b, [ESC, 0x4d]) === 0
      && b.equals(bytesOf({ order, business: { ...owner, kitchenFontA: true }, station })));
    // From the branch line (after the bold name) to the rule under Tel, and from the footer box to the credit: only text
    // and LF — no size, bold, font or alignment change around the owner's lines.
    const s = b.toString('latin1');
    const span = (at: number, to: string) => s.slice(at, s.indexOf(to, at) + to.length);
    const head = span(s.indexOf('Main Branch'), 'Tel: 0700 000 000');
    const foot = span(s.lastIndexOf('IG: @tjspizza'), 'Powered by ZapTill');
    const plain = (x: string) => x.length > 20 && [...x].every(c => c === '\n' || (c >= ' ' && c <= '~'));
    ok(`${w}: the header (branch, address, IG, web, PIN, Tel) is plain text and LF`, plain(head) && head.includes('Moi Avenue, Nairobi')
      && head.includes('IG: @tjspizza') && head.includes('www.tjspizza.co.ke'), JSON.stringify(head));
    ok(`${w}: the footer (IG, web, address, closing, credit) is plain text and LF`, plain(foot) && foot.includes('www.tjspizza.co.ke')
      && foot.includes('Moi Avenue, Nairobi') && foot.includes('Thank you for your business!'), JSON.stringify(foot));
    const doc = renderTicket({ order, business: owner, station });
    const ownerBlocks = doc.blocks.filter(x => x.kind === 'text' && /Moi Avenue|tjspizza/.test(x.text));
    ok(`${w}: each owner line is normal size, not bold, like the Tel line`, ownerBlocks.length === 6
      && ownerBlocks.every(x => x.kind === 'text' && x.size === 'normal' && !x.bold));
  }
}

console.log('\n7. A kitchen ticket then a receipt on the same printer: the receipt starts in Font A');
{
  const k = bytesOf({ order, business, station: kitchen(80) });
  const r = bytesOf({ order, business, station: receiptPreset('st-till', 'Till', 80) });
  const both = Buffer.concat([k, r]);
  const lastB = both.lastIndexOf(Buffer.from(FONT_B)), lastA = both.lastIndexOf(Buffer.from(FONT_A));
  ok('the kitchen ticket\'s last font command is ESC M 0, before its cut', lastA > lastB && lastA < k.length
    && k.subarray(lastA, lastA + 3).equals(Buffer.from(FONT_A)) && find(k, [GS, 0x56, 0x42, 0x00], lastA) > lastA);
  ok('the receipt that follows begins with ESC @ (Font A by itself) and never asks for Font B', r[0] === ESC && r[1] === 0x40
    && find(both, FONT_B, k.length) === -1);
}

console.log('\n8. A547: a wrapped dish name keeps its quantity gap; a wrapped component keeps its indent (Font A and Font B)');
{
  for (const fontA of [false, true]) {
    for (const w of [80, 58] as const) {
      const f = fontA ? 'Font A' : 'Font B';
      const cols = columnsFor(w, fontA ? 'A' : 'B');
      const biz = fontA ? FONT_A_BIZ : business;
      const flat = textOf(renderTicket({ order: longOrder, business: biz, station: { ...kitchen(w), emphasizeParent: false } }));
      const tall = textOf(renderTicket({ order: longOrder, business: biz, station: kitchen(w) }));
      for (const [how, rows, width] of [['flat', flat, cols], ['tall', tall, Math.floor(cols / 2)]] as const) {
        // Every dish heading, wrapped or not, is "<qty>   <NAME>", never "<qty> <NAME>".
        const heads = rows.filter(t => /^\d+ +[A-Z]/.test(t));
        ok(`${f} ${w} ${how}: every dish name keeps the three spaces after its quantity`,
          heads.length === 6 && heads.every(t => /^\d+ {3}[A-Z]/.test(t)), heads.join(' | '));
        const fam = rows.findIndex(t => t.startsWith('1   FAMILY'));
        ok(`${f} ${w} ${how}: the long name wraps, its rows within ${width}, the continuation hung under the name`,
          fam >= 0 && ('Family Feast Bucket 12PC With Two Large Sides'.length + 4 <= width || /^ {4}\S/.test(rows[fam + 1] ?? ''))
          && rows.filter(t => /^\d+ {3}[A-Z]|^ {4}\S/.test(t)).every(t => t.length <= width), rows.slice(fam, fam + 3).join(' | '));
      }
      // Components: 6 spaces in on every row, the first row of a wrapped one included; no row past the paper.
      const coleslaw = flat.findIndex(t => t.includes('Large Coleslaw'));
      ok(`${f} ${w}: a wrapped component's first row starts 6 spaces in`, coleslaw >= 0 && /^ {6}Large Coleslaw/.test(flat[coleslaw]), flat[coleslaw]);
      ok(`${f} ${w}: no ticket row is wider than ${cols}`, flat.every(t => t.length <= cols) && tall.every(t => t.length <= cols));
      if (w === 58) {
        // 58 mm wraps "Sukuma Wiki Fried With Onions And Tomatoes" in both fonts: both rows 6 in, every word kept.
        const s = flat.findIndex(t => t.includes('Sukuma Wiki Fried'));
        ok(`${f} 58: the wrapped component's rows are both 6 spaces in, the words all there`,
          s >= 0 && /^ {6}\S/.test(flat[s]) && /^ {6}\S/.test(flat[s + 1] ?? '')
          && `${flat[s]} ${flat[s + 1]}`.replace(/\s+/g, ' ').trim() === 'Sukuma Wiki Fried With Onions And Tomatoes', `${flat[s]} | ${flat[s + 1]}`);
      }
      const note = flat.findIndex(t => t.includes('** Cut the chicken'));
      ok(`${f} ${w}: the dish's note row starts 6 spaces in`, note >= 0 && /^ {6}\*\* Cut/.test(flat[note]), flat[note]);
    }
  }
  // The 58 mm Font A sample ticket wraps a tall dish name ("1 3PC CHICKEN" before A547): the regenerated
  // kitchen-58-font-a.bin prints "1   3PC CHICKEN" / "    COMBO" (and "2   WINGS COMBO") — its only change (+4 bytes).
  const rows = textOf(renderTicket({ order, business: FONT_A_BIZ, station: kitchen(58) }));
  const k58 = committed('kitchen-58-font-a').toString('latin1');
  ok("kitchen-58-font-a: the sample's wrapped names keep their gap, and that is the committed bin",
    rows.includes('1   3PC CHICKEN') && rows.includes('    COMBO') && k58.includes('1   3PC CHICKEN') && !k58.includes('1 3PC')
    && bytesOf({ order, business: FONT_A_BIZ, station: kitchen(58) }).equals(committed('kitchen-58-font-a')), rows.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
