// A498 — the receipt's payment block is ONE block: "Payment Detail:" straight above its payments, and the M-Pesa number
// (Buy Goods / Paybill) printed WITH them, inside the block, before its closing rule.
// Owner, 2026-10-15, with a photo of a printed receipt: "the payment method is printing on the wrong place … check where
// payment detail is printed and where buy good is printed" — the heading was cut off from its payments by a rule, and the
// Buy Goods line sat after the block's rule, as if it were a section of its own.
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
const rows = sample.split('\n').map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').trimEnd());

console.log('\nThe receipt\'s payment block\n');
ok('the printed sample: the heading is followed straight by a payment line — no rule between', () => {
  const i = rows.findIndex((l) => l.startsWith('Payment Detail:'));
  assert.ok(i >= 0, 'no Payment Detail in the sample');
  assert.doesNotMatch(rows[i + 1], /^-+$/, `a rule under the heading: "${rows[i + 1]}"`);
  assert.match(rows[i + 1], /^CASH\s+[\d,]+\.\d\d$/);
});
ok('the printed sample: Buy Goods inside the block — after the payments, before the block\'s rule', () => {
  const i = rows.findIndex((l) => l.startsWith('Payment Detail:'));
  const b = rows.findIndex((l, k) => k > i && l.startsWith('Buy Goods:'));
  const r = rows.findIndex((l, k) => k > i && /^-+$/.test(l));
  assert.ok(b > i, 'no Buy Goods after the heading'); assert.ok(r > b, `the block's rule (${r}) comes before Buy Goods (${b})`);
  for (let k = i + 1; k < b; k++) assert.doesNotMatch(rows[k], /^-+$/, 'a rule between the payments and Buy Goods');
});
ok('the web POS prints the same block (its own renderer)', () => {
  assert.match(web, /d\.line\("Payment Detail:", \{ bold: true \}\);\n  for \(const leg of order\.payments\)/);
  assert.match(web, /if \(business\.tillNumber\) \{[\s\S]{0,400}\}\n  d\.line\(rule\(cols\)\);/);
  assert.match(till, /d\.line\('Payment Detail:', \{ bold: true \}\);\n  for \(const leg of order\.payments\)/);
});
ok('a Paybill\'s account goes on its own line when the line is wider than the paper (both renderers)', () => {
  // The web's copy is generated from shared/printing by esbuild (scripts/build-escpos-renderer.mjs), which re-lays it out.
  for (const s of [till, web]) assert.match(s, /if \(payLine\.length > cols && cut > 0\) \{\s*d\.line\(payLine\.slice\(0, cut\)\);\s*d\.line\(payLine\.slice\(cut \+ 2\)\);\s*\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
