/**
 * kitchen-font.test — the kitchen ticket's font. A543 made it the printer's smaller Font B with 'kitchen_font_a' to opt
 * out; A551 (owner, 2026-10-21, on paper: "kitchen receipt use the same font as the despatcher") makes Font A — the
 * dispatch ticket's font, size and columns — the standard again, and Font B the 'kitchen_font_b' opt-in.
 *
 * Owner, 2026-10-21 (A543): "change the font of the kitchen printer, packing is okay" — chose "Smaller / condensed font —
 * the printer's smaller Font B so long orders fit on less paper". And: "if the manager/owner adds address and social media
 * on the footer it should be the same font like the others" — every receipt line stays in Font A, normal size.
 *
 * Font B is 9x17 dots: 64 characters a line on 80 mm (576 dots), 42 on 58 mm (384). The Font B ticket starts ESC M 1
 * (after ESC @, ESC t 0, ESC 3 24), resets ESC M 0 at the end, and its normal lines are 24 dots apart (ESC 3 24) — Font B's
 * 17-dot glyph at ESC 2 would leave the line height as it was. The Font A ticket (the standard, and dispatch), receipts
 * and the Z-report send no ESC M byte.
 *
 * MUTATION-CHECKED (rule 10/23), A543's, each red on its own: Font B on dispatch too (2, 6); the switch ignored (3);
 * columnsFor('B') at 48 (1, 4); the ESC M 0 reset dropped (1, 7); ESC M 1 sent for every document (2, 6); no ESC 3 24 on
 * the Font B ticket (1, 5).
 * A551, each red on its own: the default back to Font B (`kitchenFontB !== false`) (1, 3, 9); the retired kitchenFontA
 * read again (3); the emphasised dish name wrapped at half the line again (4, 8, 9).
 *
 * A547 (owner, 2026-10-21: "you can also finish the leftovers"): a wrapped dish name keeps the three spaces after its
 * quantity (hangingWrap keeps the prefix and wraps only the name, in width - 4), and a wrapped component / attribute /
 * note keeps its indent on its first row (indentedWrap). Section 8. MUTATION-CHECKED, each red on its own: hangingWrap
 * back to wrap(text) (3, 4, 8); its width not less the prefix (4, 8); indentedWrap back to subRow's first-row behaviour
 * (3, 8); indentedWrap wrapping at cols (8).
 *
 * A551 (section 9): the standard kitchen ticket is A543's 'kitchen_font_a' ticket (out/kitchen-*-font-a.bin before
 * A551, test/golden/a551-pre.json), the 'kitchen_font_b' ticket is A543's standard (out/kitchen-*.bin before A551), and
 * dispatch is its pre-A551 bytes — each with only A551's changes: a thin gap between items instead of a blank line, one
 * line fed before the cut instead of three, and (58 mm) the double-height dish name on the whole line.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderTicket, toEscPos, toPreview, kitchenPreset, dispatchPreset, receiptPreset, columnsFor, renderShiftReport,
  type PrintContext, type Document, type BusinessConfig, type Block,
} from '../src/index';
import { KITCHEN_FONT_B_LINE_SPACING_DOTS, ITEM_GAP_DOTS, PRODUCTION_CUT_FEED } from '../src/render';
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
const pre = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'golden', 'a551-pre.json'), 'utf8')) as Record<string, string>;
const preBytes = (name: string) => Buffer.from(pre[name], 'base64');
const FONT_B_BIZ: BusinessConfig = { ...business, kitchenFontB: true };
const kitchen = (w: 58 | 80 = 80) => kitchenPreset(KITCHEN, 'Kitchen', w);

console.log('\n1. kitchen_font_b: the kitchen ticket in Font B — ESC M 1 at the start, ESC M 0 at the end, 64 / 42 columns');
for (const w of [80, 58] as const) {
  const ctx: PrintContext = { order, business: FONT_B_BIZ, station: kitchen(w) };
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
  ok(`${w}: the committed kitchen-${w}-font-b.bin`, b.equals(committed(`kitchen-${w}-font-b`)));
}

console.log('\n2. Dispatch (packing), receipts and the Z-report: Font A, no ESC M, the committed bytes, whatever the switch');
{
  for (const [name, station] of [['dispatch-80', dispatchPreset(DISPATCH, 'Dispatch', 80)], ['receipt-80', receiptPreset('st-till', 'Till', 80)],
    ['receipt-58', receiptPreset('st-till', 'Till', 58)]] as const) {
    const b = bytesOf({ order, business, station });
    ok(`${name}: no ESC M, the same with the switch on, the committed ${name}.bin`,
      count(b, [ESC, 0x4d]) === 0 && b.equals(bytesOf({ order, business: FONT_B_BIZ, station })) && b.equals(committed(name)));
    ok(`${name}: laid out at Font A (${columnsFor(station.paperWidthMm)})`, renderTicket({ order, business, station }).columns === columnsFor(station.paperWidthMm)
      && renderTicket({ order, business, station }).font === undefined);
  }
  const z = renderShiftReport({ businessName: 'B', currencyCode: 'KES', cashierName: 'A', shiftRef: 'x', openedAt: new Date(0), closedAt: new Date(0),
    status: 'closed', byMethod: [], orderCount: 0, grossSales: 0, voidCount: 0, openingFloat: 0, cashSales: 0, floatIn: 0, floatOut: 0,
    expectedCash: 0, printedAt: new Date(0) } as any, 80);
  ok('the Z-report: Font A, 48 columns, no ESC M', z.columns === 48 && z.font === undefined && count(toEscPos(z, { cut: true }), [ESC, 0x4d]) === 0);
}

console.log('\n3. A551: the standard kitchen ticket is Font A — the dispatch ticket\'s font, size and columns');
for (const w of [80, 58] as const) {
  const ctx: PrintContext = { order, business, station: kitchen(w) };
  const b = bytesOf(ctx);
  const doc = renderTicket(ctx);
  const disp = renderTicket({ order, business, station: dispatchPreset(DISPATCH, 'Dispatch', w) });
  ok(`${w}: no ESC M, no ESC 3, Font A columns (${columnsFor(w)}) as dispatch, the committed kitchen-${w}.bin`,
    count(b, [ESC, 0x4d]) === 0 && count(b, [ESC, 0x33]) === 0 && doc.columns === columnsFor(w) && doc.columns === disp.columns
    && doc.font === undefined && disp.font === undefined && doc.lineSpacing === undefined && b.equals(committed(`kitchen-${w}`)));
  ok(`${w}: only a real true picks Font B (a stale "yes" is Font A)`,
    renderTicket({ order, business: { ...business, kitchenFontB: 'yes' as unknown as boolean }, station: kitchen(w) }).font === undefined);
  // A client that had A543's 'kitchen_font_a' on: the key is retired, and Font A is what it asked for.
  const stale = { ...business, kitchenFontA: true } as unknown as BusinessConfig;
  ok(`${w}: A543's retired kitchenFontA changes nothing (Font A, the same bytes)`, bytesOf({ ...ctx, business: stale }).equals(b));
  ok(`${w}: …and kitchenFontA: false does not bring Font B back`,
    bytesOf({ ...ctx, business: { ...business, kitchenFontA: false } as unknown as BusinessConfig }).equals(b));
}

console.log('\n4. Long dish names wrap at the ticket\'s width; the double-height name has the whole line (A551)');
{
  for (const [f, biz] of [['Font A', business], ['Font B', FONT_B_BIZ]] as const) {
    for (const w of [80, 58] as const) {
      const cols = columnsFor(w, f === 'Font B' ? 'B' : 'A');
      const doc = renderTicket({ order: longOrder, business: biz, station: kitchen(w) });
      const dish = doc.blocks.flatMap(b => (b.kind === 'text' && b.size === 'tall' && !b.text.includes('* *') ? [b.text] : []));
      // A551: 'tall' is GS ! 0x01 — double height, single width — so the name is wrapped at the whole line, not at half
      // (A543/A547 halved it as if it were double width). Each continuation hangs under the name (+4, A547).
      ok(`${f} ${w}: the emphasised dish names wrap at ${cols}, continuations hung under the name`,
        dish.length > 0 && dish.every(t => t.length <= cols) && dish.some(t => t.length > Math.floor(cols / 2)),
        dish.join(' | '));
      ok(`${f} ${w}: the double-height dish names are size 'tall' (GS ! 0x01, one column a character)`,
        doc.blocks.every(b => b.kind !== 'text' || b.size !== 'large' && b.size !== 'wide'));
      const flat = renderTicket({ order: longOrder, business: biz, station: { ...kitchen(w), emphasizeParent: false } });
      ok(`${f} ${w}: emphasised or not, a dish name wraps the same way`,
        JSON.stringify(textOf(flat).filter(t => /^\d+ {3}[A-Z]|^ {4}[A-Z]/.test(t)).slice(0, 2))
          === JSON.stringify(dish.slice(0, 2)), `${textOf(flat).slice(5, 7).join(' | ')} vs ${dish.slice(0, 2).join(' | ')}`);
      ok(`${f} ${w}: no line on the ticket is wider than ${cols}`, textOf(doc).every(t => t.length <= cols));
    }
  }
  const head = (w: 58 | 80, biz: BusinessConfig) => renderTicket({ order: longOrder, business: biz, station: kitchen(w) }).blocks
    .flatMap(b => (b.kind === 'text' && b.size === 'tall' && !b.text.includes('* *') ? [b.text] : [])).slice(0, 2);
  ok('Font A 80: "FAMILY FEAST BUCKET 12PC WITH TWO LARGE" / "SIDES" (was 4 rows at 24)',
    JSON.stringify(head(80, business)) === JSON.stringify(['1   FAMILY FEAST BUCKET 12PC WITH TWO LARGE', '    SIDES']), JSON.stringify(head(80, business)));
  ok('Font B 80: the whole name on one row',
    JSON.stringify(head(80, FONT_B_BIZ)) === JSON.stringify(['1   FAMILY FEAST BUCKET 12PC WITH TWO LARGE SIDES', '2   GRILLED TILAPIA WHOLE FISH SERVED WITH UGALI AND SUKUMA WIKI']),
    JSON.stringify(head(80, FONT_B_BIZ)));
  const p = toPreview(renderTicket({ order: longOrder, business: FONT_B_BIZ, station: kitchen(80) }), { showMargins: true }).split('\n');
  ok('the Font B text preview is drawn at the Font B width (64 between the margins)', p[0] === '+' + '-'.repeat(64) + '+' && p.every(l => l.length === 66));
}

console.log('\n5. Font B line spacing: normal lines 24 dots apart, double-height lines at ESC 2; less paper on the long order');
{
  const b = bytesOf({ order: longOrder, business: FONT_B_BIZ, station: kitchen(80) });
  // Every switch to a double-height line is preceded by ESC 2 and the next normal line goes back to ESC 3 24.
  const tallAt = find(b, [GS, 0x21, 0x01]);
  ok('a dish name (double height) prints at ESC 2, the next normal line at ESC 3 24',
    tallAt > 0 && find(b, [ESC, 0x32], tallAt) > tallAt && find(b, [ESC, 0x33, 24], tallAt) > find(b, [ESC, 0x32], tallAt));
  const st = kitchen(80);
  const fontA = renderTicket({ order: longOrder, business, station: st });
  const fontB = renderTicket({ order: longOrder, business: FONT_B_BIZ, station: st });
  const mmA = productionPaperMm(fontA, st.feedBeforeCut), mmB = productionPaperMm(fontB, st.feedBeforeCut);
  ok(`the long order: fewer lines (${textOf(fontA).length} -> ${textOf(fontB).length}) and less paper (${mmA.toFixed(0)} -> ${mmB.toFixed(0)} mm) in Font B`,
    textOf(fontB).length < textOf(fontA).length && mmB < mmA * 0.85);
}

console.log('\n6. The receipt\'s owner lines — address, social media — in the receipt\'s font and size like the others');
{
  const owner: BusinessConfig = { ...business, header: 'Moi Avenue, Nairobi\nIG: @tjspizza\nwww.tjspizza.co.ke',
    thankYouMessage: 'IG: @tjspizza\nwww.tjspizza.co.ke', deliveryMessage: 'Moi Avenue, Nairobi' };
  for (const w of [80, 58] as const) {
    const station = receiptPreset('st-till', 'Till', w);
    const b = bytesOf({ order, business: owner, station });
    ok(`${w}: no ESC M anywhere on the receipt (the kitchen switch on or off)`, count(b, [ESC, 0x4d]) === 0
      && b.equals(bytesOf({ order, business: { ...owner, kitchenFontB: true }, station })));
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

console.log('\n7. A Font B kitchen ticket then a receipt on the same printer: the receipt starts in Font A');
{
  const k = bytesOf({ order, business: FONT_B_BIZ, station: kitchen(80) });
  const r = bytesOf({ order, business: FONT_B_BIZ, station: receiptPreset('st-till', 'Till', 80) });
  const both = Buffer.concat([k, r]);
  const lastB = both.lastIndexOf(Buffer.from(FONT_B)), lastA = both.lastIndexOf(Buffer.from(FONT_A));
  ok('the kitchen ticket\'s last font command is ESC M 0, before its cut', lastA > lastB && lastA < k.length
    && k.subarray(lastA, lastA + 3).equals(Buffer.from(FONT_A)) && find(k, [GS, 0x56, 0x42, 0x00], lastA) > lastA);
  ok('the receipt that follows begins with ESC @ (Font A by itself) and never asks for Font B', r[0] === ESC && r[1] === 0x40
    && find(both, FONT_B, k.length) === -1);
}

console.log('\n8. A547: a wrapped dish name keeps its quantity gap; a wrapped component keeps its indent (Font A and Font B)');
{
  for (const fontB of [false, true]) {
    for (const w of [80, 58] as const) {
      const f = fontB ? 'Font B' : 'Font A';
      const cols = columnsFor(w, fontB ? 'B' : 'A');
      const biz = fontB ? FONT_B_BIZ : business;
      const flat = textOf(renderTicket({ order: longOrder, business: biz, station: { ...kitchen(w), emphasizeParent: false } }));
      const tall = textOf(renderTicket({ order: longOrder, business: biz, station: kitchen(w) }));
      for (const [how, rows] of [['flat', flat], ['tall', tall]] as const) {
        // Every dish heading, wrapped or not, is "<qty>   <NAME>", never "<qty> <NAME>".
        const heads = rows.filter(t => /^\d+ +[A-Z]/.test(t));
        ok(`${f} ${w} ${how}: every dish name keeps the three spaces after its quantity`,
          heads.length === 6 && heads.every(t => /^\d+ {3}[A-Z]/.test(t)), heads.join(' | '));
        const fam = rows.findIndex(t => t.startsWith('1   FAMILY'));
        ok(`${f} ${w} ${how}: the long name wraps, its rows within ${cols}, the continuation hung under the name`,
          fam >= 0 && ('Family Feast Bucket 12PC With Two Large Sides'.length + 4 <= cols || /^ {4}\S/.test(rows[fam + 1] ?? ''))
          && rows.filter(t => /^\d+ {3}[A-Z]|^ {4}\S/.test(t)).every(t => t.length <= cols), rows.slice(fam, fam + 3).join(' | '));
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
  // The 58 mm sample ticket: "1   3PC CHICKEN COMBO" (21) fits the 32-column line now — A543/A547 wrapped it at 16.
  const rows = textOf(renderTicket({ order, business, station: kitchen(58) }));
  ok("kitchen-58: the sample's dish names on one row each (A551: the whole line)", rows.includes('1   3PC CHICKEN COMBO')
    && rows.includes('2   WINGS COMBO 8PC') && !rows.includes('    COMBO'), rows.join(' | '));
}

console.log('\n9. A551: the tickets are their pre-A551 bytes with only the item gap, the 1-line feed and the whole-line dish name');
{
  /** The document as the pre-A551 renderer built it: a blank line where the item gap is, the caller's feed. */
  const legacy = (doc: Document): Document => ({
    ...doc, cutFeed: undefined,
    blocks: doc.blocks.map((b): Block => (b.kind === 'gap' ? { kind: 'text', text: '', align: 'left', size: 'normal', bold: false } : b)),
  });
  const cases: Array<[string, PrintContext, string]> = [
    ['kitchen-80 (Font A, the standard)', { order, business, station: kitchen(80) }, 'kitchen-80-font-a'],
    ['kitchen-80-font-b (kitchen_font_b)', { order, business: FONT_B_BIZ, station: kitchen(80) }, 'kitchen-80'],
    ['kitchen-58-font-b (kitchen_font_b)', { order, business: FONT_B_BIZ, station: kitchen(58) }, 'kitchen-58'],
    ['dispatch-80', { order, business, station: dispatchPreset(DISPATCH, 'Dispatch', 80) }, 'dispatch-80'],
  ];
  for (const [label, ctx, was] of cases) {
    const doc = renderTicket(ctx);
    ok(`${label}: = the pre-A551 ${was}.bin with the gap a blank line and the feed the station's`,
      toEscPos(legacy(doc), optsOf(ctx)).equals(preBytes(was)), `${toEscPos(legacy(doc), optsOf(ctx)).length} vs ${preBytes(was).length}`);
    const gaps = doc.blocks.filter(b => b.kind === 'gap');
    const printedItems = textOf(doc).filter(t => /^\d+ {3}\S/.test(t)).length;
    ok(`${label}: one ESC J ${ITEM_GAP_DOTS} between each two items (${printedItems} items), no blank line between them`,
      gaps.length === printedItems - 1 && gaps.every(g => g.kind === 'gap' && g.dots === ITEM_GAP_DOTS)
      && count(bytesOf(ctx), [ESC, 0x4a, ITEM_GAP_DOTS]) === printedItems - 1
      && doc.blocks.filter(b => b.kind === 'text' && b.text === '').length === 1);   // the one under the banner stays
    const b = bytesOf(ctx);
    ok(`${label}: ends ESC d ${PRODUCTION_CUT_FEED}, GS V 66 0 (was ESC d 3)`,
      b.subarray(b.length - 7).equals(Buffer.from([ESC, 0x64, PRODUCTION_CUT_FEED, GS, 0x56, 0x42, 0x00])));
  }
  // 58 mm Font A: the old ticket wrapped "3PC CHICKEN COMBO" and "WINGS COMBO 8PC" at 16; join those, and it is the same.
  {
    const ctx: PrintContext = { order, business, station: kitchen(58) };
    const lines = (buf: Buffer) => buf.toString('latin1').replace(/\x1b[@2]|\x1b[ta3EJMd].|\x1bp...|\x1d!.|\x1dV../gs, '').split('\n');
    const old = lines(preBytes('kitchen-58-font-a'));
    const joined: string[] = [];
    for (const l of old) {
      if (/^ {4}\S/.test(l) &&/^\d+ {3}\S/.test(joined[joined.length - 1] ?? '')) joined[joined.length - 1] += ` ${l.trim()}`;
      else joined.push(l);
    }
    const now = lines(toEscPos(legacy(renderTicket(ctx)), optsOf(ctx)));
    ok('kitchen-58 (Font A): the pre-A551 kitchen-58-font-a.bin\'s lines, its two wrapped dish names on one row',
      JSON.stringify(now) === JSON.stringify(joined) && old.length === now.length + 2, `${now.join(' | ')}\n vs ${joined.join(' | ')}`);
  }
  // A tear-off printer (no cut) still feeds the station's 3 — the tear bar needs it.
  const tear = bytesOf({ order, business, station: { ...kitchen(80), cutPaper: false } });
  ok('a tear-off kitchen printer: ESC d 3 and no cut', tear.subarray(tear.length - 3).equals(Buffer.from([ESC, 0x64, 3])) && count(tear, [GS, 0x56]) === 0);
  // The header and the footer are spaced as before: the blank line under the banner, rules, no gaps outside the items.
  const blocks = renderTicket({ order, business, station: kitchen(80) }).blocks;
  const firstRule = blocks.findIndex(b => b.kind === 'text' && /^-+$/.test(b.text));
  const lastRule = blocks.map((b, i) => (b.kind === 'text' && /^-+$/.test(b.text) ? i : -1)).filter(i => i >= 0).pop()!;
  ok('no gap in the header or the footer', blocks.every((b, i) => b.kind !== 'gap' || (i > firstRule && i < lastRule)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
