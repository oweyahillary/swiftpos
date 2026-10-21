// A498 → A539 — the receipt's payment block.
// A498 (owner, 2026-10-15): the heading and its payments are ONE block, with the M-Pesa number printed with them.
// A539 (owner, 2026-10-21, on paper): "add a line between payment method and payment details, it should read —
// payment details: Pay bill/buygood - 892984 / ------ / mpesa/cash/card". The standard receipt now names the number in
// the heading, a rule under it, then the payments and change, then the block's closing rule. The compact opt-in (A530)
// keeps its own block (no heading, the number after the payments).
//
//   cd shared/printing && npm run sample && cd ../.. && node --no-warnings tests/receipt-payment-block.test.mjs
//
// Reads the till's printed sample (SAMPLE-OUTPUT.txt, written by the real renderer and checked by shared/printing's own
// tests) and the web POS's renderer (apps/dashboard/src/lib/escposRenderer.js), so both print the same.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = fs.readFileSync(path.join(ROOT, 'shared/printing/SAMPLE-OUTPUT.txt'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js'), 'utf8');
const till = fs.readFileSync(path.join(ROOT, 'shared/printing/src/render.ts'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const all = sample.split('\n');
// The first CUSTOMER RECEIPT in the sample is the standard one (80 mm, no switches).
const start = all.findIndex((l) => l.startsWith('CUSTOMER RECEIPT   ('));
const rows = all.slice(start).map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').trimEnd());
const end = rows.findIndex((l, k) => k > 3 && /^\+-+\+?$/.test(l));
const receipt = rows.slice(0, end > 0 ? end : rows.length);

console.log('\nThe receipt\'s payment block (A539)\n');
ok('the heading names the number customers pay to: "Payment Details: Buy Goods - 000000"', () => {
  assert.ok(receipt.some((l) => l === 'Payment Details: Buy Goods - 000000'), receipt.join(' | '));
});
ok('…then a rule, then the payments and change, then the block\'s closing rule', () => {
  const i = receipt.indexOf('Payment Details: Buy Goods - 000000');
  assert.match(receipt[i + 1], /^-+$/, `under the heading: "${receipt[i + 1]}"`);
  assert.match(receipt[i + 2], /^CASH\s+[\d,]+\.\d\d$/);
  assert.match(receipt[i + 3], /^CHANGE\s+[\d,]+\.\d\d$/);
  assert.match(receipt[i + 4], /^-+$/, `after the payments: "${receipt[i + 4]}"`);
});
ok('no separate "Buy Goods: …" line on the standard receipt any more', () => {
  assert.ok(!receipt.some((l) => /^Buy Goods:/.test(l)), receipt.join(' | '));
});
ok('the web POS prints the same block (its renderer is built from the till\'s)', () => {
  for (const s of [till, web]) {
    assert.match(s, /Payment Details: \$\{label\} - \$\{business\.tillNumber\}/, 'the heading with the number');
    assert.match(s, /"Payment Details:"|'Payment Details:'/, 'the heading alone (no number, or too long)');
  }
});
ok('a Paybill\'s account goes on its own line when the heading is wider than the paper (both renderers)', () => {
  for (const s of [till, web]) assert.match(s, /indexOf\(["'], Account ["']\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
