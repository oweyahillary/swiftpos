/**
 * receipt-footer.test.ts — the closing block on a customer receipt.
 *
 * WHY THIS EXISTS
 * ---------------
 * The footer stack is an owner-approved arrangement dated 04 Aug 2026:
 *
 *     the owner's editable box, verbatim line for line
 *     a rule, only when that box has content
 *     the CLOSING BLOCK — thank-you · TAX RECEIPT · Powered by SwiftPOS
 *
 * The closing block lived only in ReceiptView.tsx, the HTML receipt. 0.5.27
 * removed the HTML SALE path (register D8) and the thermal renderer had never
 * carried two of its behaviours:
 *
 *   * the DEFAULT thank-you when the owner's box is blank. Without it the
 *     receipt ended on the payment rule and then the credit, with nothing
 *     between.
 *   * "TAX RECEIPT UPON REQUEST" whenever VAT applies. The string existed
 *     nowhere in this package — only in the deleted component, and in
 *     wrapAuthored's docstring, which uses it as its worked example.
 *
 * Reported from the field on 0.5.27: both lines missing above the credit.
 *
 * This drives renderTicket and reads the rendered paper, so it proves what a
 * customer is handed rather than what the source says. Both paper widths,
 * because centring is width-derived and 58mm is where a line first wraps.
 *
 * MUTATION-CHECKED (rules 10 and 23): drop the closing block from render.ts and
 * sections 1, 2 and 4 go red; drop only the `vatRate > 0` guard and section 3
 * goes red on its own.
 */

import assert from 'node:assert';
import { renderTicket, toPreview, receiptPreset, type PrintContext, type BusinessConfig } from '../src/index';
import { order } from './fixture';

let passed = 0, failed = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${(e as Error).message}`); }
};

const BASE: BusinessConfig = {
  name: 'KUDO JUJA B', currencyCode: 'KES', vatRate: 16, ctlRate: 2,
  footerCredit: 'Powered by SwiftPOS',
} as BusinessConfig;

/** Render a receipt and return its lines, trimmed of the preview margins. */
function paper(business: Partial<BusinessConfig>, width?: 58 | 80): string[] {
  const ctx: PrintContext = {
    order,
    business: { ...BASE, ...business } as BusinessConfig,
    station: receiptPreset('st-till', 'Till', width),
  };
  return toPreview(renderTicket(ctx), { showMargins: false }).split('\n').map(l => l.trim());
}

const has = (lines: string[], text: string) => lines.some(l => l.includes(text));
const indexOf = (lines: string[], text: string) => lines.findIndex(l => l.includes(text));

console.log('\nreceipt closing block\n');

// ── 1. The default thank-you ───────────────────────────────────────────────
console.log('1. the thank-you always prints');
ok('an EMPTY owner box still prints the thank-you', () => {
  const p = paper({ thankYouMessage: undefined });
  assert.ok(has(p, 'Thank you for your business!'),
    'A blank receipt_footer must not leave the receipt ending on the payment rule. '
    + 'This is the field case: the owner never filled the box in.');
});
ok('a FILLED owner box prints both the box and the thank-you', () => {
  const p = paper({ thankYouMessage: 'Paybill 4098201' });
  assert.ok(has(p, 'Paybill 4098201'), 'the owner box is missing');
  assert.ok(has(p, 'Thank you for your business!'),
    'the closing block must not be swallowed by the owner box');
});
ok('the owner box does not REPLACE the closing block', () => {
  const p = paper({ thankYouMessage: 'Paybill 4098201' });
  assert.ok(indexOf(p, 'Paybill 4098201') < indexOf(p, 'Thank you for your business!'),
    'the box is the owner\'s and comes first; the closing block is fixed and follows');
});

// ── 2. Order, which is the whole point of the arrangement ──────────────────
console.log('\n2. the agreed order');
ok('thank-you, then TAX RECEIPT, then the credit', () => {
  const p = paper({});
  const t = indexOf(p, 'Thank you for your business!');
  const x = indexOf(p, 'TAX RECEIPT UPON REQUEST');
  const c = indexOf(p, 'Powered by SwiftPOS');
  assert.ok(t >= 0 && x >= 0 && c >= 0, `missing a line: thanks=${t} tax=${x} credit=${c}`);
  assert.ok(t < x, 'the thank-you must come above the tax line');
  assert.ok(x < c, 'the tax line must come above the credit');
});
ok('the credit is the last printed line', () => {
  const p = paper({}).filter(Boolean);
  assert.ok(p[p.length - 1].includes('Powered by SwiftPOS'),
    `last line was "${p[p.length - 1]}"`);
});

// ── 3. The tax line is conditional, and that matters legally ───────────────
console.log('\n3. TAX RECEIPT tracks VAT');
ok('VAT applies -> the tax line prints', () => {
  assert.ok(has(paper({ vatRate: 16 }), 'TAX RECEIPT UPON REQUEST'));
});
ok('zero-rated -> the tax line is ABSENT', () => {
  assert.ok(!has(paper({ vatRate: 0 }), 'TAX RECEIPT UPON REQUEST'),
    'A zero-rated business printing "TAX RECEIPT UPON REQUEST" claims something '
    + 'untrue on a document the customer keeps.');
});
ok('a zero-rated receipt still gets the thank-you and the credit', () => {
  const p = paper({ vatRate: 0 });
  assert.ok(has(p, 'Thank you for your business!'));
  assert.ok(has(p, 'Powered by SwiftPOS'));
});

// ── 4. 58mm, where centring and wrapping actually bite ─────────────────────
console.log('\n4. 58mm paper');
ok('the whole closing block survives narrow paper', () => {
  const p = paper({}, 58);
  assert.ok(has(p, 'Thank you for your business!'), 'thank-you lost at 58mm');
  assert.ok(has(p, 'TAX RECEIPT UPON REQUEST'), 'tax line lost at 58mm');
  assert.ok(has(p, 'Powered by SwiftPOS'), 'credit lost at 58mm');
});
ok('no closing line is cut off at 58mm', () => {
  for (const line of paper({}, 58)) {
    assert.ok(line.length <= 32, `line exceeds 32 columns: "${line}"`);
  }
});

// ── 5. The owner's own line breaks are still honoured (P-15) ───────────────
console.log('\n5. authored line breaks survive (P-15 regression guard)');
ok('a two-line owner box stays two lines', () => {
  const p = paper({ thankYouMessage: 'Paybill 4098201\nDelivery 0117 000 033' });
  assert.ok(has(p, 'Paybill 4098201'), 'first authored line missing');
  assert.ok(has(p, 'Delivery 0117 000 033'), 'second authored line missing');
  assert.ok(!has(p, 'Paybill 4098201 Delivery'),
    'wrap() ate the newline — the author\'s break is meaning, not whitespace. '
    + 'wrapAuthored exists for this.');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
