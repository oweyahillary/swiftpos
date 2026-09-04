/**
 * receipt-escpos-format.test.mjs — A209 (web receipts in the desktop format).
 *
 * Option B: the web sends the Order JSON; the print-server renders it with
 * shared/printing's renderTicket/toEscPos — the SAME code the desktop till uses —
 * so the bytes are the desktop format by construction. This test feeds an Order in
 * the exact shape buildReceiptOrder produces into that render path and asserts it
 * yields valid ESC/POS (init sequence, the bill number, the line). It also pins
 * that the print-server endpoint and the web mapper use the shared contract.
 *
 * Requires shared/printing to be built (its dist is gitignored; the print-server
 * needs it built too). Skips cleanly if it isn't.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let printing;
for (const p of ['shared/printing/dist/src/index.js', 'shared/printing/dist/index.js']) {
  try { printing = require(path.join(root, p)); break; } catch { /* try next */ }
}
if (!printing) {
  console.log('SKIP — shared/printing is not built (run `npm run build` in shared/printing). The print-server needs it built too.');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

const { renderTicket, toEscPos, receiptPreset } = printing;

// An Order in the exact shape buildReceiptOrder emits (money in cents, ISO soldAt).
const order = {
  billNumber: 'ORD-MTMFHP2R-00124S',
  orderType: 'counter',
  cashierName: 'Amina',
  soldAt: new Date('2026-09-04T12:00:00Z'),
  lines: [{ name: 'Chicken Wrap', quantity: 2, unitPrice: 79000, lineTotal: 158000, units: [], stationIds: [] }],
  payments: [{ label: 'cash', amount: 158000 }],
  changeGiven: 0,
  total: 158000,
  kotCount: 0,
};
const business = { name: 'B Fastfoods', kraPin: 'P051234567X', telephone: '0700000000', vatRate: 16, ctlRate: 0 };

ok('render path (renderTicket→toEscPos) yields valid ESC/POS for a mapper-shaped Order', () => {
  const bytes = toEscPos(renderTicket({ order, business, station: receiptPreset('web-receipt', 'Receipt', 80) }));
  assert.ok(bytes && bytes.length > 50, 'should produce a non-trivial byte stream');
  assert.strictEqual(bytes[0], 0x1B, 'ESC/POS must start with ESC (0x1B)');
  assert.strictEqual(bytes[1], 0x40, 'followed by @ (0x40) — the init sequence');
  const text = bytes.toString('latin1');
  assert.ok(text.includes('Chicken Wrap'), 'the line item must appear');
  assert.ok(text.includes('ORD-MTMFHP2R-00124S'), 'the bill number must appear');
  assert.ok(text.includes('B Fastfoods'), 'the business name must appear');
});

// Source-level: the two ends use the shared contract.
const server = fs.readFileSync(path.join(root, 'apps/print-server/src/index.js'), 'utf8');
const mapper = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/buildReceiptOrder.ts'), 'utf8');

ok('print-server /print/receipt renders via shared/printing (not a reimpl)', () => {
  assert.match(server, /url\.pathname === '\/print\/receipt'/, 'the endpoint must exist');
  assert.match(server, /renderTicket, toEscPos, receiptPreset[\s\S]*?shared\/printing/, 'it must use shared/printing render');
});

ok('web mapper emits money in CENTS (matches shared/printing)', () => {
  assert.match(mapper, /const toCents = \(n: number\) => Math\.round\(\(Number\(n\) \|\| 0\) \* 100\)/, 'money must be integer cents');
  assert.match(mapper, /unitPrice: toCents\(c\.unitPrice\)/, 'line prices must be cents');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
