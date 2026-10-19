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

// ── A530: before / after, for the owner to approve on paper ─────────────────
//
// PAPER LENGTH ESTIMATE (the method; the printer's own figures will differ by a few mm):
//   * a normal-size text line advances the line spacing — classic ESC 2 = 1/6" = 4.23 mm; compact ESC 3 26 = 26 dots
//     at 203 dpi = 3.25 mm;
//   * a double-height line (PAY, a Duplicate/VOID/BILL banner) advances its 48-dot glyph, 6.0 mm, either way (the
//     compact receipt prints it at the default spacing, escpos.ts);
//   * a logo advances its height in dots at 8 dots/mm (203 dpi): 288 dots = 36 mm classic, 120 dots = 15 mm compact;
//   * the feed before the cut is that many lines at 1/6" (the spacing is back to the default by then): 3 classic,
//     1 compact. The blade's own distance (GS V 66 0 feeds the last line past it) is the same both ways and left out.
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

log(`\n${'='.repeat(60)}\nA530 — the receipt BEFORE (classic, 1.0.19) and AFTER (compact, the 1.0.20 standard)\n${'='.repeat(60)}`);
log('Classic = all four admin-portal switches on (receipt_classic_spacing, receipt_full_logo, receipt_classic_layout,');
log('receipt_extra_feed); compact = all off, the standard. Same sale; the AFTER is the CUSTOMER RECEIPT above.');
const CLASSIC = { spacing: true, fullLogo: true, layout: true, extraFeed: true };
for (const w of [80, 58] as const) {
  const st = receiptPreset('st-till', 'Till', w);
  const before = toPreview(renderTicket({ order, business: { ...business, receiptClassic: CLASSIC }, station: st }), { showMargins: true }).split('\n');
  const after = toPreview(renderTicket({ order, business, station: st }), { showMargins: true }).split('\n');
  const left = before[0].length + 4;
  log(`\n${w} mm`);
  log('BEFORE (classic)'.padEnd(left) + 'AFTER (compact)');
  for (let i = 0; i < Math.max(before.length, after.length); i++) log(((before[i] ?? '').padEnd(left) + (after[i] ?? '')).trimEnd());
}
log('\nEstimated paper per receipt (this sale; "logo" = a 300 x 288-dot logo stored before A530):');
log('                       text lines        classic    compact    saved');
for (const w of [80, 58] as const) {
  for (const withLogo of [false, true]) {
    const st = receiptPreset('st-till', 'Till', w);
    const b = { ...business, ...(withLogo ? { logoRaster: bigLogo() } : {}) };
    const cd = renderTicket({ order, business: { ...b, receiptClassic: CLASSIC }, station: st });
    const nd = renderTicket({ order, business: b, station: st });
    const cm = paperMm(cd, st.cutPaper, st.feedBeforeCut), nm = paperMm(nd, st.cutPaper, st.feedBeforeCut);
    log(`  ${`${w} mm${withLogo ? ', logo' : ''}`.padEnd(20)} ${`${textLines(cd)} -> ${textLines(nd)}`.padEnd(16)}`
      + ` ${`${cm.toFixed(0)} mm`.padStart(9)}  ${`${nm.toFixed(0)} mm`.padStart(9)}   ${`${(cm - nm).toFixed(0)} mm (${Math.round((1 - nm / cm) * 100)}%)`}`);
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
