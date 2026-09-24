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
              thankYouMessage: 'Thank you for your business!', footerCredit: 'Powered by SwiftPOS' },
  station: receiptPreset('st-till', 'Till'),
  reprint: { at: new Date(2026, 7, 5, 21, 6, 9), count: 2 },
});

show('KITCHEN — 58mm', { order, business, station: kitchenPreset(KITCHEN, 'Kitchen', 58) });
show('CUSTOMER RECEIPT — 58mm', { order, business, station: receiptPreset('st-till', 'Till', 58) });

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
