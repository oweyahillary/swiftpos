// One design for both POS — screen 1, the payment screen (owner decision 2026-11-04, docs/POS-SCREEN-COMPARISON.html;
// docs/SHARED-COMPONENTS-PLAN.md section 8j).
//
// The desktop POS is the base; from the web it gains quick cash, tip buttons, split evenly per person and by item per
// guest. The web gains the desktop's Discount box, a reference on every non-cash payment and the M-Pesa prompt inside a
// split payment. Each piece is built once (@zaptill/ui QuickCash, TipPicker, DiscountBox, BillSplit; the rules in
// @zaptill/core/tender) and used by both payment screens.
//
//   1  the rules: quickTenders is the web's old rule exactly (every amount 1–6,000 in cents steps of 7), the even and
//      by-item shares always add up to the bill, the tip buttons, the points estimate as before
//   2  the pieces drawn (react-dom/server, the web's look): Exact and the notes, the tip buttons and Clear, the discount
//      box and its capped words, the split's ways and shares
//   3  the desktop's payment screen uses them (split loaded on demand), the web's too; both double-charge guards kept;
//      the old web panels and the unused files are gone
//
// Mutations it catches (each tried): quickTenders without the round 1,000 → section 1 fails; evenShares leaving the rounding off
// → section 1 fails; TipPicker without Clear → section 2 fails; the desktop importing BillSplitPanel statically → section 3 fails; the web
// dropping `|| l.prompted` → section 3 fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split('\n')[0]}`); }
};

const T = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/tender.ts')).href);

console.log('\n1. the rules (@zaptill/core/tender)\n');

/** The web POS's quick tenders before 2026-11-04 (PaymentModal.tsx), word for word. */
function oldQuickTenders(base) {
  const notes = [50, 100, 200, 500, 1000];
  const set = new Set();
  set.add(Math.ceil(base));
  notes.filter(n => n >= base).slice(0, 2).forEach(n => set.add(n));
  set.add(Math.ceil(base / 100) * 100);
  if (base > 1000) set.add(Math.ceil(base / 1000) * 1000);
  return Array.from(set).filter(v => v >= base).sort((a, b) => a - b).slice(0, 4);
}
await ok('quick cash: the web\'s rule exactly, every amount from 0.07 to 6,000', () => {
  for (let c = 7; c <= 600000; c += 7) {
    const due = c / 100;
    assert.deepEqual(T.quickTenders(due), oldQuickTenders(due), `due ${due}`);
  }
});
await ok('quick cash: 1,080 → Exact, 1,100, 2,000; 0 → none', () => {
  assert.deepEqual(T.quickTenders(1080), [1080, 1100, 2000]);
  assert.equal(T.isExactTender(1080, 1080), true);
  assert.equal(T.isExactTender(1081, 1080.4), true);
  assert.deepEqual(T.quickTenders(0), []);
});
await ok('evenly: the shares add up to the bill, the rounding on person 1', () => {
  for (const [total, n] of [[1000, 3], [999.99, 7], [0.05, 2], [12345.67, 12], [100, 2]]) {
    const s = T.evenShares(total, n);
    assert.equal(s.length, n);
    assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - total) < 0.005, `${total}/${n}`);
    assert.ok(s.slice(1).every((x) => x === s[1]) && s[0] >= s[1]);
  }
  assert.deepEqual(T.evenShares(1000, 3), [333.34, 333.33, 333.33]);
  assert.equal(T.evenShares(100, 1).length, 2, 'never fewer than two people');
});
await ok('by item: scaled to the bill (discount and tip), the rounding on the first guest with something', () => {
  const lines = [400, 250, 350];   // 1,000 of lines, a bill of 1,050 (a tip)
  const s = T.itemShares(lines, [0, 1, 1], 3, 1050);
  assert.deepEqual(s, [420, 630, 0]);
  assert.equal(T.itemSplitReady(s, 1050), true);
  assert.equal(T.itemSplitReady(T.itemShares(lines, [0, 0, 0], 2, 1000), 1000), false, 'one guest has it all');
  const odd = T.itemShares([333.33, 333.33, 333.34], [0, 1, 2], 3, 999.99);
  assert.ok(Math.abs(odd.reduce((a, b) => a + b, 0) - 999.99) < 0.005);
});
await ok('tips: 5 / 10 / 15 % to the cent; which button a tip is', () => {
  assert.deepEqual([...T.TIP_PERCENTS], [5, 10, 15]);
  assert.equal(T.tipAt(1234, 10), 123.4);
  assert.equal(T.tipPercentOf(123.4, 1234), 10);
  assert.equal(T.tipPercentOf(50, 1234), null);
  assert.equal(T.tipPercentOf(0, 1234), null);
});
await ok('loyalty points: 1 per KES 10, times the tier (the web\'s estimate as before)', () => {
  for (const [total, m] of [[999, 1], [1000, 1.5], [12345, 2], [9, 1]]) assert.equal(T.pointsEarned(total, m), Math.floor(Math.floor(total / 10) * m));
});

console.log('\n2. the pieces, drawn (@zaptill/ui, the web\'s look)\n');
const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.pay-'));
try {
  const entry = path.join(bundleDir, 'entry.tsx');
  fs.writeFileSync(entry, [
    "export { default as QuickCash } from '@zaptill/ui/QuickCash';",
    "export { default as TipPicker } from '@zaptill/ui/TipPicker';",
    "export { default as DiscountBox } from '@zaptill/ui/DiscountBox';",
    "export { default as BillSplit } from '@zaptill/ui/BillSplit';",
    `export * from ${JSON.stringify(path.join(DASH, 'src/pages/pos/paymentLooks.ts').split(path.sep).join('/'))};`,
  ].join('\n'));
  await require('esbuild').build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(bundleDir, 'out.mjs'),
    logLevel: 'silent', jsx: 'automatic', preserveSymlinks: true, nodePaths: [path.join(DASH, 'node_modules')],
    external: ['react', 'react-dom', 'react/jsx-runtime'] });
  const U = await import(pathToFileURL(path.join(bundleDir, 'out.mjs')).href);
  const h = require('react').createElement;
  const { renderToStaticMarkup: html } = require('react-dom/server');
  const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  await ok('QuickCash: Exact, then the amounts; the chosen one pressed', () => {
    const out = html(h(U.QuickCash, { due: 1080, given: 1100, onPick() {}, format: (n) => n.toLocaleString('en-KE'), look: U.QUICK_CASH_LOOK }));
    assert.equal(text(out), 'Exact 1,100 2,000');
    assert.match(out, /aria-pressed="true"[^>]*>1,100</);
  });
  await ok('TipPicker: 5% 10% 15%, the typed box, Clear only with a tip', () => {
    const none = html(h(U.TipPicker, { base: 1000, tip: 0, onTip() {}, currency: 'KES', format: (n) => `KES ${n}`, look: U.TIP_LOOK }));
    assert.match(text(none), /^Tip 5% 10% 15%$/);
    assert.doesNotMatch(none, /tip-clear/);
    const ten = html(h(U.TipPicker, { base: 1000, tip: 100, onTip() {}, currency: 'KES', format: (n) => `KES ${n}`, look: U.TIP_LOOK }));
    assert.match(text(ten), /\+ KES 100/);
    assert.match(ten, /aria-pressed="true"[^>]*data-testid="tip-10"/);
    assert.match(ten, /data-testid="tip-clear"/);
  });
  await ok('DiscountBox: the amount / % switch and the capped words', () => {
    const out = html(h(U.DiscountBox, { value: '25', mode: 'percent', onValue() {}, onMode() {}, currency: 'KES', capped: 'Capped at 10% — KES 100 applied. Ask a manager for more.', look: U.DISCOUNT_LOOK }));
    assert.match(text(out), /Discount %/);
    assert.match(text(out), /Ask a manager for more\./);
  });
  await ok('BillSplit: evenly by default (People, each), By item offered with two lines or more', () => {
    const shares = [];
    const out = html(h(U.BillSplit, { total: 1000, lines: [{ name: 'Tea', qty: 1, amount: 400 }, { name: 'Cake', qty: 2, amount: 600 }],
      format: (n) => `KES ${n.toFixed(2)}`, look: U.BILL_SPLIT_LOOK, children: (s, ready) => { shares.push(...s); return ready ? 'READY' : 'WAIT'; } }));
    assert.match(text(out), /Evenly By item People − 2 \+ KES 500\.00 each READY/);
    assert.deepEqual(shares, [{ who: 'Person 1', amount: 500 }, { who: 'Person 2', amount: 500 }]);
    const one = html(h(U.BillSplit, { total: 300, lines: [{ name: 'Tea', qty: 1, amount: 300 }], format: String, look: U.BILL_SPLIT_LOOK, children: () => null }));
    assert.doesNotMatch(one, /split-by-item/, 'one line: evenly only');
  });
  await ok('the by-item way: a guest\'s chips per line, "Put items on at least 2 guests" until they are', () => {
    const out = html(h(U.BillSplit, { total: 1000, initialWay: 'items', lines: [{ name: 'Tea', qty: 1, amount: 400 }, { name: 'Cake', qty: 2, amount: 600 }],
      format: (n) => `KES ${n.toFixed(2)}`, look: U.BILL_SPLIT_LOOK, children: (s, ready) => (ready ? 'READY' : 'WAIT') }));
    assert.match(text(out), /Guests − 2 \+ 1× Tea KES 400\.00 G1 G2 2× Cake KES 600\.00 G1 G2 WAIT/);
  });
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}

console.log('\n3. both payment screens use them\n');
const desk = read('apps/desktop/src/renderer/components/PaymentModal.tsx');
const web = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
await ok('the desktop: quick cash on a cash payment, the tip buttons (not On account), the Discount box', () => {
  assert.match(desk, /\{leg\.method === 'cash' && \(\s*<QuickCash due=\{leg\.resolvedAmount\}/);
  assert.match(desk, /\{!onAccountChosen && <TipPicker base=\{total\}/);
  assert.match(desk, /const tipRaw = onAccountChosen \? 0 : tipChosen;/);
  assert.match(desk, /\{allowDiscount && showAdjustments && \(\s*<DiscountBox/);
});
await ok('the desktop: Split the bill loads on demand and becomes one payment per person', () => {
  assert.match(desk, /const BillSplitPanel = lazy\(\(\) => import\('\.\/BillSplitPanel'\)\);/);
  assert.doesNotMatch(desk, /^import BillSplitPanel/m);
  assert.match(desk, /setLegs\(shares\.map\(\(sh\) => \(\{ method: firstMethod, amount: String\(sh\.amount\), tendered: '', reference: '', who: sh\.who \}\)\)\);/);
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /lines=\{cart\.map\(\(i\) => \(\{ name: i\.product\.name, qty: i\.quantity, amount: i\.lineTotal \}\)\)\}/);
});
await ok('the web: the same pieces; Split the bill (evenly / by item) behind one choice; the Discount box with sales.discount', () => {
  for (const piece of ['QuickCash', 'TipPicker', 'DiscountBox']) assert.match(web, new RegExp(`import ${piece}[^\\n]* from '@zaptill/ui/${piece}';`));
  assert.match(web, /<SplitBillPanel/);
  assert.match(read('apps/dashboard/src/pages/pos/SplitBillPanel.tsx'), /import BillSplit, \{[^}]*\} from '@zaptill\/ui\/BillSplit';/);
  assert.match(web, /const mayTypeDiscount = hasPermission\('sales\.discount'\);/);
  assert.match(web, /const rawDiscount\s+= rawLoyaltyDiscount \+ promoOff \+ manualOff;/);
});
await ok('the web: a reference on a card or another non-cash payment; the prompt inside a split payment is recorded as paid', () => {
  assert.match(web, /const takesReference = method !== 'cash' && method !== 'mpesa' && method !== 'credit' && !platform;/);
  assert.match(web, /reference:\s+platform \? \(platformRef\.trim\(\) \|\| null\) : takesReference \? \(reference\.trim\(\) \|\| null\) : null,/);
  assert.match(web, /\(claims\.isTaken\(l\.reference\) \|\| l\.prompted\) \? \{ status: 'completed' \}/);
  const stk = read('apps/dashboard/src/pages/pos/MpesaStkPanel.tsx');
  assert.match(stk, /: await api\.post<\{ checkoutRequestId: string \}>\('\/api\/mpesa\/stk-push-pos', \{/);
  assert.match(read('apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx'), /<MpesaStkPanel total=\{leg\.amount\}/);
});
await ok('both double-charge guards kept (the desktop\'s placingRef; the web\'s chargingRef and idempotency key)', () => {
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /if \(placingRef\.current\) return;/);
  assert.equal((web.match(/if \(chargingRef\.current\) return;/g) ?? []).length, 2);
  assert.match(web, /idempotency_key: idempotencyKeyRef\.current,/);
});
await ok('the web\'s old panels and the files no screen used are gone', () => {
  for (const f of ['EvenSplitPanel', 'ByItemSplitPanel', 'DiscountPanel', 'LoyaltyPanel', 'PetrolPOS']) {
    assert.equal(fs.existsSync(path.join(ROOT, `apps/dashboard/src/pages/pos/${f}.tsx`)), false, f);
  }
});
await ok('the shared pieces hold no class names (each app\'s look is in its own paymentLooks.ts)', () => {
  for (const f of ['QuickCash.tsx', 'TipPicker.tsx', 'DiscountBox.tsx', 'BillSplit.tsx']) {
    assert.doesNotMatch(read(`packages/ui/src/${f}`), /className=|\b(?:bg|text|border)-(?:gray|white|action)/, f);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
