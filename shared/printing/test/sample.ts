/**
 * Renders the agreed sample order to all three stations, plus a duplicate, and
 * checks the money against the two real receipts photographed from the
 * incumbent system. If the arithmetic here ever stops matching those, the
 * change was wrong.
 *
 * Modes (A314):
 *   node test-dist/test/sample.js           print to stdout (as it always has)
 *   node test-dist/test/sample.js --write   refresh SAMPLE-OUTPUT.txt
 *   node test-dist/test/sample.js --check   fail if SAMPLE-OUTPUT.txt differs
 *
 * --check is in `npm test`, so a renderer change that moves the paper and does
 * not refresh the reference fails the build instead of quietly making every
 * later "identical to SAMPLE-OUTPUT" claim false (which is how A314 happened:
 * the closing block landed and the reference kept the old receipt for weeks).
 */

import {
  renderTicket, toPreview, toEscPos, splitTax, formatCents,
  kitchenPreset, dispatchPreset, receiptPreset,
  type PrintContext,
} from '../src/index';
import { order, business, KITCHEN, DISPATCH } from './fixture';
import { bigLogo } from './a530-cases';   // A530
import { longOrder, productionPaperMm } from './a543-cases';   // A543
import { variantCases } from './a551-cases';   // A551
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const MODE = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--write') ? 'write' : 'print';
const REFERENCE = join(__dirname, '..', '..', 'SAMPLE-OUTPUT.txt');

// Everything the run prints is collected, so the three modes see the same text.
const out: string[] = [];
const log = (s = '') => { out.push(s); };

function show(title: string, ctx: PrintContext) {
  const doc = renderTicket(ctx);
  const bytes = toEscPos(doc, {
    cut: ctx.station.cutPaper,
    openDrawer: ctx.station.openCashDrawer,
    feedBeforeCut: ctx.station.feedBeforeCut,
  });
  log(`\n${'='.repeat(60)}\n${title}   (${bytes.length} bytes)\n${'='.repeat(60)}`);
  log(toPreview(doc, { showMargins: true }));
}

show('KITCHEN', { order, business, station: kitchenPreset(KITCHEN, 'Kitchen') });
show('DISPATCH', { order, business, station: dispatchPreset(DISPATCH, 'Dispatch') });
show('CUSTOMER RECEIPT', { order, business, station: receiptPreset('st-till', 'Till') });
show('CUSTOMER RECEIPT — duplicate, optional fields off', {
  order,
  business: { name: 'Your Business', currencyCode: 'KES', vatRate: 16, ctlRate: 2,
              thankYouMessage: 'Thank you for your business!', footerCredit: 'Powered by ZapTill' },
  station: receiptPreset('st-till', 'Till'),
  reprint: { at: new Date(2026, 7, 5, 21, 6, 9), count: 2 },
});

show('KITCHEN — 58mm', { order, business, station: kitchenPreset(KITCHEN, 'Kitchen', 58) });
show('CUSTOMER RECEIPT — 58mm', { order, business, station: receiptPreset('st-till', 'Till', 58) });

// ── A530 / A538: the receipt before and after, for the owner to approve on paper ──
//
// A538 (owner, 2026-10-21, on the A530 compact receipt: "it feels congested everywhere" — chose "go back to the old
// layout" and "line spacing in the middle, about 3.75 mm"): three receipts side by side — 1.0.19; the A538 standard
// (classic layout, ESC 3 30, small logo, 1-line feed); and the 'receipt_compact_layout' opt-in (A530's lines at 30).
//
// PAPER LENGTH ESTIMATE (the method; the printer's own figures will differ by a few mm):
//   * a normal-size text line advances the line spacing — ESC 2 = 1/6" = 4.23 mm (1.0.19); ESC 3 30 = 30 dots at 203 dpi
//     = 3.75 mm (A538 standard); ESC 3 26 = 3.25 mm (A530, shown for reference);
//   * a double-height line (PAY, a Duplicate/VOID/BILL banner) advances its 48-dot glyph, 6.0 mm, either way (a receipt
//     with ESC 3 prints it at the default spacing, escpos.ts);
//   * a logo advances its height in dots at 8 dots/mm (203 dpi): 288 dots = 36 mm (1.0.19), 120 dots = 15 mm (A530/A538);
//   * the feed before the cut is that many lines at 1/6" (the spacing is back to the default by then): 3 in 1.0.19, 1
//     now. The blade's own distance (GS V 66 0 feeds the last line past it) is the same every way and left out.
const DOT_MM = 25.4 / 203;
function paperMm(doc: ReturnType<typeof renderTicket>, cut: boolean, feedBeforeCut: number): number {
  let mm = 0;
  const lineMm = (doc.lineSpacing ?? 34) * DOT_MM;   // ESC 2: 1/6" = 33.8 dots
  for (const b of doc.blocks) {
    if (b.kind === 'text') mm += b.size === 'tall' || b.size === 'large' ? 48 * DOT_MM : lineMm;
    else if (b.kind === 'image') mm += b.raster.height * DOT_MM;
    else if (b.kind === 'feed') mm += b.lines * 34 * DOT_MM;
  }
  const feed = cut && doc.cutFeed !== undefined ? doc.cutFeed : feedBeforeCut;
  return mm + feed * (25.4 / 6);
}
const textLines = (doc: ReturnType<typeof renderTicket>) => doc.blocks.filter(b => b.kind === 'text').length;

log(`\n${'='.repeat(60)}\nA538 — the receipt in 1.0.19, the A538 standard, and the compact opt-in\n${'='.repeat(60)}`);
log('1.0.19 = receipt_classic_spacing + receipt_full_logo + receipt_extra_feed on (the layout is classic by default).');
log('Standard = all switches off: the classic layout at 3.75 mm (ESC 3 30), a small logo, 1 line fed before the cut —');
log('the CUSTOMER RECEIPT above. Compact = receipt_compact_layout on (A530\'s lines, at 3.75 mm). Same sale.');
const CLASSIC = { spacing: true, fullLogo: true, extraFeed: true };
const COMPACT = { compactLayout: true };
for (const w of [80, 58] as const) {
  const st = receiptPreset('st-till', 'Till', w);
  const cols = [
    toPreview(renderTicket({ order, business: { ...business, receiptClassic: CLASSIC }, station: st }), { showMargins: true }).split('\n'),
    toPreview(renderTicket({ order, business, station: st }), { showMargins: true }).split('\n'),
    toPreview(renderTicket({ order, business: { ...business, receiptClassic: COMPACT }, station: st }), { showMargins: true }).split('\n'),
  ];
  const left = cols[0][0].length + 4;
  log(`\n${w} mm`);
  log('1.0.19'.padEnd(left) + 'STANDARD (A538)'.padEnd(left) + 'COMPACT (opt-in)');
  for (let i = 0; i < Math.max(...cols.map(c => c.length)); i++) {
    log(((cols[0][i] ?? '').padEnd(left) + (cols[1][i] ?? '').padEnd(left) + (cols[2][i] ?? '')).trimEnd());
  }
}
log('\nEstimated paper per receipt (this sale; "logo" = a 300 x 288-dot logo stored before A530;');
log('"A530" = the 1.0.20 compact standard at 3.25 mm that A538 replaces, for reference):');
log('                       text lines      1.0.19   standard    compact       A530');
for (const w of [80, 58] as const) {
  for (const withLogo of [false, true]) {
    const st = receiptPreset('st-till', 'Till', w);
    const b = { ...business, ...(withLogo ? { logoRaster: bigLogo() } : {}) };
    const od = renderTicket({ order, business: { ...b, receiptClassic: CLASSIC }, station: st });
    const sd = renderTicket({ order, business: b, station: st });
    const cd = renderTicket({ order, business: { ...b, receiptClassic: COMPACT }, station: st });
    const mm = (d: typeof od) => paperMm(d, st.cutPaper, st.feedBeforeCut);
    const om = mm(od), sm = mm(sd), cm = mm(cd), am = mm({ ...cd, lineSpacing: 26 });
    const pct = (x: number) => `${Math.round((1 - x / om) * 100)}%`;
    log(`  ${`${w} mm${withLogo ? ', logo' : ''}`.padEnd(20)} ${`${textLines(sd)} / ${textLines(cd)}`.padEnd(13)}`
      + ` ${`${om.toFixed(0)} mm`.padStart(9)}  ${`${sm.toFixed(0)} mm -${pct(sm)}`.padStart(9)}  ${`${cm.toFixed(0)} mm -${pct(cm)}`.padStart(9)}  ${`${am.toFixed(0)} mm -${pct(am)}`.padStart(9)}`);
  }
}

// ── A543 / A551: the kitchen ticket in Font A (the standard again, A551) and Font B (kitchen_font_b), a long order ──
//
// A543 (owner, 2026-10-21: "change the font of the kitchen printer, packing is okay") made it Font B; A551 (owner, the
// same day, on paper: "kitchen receipt use the same font as the despatcher") made Font A the standard again and Font B
// the 'kitchen_font_b' opt-in. Font B is 9x17 dots: 64 characters a line on 80 mm, 42 on 58 mm (Font A 12x24: 48 / 32).
// Its normal lines are 24 dots apart (ESC 3 24, ~3.0 mm). A double-height dish name is 34 dots in Font B, 48 in Font A
// (both at ESC 2). The preview shows each ticket at its own width; Font B's characters are smaller on paper, so the
// 64-column ticket is the same 72 mm wide as the 48-column one. Estimate as for the receipt (a543-cases.ts
// productionPaperMm). A551: both with the thin gap between items (invisible here) and a 1-line feed before the cut.
log(`\n${'='.repeat(60)}\nA543/A551 — the kitchen ticket in Font A (standard) and Font B (kitchen_font_b)\n${'='.repeat(60)}`);
log('A long dine-in order. Dispatch (packing) and receipts are Font A either way.');
for (const w of [80, 58] as const) {
  const st = kitchenPreset(KITCHEN, 'Kitchen', w);
  const cols = [
    toPreview(renderTicket({ order: longOrder, business, station: st }), { showMargins: true }).split('\n'),
    toPreview(renderTicket({ order: longOrder, business: { ...business, kitchenFontB: true }, station: st }), { showMargins: true }).split('\n'),
  ];
  const left = cols[0][0].length + 4;
  log(`\n${w} mm`);
  log('FONT A (standard, A551)'.padEnd(left) + 'FONT B (kitchen_font_b)');
  for (let i = 0; i < Math.max(...cols.map(c => c.length)); i++) {
    log(((cols[0][i] ?? '').padEnd(left) + (cols[1][i] ?? '')).trimEnd());
  }
}
log('\nEstimated paper per kitchen ticket (text lines, mm; A551 = the item gap and the 1-line feed):');
log('                           Font A before   Font A (A551)   Font B (A551)');
for (const [label, o] of [['this sale', order], ['the long order', longOrder]] as const) {
  for (const w of [80, 58] as const) {
    const st = kitchenPreset(KITCHEN, 'Kitchen', w);
    const a = renderTicket({ order: o, business, station: st });
    // Before A551: a blank line where the gap is, and the station's 3-line feed.
    const old = { ...a, cutFeed: undefined, blocks: a.blocks.map(b => (b.kind === 'gap' ? { kind: 'text' as const, text: '', align: 'left' as const, size: 'normal' as const, bold: false } : b)) };
    const b = renderTicket({ order: o, business: { ...business, kitchenFontB: true }, station: st });
    const om = productionPaperMm(old, st.feedBeforeCut), am = productionPaperMm(a, st.feedBeforeCut), bm = productionPaperMm(b, st.feedBeforeCut);
    log(`  ${`${label}, ${w} mm`.padEnd(24)} ${`${textLines(old)} / ${om.toFixed(0)} mm`.padEnd(15)} `
      + `${`${textLines(a)} / ${am.toFixed(0)} mm -${Math.round((1 - am / om) * 100)}%`.padEnd(15)} `
      + `${textLines(b)} / ${bm.toFixed(0)} mm -${Math.round((1 - bm / om) * 100)}%`);
  }
}

// ── A551: variants on the item's own line, and the payment block ──
//
// Owner, 2026-10-21, on paper: "on items with variants assume chicken burger instead of writing `Chicken burger` then
// `  Chicken burger spicy` why not write `Chicken burger - Spicy`" and "we just write `PAY BILL/BUY GOODS:` newline
// `123445` and we center it and increase the font size and thickness, We remove the wordings payment details".
log(`\n${'='.repeat(60)}\nA551 — a variant on the item's line; the payment block\n${'='.repeat(60)}`);
log('The cart as the till hands it in (toUnits): a Chicken Burger with the variant "Chicken Burger Spicy", a Beef Burger');
log('with "Large", and a long name with its variant (the hanging wrap keeps the quantity column). Paybill 4098201, Account WEST1.');
{
  const variantOrder: typeof order = {
    ...order, lines: variantCases.lines, total: variantCases.total, payments: [{ label: 'M-PESA', amount: variantCases.total }], changeGiven: 0,
  };
  const paybill = { ...business, tillLabel: 'Paybill', tillNumber: '4098201, Account WEST1' };
  for (const w of [80, 58] as const) {
    const cols = [
      toPreview(renderTicket({ order: variantOrder, business, station: kitchenPreset(KITCHEN, 'Kitchen', w) }), { showMargins: true }).split('\n'),
      toPreview(renderTicket({ order: variantOrder, business, station: dispatchPreset(DISPATCH, 'Dispatch', w) }), { showMargins: true }).split('\n'),
      toPreview(renderTicket({ order: variantOrder, business: paybill, station: receiptPreset('st-till', 'Till', w) }), { showMargins: true }).split('\n'),
    ];
    const left = cols[0][0].length + 4;
    log(`\n${w} mm`);
    log('KITCHEN'.padEnd(left) + 'DISPATCH'.padEnd(left) + 'RECEIPT (Paybill)');
    for (let i = 0; i < Math.max(...cols.map(c => c.length)); i++) {
      log(((cols[0][i] ?? '').padEnd(left) + (cols[1][i] ?? '').padEnd(left) + (cols[2][i] ?? '')).trimEnd());
    }
  }
}

// ── Verification against the two photographed receipts ──────────────────────
let failures = 0;
function check(label: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got ${got}  want ${want}`);
}

log(`\n${'='.repeat(60)}\nAgainst the incumbent's printed receipts\n${'='.repeat(60)}`);

const a = splitTax([325000, 139000], 464000, 16, 2);
check('sample 1 line 1 net', formatCents(a.lineNets[0]), '2,754.24');
check('sample 1 line 2 net', formatCents(a.lineNets[1]), '1,177.97');
check('sample 1 subtotal', formatCents(a.subtotal), '3,932.20');
check('sample 1 CTL', formatCents(a.ctl), '78.64');
check('sample 1 VAT', formatCents(a.vat), '629.15');
check('sample 1 round off', formatCents(a.roundOff), '0.01');
check('sample 1 total', formatCents(a.total), '4,640.00');

const b = splitTax([43500], 43500, 16, 2);
check('sample 2 subtotal', formatCents(b.subtotal), '368.64');
check('sample 2 CTL', formatCents(b.ctl), '7.37');
check('sample 2 VAT', formatCents(b.vat), '58.98');
check('sample 2 round off', formatCents(b.roundOff), '0.01');
check('sample 2 total', formatCents(b.total), '435.00');

log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`);

const text = out.join('\n') + '\n';
if (MODE === 'print') {
  process.stdout.write(text);
} else if (MODE === 'write') {
  writeFileSync(REFERENCE, text);
  console.log(`wrote ${REFERENCE}`);
} else {
  // The money checks above only reached `out`; show them if one failed.
  if (failures) process.stdout.write(text);
  // LF-normalised: git stores LF (.gitattributes) but a Windows editor or a
  // core.autocrlf checkout must not turn this red on line endings alone.
  let want: string;
  try { want = readFileSync(REFERENCE, 'utf8').replace(/\r\n/g, '\n'); }
  catch { want = ''; console.log(`FAIL  SAMPLE-OUTPUT.txt missing: ${REFERENCE}`); failures++; }
  if (want && want !== text) {
    const a = want.split('\n'), b = text.split('\n');
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`FAIL  SAMPLE-OUTPUT.txt differs from the current renderer at line ${i + 1}`);
    console.log(`        committed: ${JSON.stringify(a[i] ?? '<end of file>')}`);
    console.log(`        rendered:  ${JSON.stringify(b[i] ?? '<end of file>')}`);
    console.log('      If the change is intended: npm run refresh-artefacts, review the diff, commit it.');
    failures++;
  } else if (want) {
    console.log('PASS  SAMPLE-OUTPUT.txt matches the current renderer');
  }
  if (failures) console.log(`${failures} FAILED`);
}
process.exit(failures === 0 ? 0 : 1);
