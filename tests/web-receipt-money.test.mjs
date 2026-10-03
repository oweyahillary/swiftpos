/**
 * web-receipt-money.test.mjs — A349 (2026-09-28): the WEB POS's printed receipt with a discount, a tip and CTL.
 *
 * Found in the owner's pre-0.6.16 review ("money math and reporting they have to be spot on"):
 *   - the web passed grandTotal (bill + tip) as the receipt total, so a tipped OR discounted sale could not reconcile its
 *     lines and the thermal print threw (falling back to the browser dialog);
 *   - every web print passed ctlRate 0, so a CTL business's receipt had no CTL line and split the VAT on the VAT-only net;
 *   - the web's cart/receipt VAT was a fixed 16 % on the undiscounted subtotal.
 *
 *   node tests/web-receipt-money.test.mjs
 *
 * RUNS the real web code: buildReceiptOrder / buildReceiptBusinessConfig / extractTaxes (TypeScript, type-stripped) and
 * the committed web bundle escposRenderer.js (shared/printing, built by scripts/build-escpos-renderer.mjs), decoding the
 * printed text out of the ESC/POS bytes.
 *
 * MUTATIONS TO CONFIRM BITE: the builder's `ctlRate || business.ctl_rate` fallback removed → "CTL line … VAT 152.54" fails;
 * PaymentModal back to `total: grandTotal` → the source pin fails; extractTaxes on net-plus-levy → its check fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.WEB_RECEIPT_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, WEB_RECEIPT_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cart.ts')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);

// The printed text: drop ESC/GS command bytes, keep printable ASCII lines.
const textOf = (bytes) => Buffer.from(bytes).toString('latin1')
  // ESC @ (no argument); ESC x n (one); GS ! n, GS B n (one); GS V B n (two) / GS V n (one); GS L|W nL nH (two).
  .replace(/\x1b\x40/g, '').replace(/\x1b[\x41-\x7e][\x00-\xff]/g, '')
  .replace(/\x1d[\x21\x42][\x00-\xff]/g, '').replace(/\x1d\x56\x42[\x00-\xff]/g, '').replace(/\x1d\x56[\x00-\xff]/g, '')
  .replace(/\x1d[\x4c\x57][\x00-\xff]{2}/g, '')
  .split('\n').map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean);
const val = (lines, label) => { const l = lines.find((x) => x.startsWith(label)); return l ? l.slice(label.length).trim() : null; };

const business = { id: 'b', name: 'B Foods', type: 'restaurant', currency: 'KES', owner_id: 'o', status: 'active', vat_rate: 16, ctl_rate: 2 };
const cart = [
  { product: { id: 'p1', name: 'Burger' }, quantity: 1, unitPrice: 750, lineTotal: 750, selectedVariants: [], selectedModifiers: [] },
  { product: { id: 'p2', name: 'Juice' }, quantity: 1, unitPrice: 500, lineTotal: 500, selectedVariants: [], selectedModifiers: [] },
];

ok('extractTaxes: the bill after discount, VAT and CTL on the same net (1,125 → VAT 152.54, CTL 19.07)', () => {
  assert.deepEqual(C.extractTaxes(1125, 16, 2), { vat: 152.54, ctl: 19.07 });
  assert.deepEqual(C.extractTaxes(1250, 16, 0), { vat: 172.41, ctl: 0 });
});

ok('a discounted, tipped sale at a CTL business prints — with the CTL line and the stored figures', () => {
  const order = B.buildReceiptOrder({ orderNumber: 'W-1', orderType: 'takeaway', cashierName: 'Ann', cart,
    total: 1125, discount: 125, tip: 50, change: 0, payments: [{ method: 'cash', amount: 1175 }] });
  // The web passes ctlRate 0 (as every caller did) — the builder must take the business's own levy.
  const biz = B.buildReceiptBusinessConfig(business, undefined, 0, {});
  assert.equal(biz.ctlRate, 2);
  const lines = textOf(E.renderEscPos(order, biz, 80));
  assert.equal(val(lines, 'CTL (2%)'), '19.07', lines.join('\n'));
  assert.equal(val(lines, 'VAT (16%)'), '152.54');
  assert.equal(val(lines, 'Discount:'), '-105.93');
  assert.equal(val(lines, 'Total:'), '1,125.00');
  assert.equal(val(lines, 'Tip:'), '50.00');
  assert.ok(lines.some((l) => l.includes('PAY: KES 1,175.00')), lines.join('\n'));
});

ok('a business without CTL: no CTL line, VAT on the VAT-only net', () => {
  const order = B.buildReceiptOrder({ orderNumber: 'W-2', orderType: 'takeaway', cashierName: 'Ann', cart,
    total: 1250, change: 0, payments: [{ method: 'cash', amount: 1250 }] });
  const lines = textOf(E.renderEscPos(order, B.buildReceiptBusinessConfig({ ...business, ctl_rate: 0 }, undefined, 0, {}), 80));
  assert.ok(!lines.some((l) => l.startsWith('CTL')), lines.join('\n'));
  assert.equal(val(lines, 'VAT (16%)'), '172.41');
});

ok('the web callers pass the BILL with the discount and tip beside it (never bill + tip)', () => {
  const pm = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  // 0.6.27: and the delivery fee beside them.
  assert.match(pm, /cart, total: chargedTotal, discount: cappedDiscount, tip: tipAmount, deliveryFee, deliveryFree: free, change: completedOrder\.change,/);   // 0.6.33 + free
  assert.ok(!/cart, total: grandTotal/.test(pm));
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.equal((cs.match(/discount: totalDiscount/g) || []).length, 3, 'Print Bill + both kitchen fires');
  assert.match(read('apps/dashboard/src/lib/reprintReceipt.ts'), /discount:\s+cents\(o\.discount_amount \?\? 0\)/);
});
ok('the web cart and receipt show VAT and CTL at the business\'s rates, after the discount', () => {
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /const \{ vat: vatAmount, ctl: ctlAmount \} = extractTaxes\(orderTotal, vatRate, ctlRate\);/);
  assert.match(read('apps/dashboard/src/pages/pos/PaymentModal.tsx'), /extractTaxes\(chargedTotal, Number\(business\?\.vat_rate \?\? 16\)/);
  assert.match(read('apps/dashboard/src/pages/pos/ReceiptView.tsx'), /ctlRate > 0 && line\(`incl\. CTL/);
});

ok('the Minimart shows VAT only — CTL is for hotels, never a minimart (owner, 2026-09-28)', () => {
  const mm = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
  assert.match(mm, /const \{ vat \} = extractTaxes\(subtotal, vatRate, 0\);/);
  assert.ok(!/ctl/i.test(mm.replace(/\/\/[^\n]*/g, '')), 'no CTL in the Minimart code');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
