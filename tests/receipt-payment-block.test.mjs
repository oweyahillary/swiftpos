// A498 → A539 → A551 — the receipt's payment block.
// A498 (owner, 2026-10-15): the heading and its payments are ONE block, with the M-Pesa number printed with them.
// A539 (owner, 2026-10-21, on paper): "payment details: Pay bill/buygood - 892984 / ------ / mpesa/cash/card".
// A551 (owner, 2026-10-21, on paper again): "we just write `PAY BILL/BUY GOODS:` newline `123445` and we center it and
// increase the font size and thickness, We remove the wordings payment details". The standard receipt now prints the
// label alone ("BUY GOODS:" / "PAYBILL:"), then the number, each centred, double size and bold (a Paybill's account under
// them, normal size), a rule, then the payments and change, then the block's closing rule. The compact opt-in (A530)
// keeps its own block (no heading, the number after the payments). The bytes are pinned in shared/printing
// (test/receipt-pay-block.test.ts).
//
//   cd shared/printing && npm run sample && cd ../.. && node --no-warnings tests/receipt-payment-block.test.mjs
//
// Reads the till's printed sample (SAMPLE-OUTPUT.txt, written by the real renderer and checked by shared/printing's own
// tests) and the web POS's renderer (apps/dashboard/src/lib/escposRenderer.js), so both print the same.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = fs.readFileSync(path.join(ROOT, 'shared/printing/SAMPLE-OUTPUT.txt'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js'), 'utf8');
const till = fs.readFileSync(path.join(ROOT, 'shared/printing/src/render.ts'), 'utf8');
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const all = sample.split('\n');
// The first CUSTOMER RECEIPT in the sample is the standard one (80 mm, no switches).
const start = all.findIndex((l) => l.startsWith('CUSTOMER RECEIPT   ('));
const rows = all.slice(start).map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').trim());
const end = rows.findIndex((l, k) => k > 3 && /^\+-+\+?$/.test(l));
const receipt = rows.slice(0, end > 0 ? end : rows.length);
// The preview draws a double-width line with its letters spaced out ("B U Y   G O O D S :").
const wide = (s) => s.split('').join(' ');

console.log('\nThe receipt\'s payment block (A551)\n');
ok('the label alone, then the number on its own line — no "Payment Details" words', () => {
  const i = receipt.indexOf(wide('BUY GOODS:'));
  assert.ok(i > 0, receipt.join(' | '));
  assert.equal(receipt[i + 1], wide('000000'));
  assert.ok(!receipt.some((l) => /payment detail/i.test(l)), receipt.join(' | '));
});
ok('…under the rule below PAY; then a rule, the payments and change, then the block\'s closing rule', () => {
  const i = receipt.indexOf(wide('BUY GOODS:'));
  assert.match(receipt[i - 2], /^PAY: KES /);
  assert.match(receipt[i - 1], /^-+$/);
  assert.match(receipt[i + 2], /^-+$/, `under the number: "${receipt[i + 2]}"`);
  assert.match(receipt[i + 3], /^CASH\s+[\d,]+\.\d\d$/);
  assert.match(receipt[i + 4], /^CHANGE\s+[\d,]+\.\d\d$/);
  assert.match(receipt[i + 5], /^-+$/, `after the payments: "${receipt[i + 5]}"`);
});
ok('no separate "Buy Goods: …" line on the standard receipt any more', () => {
  assert.ok(!receipt.some((l) => /^Buy Goods:/.test(l)), receipt.join(' | '));
});
ok('the web POS prints the same block (its renderer is built from the till\'s): centred, double size, bold', () => {
  for (const s of [till, web]) {
    assert.ok(!/Payment Details/.test(s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), 'no "Payment Details" in the code');
    assert.match(s, /\{ align: ["']center["'], size, bold: true \}/, 'the label and the number centred, bold');
  }
  const biz = { name: 'B Foods', currencyCode: 'KES', vatRate: 16, ctlRate: 0, tillLabel: 'Paybill', tillNumber: '4098201, Account WEST1' };
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Amina', soldAt: '2026-10-21T09:00:00Z', kotCount: 0,
    lines: [{ name: 'Burger', quantity: 1, unitPrice: 50000, lineTotal: 50000, units: [], stationIds: [] }],
    payments: [{ label: 'M-PESA', amount: 50000 }], changeGiven: 0, total: 50000 };
  const b = Buffer.from(E.renderReceiptEscPos(order, biz, 80));
  const want = Buffer.concat([Buffer.from([0x1b, 0x61, 1, 0x1d, 0x21, 0x11, 0x1b, 0x45, 1, 0x1b, 0x32]), Buffer.from('PAYBILL:\n4098201\n'),
    Buffer.from([0x1d, 0x21, 0, 0x1b, 0x45, 0, 0x1b, 0x33, 30]), Buffer.from('Account: WEST1\n')]);
  assert.ok(b.includes(want), 'web: ESC a 1, GS ! 0x11, ESC E 1 — PAYBILL: / 4098201 — then Account: WEST1 normal');
});
ok('a Paybill\'s account goes on its own line (both renderers)', () => {
  for (const s of [till, web]) assert.match(s, /indexOf\(["'], Account ["']\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
