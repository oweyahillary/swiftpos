/**
 * order-notes.test.mjs — A367 (0.6.24): notes on an item and on the whole order, on the cloud and the web.
 *
 * Owner, 2026-09-30: "can we add notes in the order maybe if a customer wants a mixture of 3 normal and 2 spicy chicken
 * pieces or they want exta cheese if it pizza or no salt etc".
 *
 *   node tests/order-notes.test.mjs
 *
 * RUNS the cloud's copy of the rules (apps/server/src/lib/orderNotes.ts, type-stripped) and the web's receipt builder
 * (apps/dashboard/src/lib/buildReceiptOrder.ts, type-stripped); pins the routes and screens (the order route needs the
 * database; React is not run). The till's side is apps/desktop/test/order-notes.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: the order note written without the business_id scope → its pin fails; the RPC items
 * payload storing item.notes raw → "cleaned before storing" fails; pos/init without noteQuickPicks → its pin fails;
 * order_note_picks off the readable list → its pin fails; buildReceiptOrder dropping the line note → "the web receipt…"
 * fails; the web's plain tap merging into a noted line → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.ORDER_NOTES_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, ORDER_NOTES_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const N = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/orderNotes.ts')).href);

console.log('A367 — notes on an item and on the order (cloud + web)\n');

// ── The cloud's rules ────────────────────────────────────────────────────────
ok('the cloud cleans a note the same way the till does', () => {
  assert.equal(N.cleanNote('  3 normal \n\n 2 spicy '), '3 normal\n2 spicy');
  assert.equal(N.cleanNote(' '), null);
  assert.equal(N.cleanNote('z'.repeat(999), N.ORDER_NOTE_MAX).length, N.ORDER_NOTE_MAX);
});
ok('quick picks: unset → defaults, saved [] → none', () => {
  assert.deepEqual(N.parseNotePicks(undefined), [...N.DEFAULT_NOTE_PICKS]);
  assert.deepEqual(N.parseNotePicks('[]'), []);
  assert.deepEqual(N.parseNotePicks('["Spicy","spicy","Mild"]'), ['Spicy', 'Mild']);
});

// ── The cloud's routes ───────────────────────────────────────────────────────
const orders = read('apps/server/src/routes/orders.ts');
ok('a line note is cleaned before storing — the sale (RPC) and the dine-in open', () => {
  assert.match(orders, /notes: cleanNote\(item\.notes\),   \/\/ A367/);
  assert.match(orders, /notes:\s+cleanNote\(item\.notes\),   \/\/ A367/);
  assert.doesNotMatch(orders, /notes:\s+item\.notes \?\? null/);
});
ok('the order note is written after the sale exists, scoped to this business, and never fails the sale', () => {
  assert.match(orders, /const orderNote = cleanNote\(orderNoteRaw, ORDER_NOTE_MAX\);\s*if \(orderNote\) \{\s*const \{ error: noteErr \} = await supabase\.from\('orders'\)\.update\(\{ notes: orderNote \}\)\s*\.eq\('id', createdRow\.order_id\)\.eq\('business_id', req\.businessId\);\s*if \(noteErr\) console\.error/);
  assert.ok(orders.indexOf('const orderNote = cleanNote(orderNoteRaw') > orders.indexOf("rpc('create_order_atomic'"));
});
ok('a dine-in order opened from the web keeps its order note', () => {
  assert.match(orders, /notes:\s+cleanNote\(orderNoteRaw, ORDER_NOTE_MAX\),   \/\/ A367/);
});
ok('pos/init sends the quick picks (always a list)', () => {
  const pos = read('apps/server/src/routes/pos.ts');
  assert.match(pos, /'continuous_operation', 'business_day_cutoff', 'order_note_picks',\s*\.\.\.REVERSAL_SETTING_KEYS\]\)/);   // 0.6.30: + the owner's void/refund rules
  assert.match(pos, /\n\s+noteQuickPicks: parseNotePicks\(receiptTextRows\?\.find\(\(r: any\) => r\.key === 'order_note_picks'\)\?\.value\)/);
});
ok('the owner\'s list is readable by the settings page', () => {
  assert.match(read('apps/server/src/routes/business.ts'), /'kitchen_exclusions',\s*\/\/ A367[^\n]*\n\s*'order_note_picks',/);
});
ok('the kitchen display and the till\'s web-sales download read the notes', () => {
  assert.match(read('apps/server/src/routes/kitchen.ts'), /order_number, order_type, notes,/);
  const shifts = read('apps/server/src/routes/shifts.ts');
  assert.match(shifts, /refund_reason, delivery_person, notes,/);
  assert.match(shifts, /course, fire_status, notes \),/);
});
ok('schema 58 or later is the required desktop schema', () => {
  const m = read('apps/server/src/lib/desktopSchema.ts').match(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/);
  assert.ok(m && Number(m[1]) >= 58, m?.[0]);
});

// ── The web ──────────────────────────────────────────────────────────────────
const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href).catch(() => null);
ok('the web receipt carries the line notes and the order note', () => {
  const src = read('apps/dashboard/src/lib/buildReceiptOrder.ts');
  assert.match(src, /note:\s+c\.notes \|\| undefined,   \/\/ A367/);
  assert.match(src, /note:\s+a\.orderNote \|\| undefined,   \/\/ A367/);
  if (B?.buildReceiptOrder) {
    const o = B.buildReceiptOrder({ orderNumber: '1', orderType: 'takeaway', cashierName: 'T', total: 250, change: 0, payments: [],
      cart: [{ product: { id: 'p', name: 'Chicken' }, quantity: 1, unitPrice: 250, lineTotal: 250, selectedVariants: [], selectedModifiers: [], notes: 'No salt' }],
      orderNote: 'Gate B' });
    assert.equal(o.lines[0].note, 'No salt');
    assert.equal(o.note, 'Gate B');
  }
});
ok('the web kitchen print carries the notes', () => {
  const pr = read('apps/dashboard/src/lib/printRouted.ts');
  assert.match(pr, /note: item\.notes \|\| undefined,   \/\/ A367/);
  assert.match(pr, /note: a\.orderNote \|\| undefined,   \/\/ A367/);
  assert.match(read('apps/dashboard/src/lib/reprintReceipt.ts'), /note: it\.notes \|\| undefined/);
});
ok('the web sale sends each line\'s note and the order\'s note', () => {
  const pm = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.match(pm, /notes:\s+item\.notes \?\? null,   \/\/ A367/);
  assert.match(pm, /notes: orderNote\?\.trim\(\) \|\| null,   \/\/ A367/);
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /notes:\s+orderNote\.trim\(\) \|\| null,   \/\/ A367/);        // Send to kitchen (/open)
  assert.match(cs, /orderNote=\{orderNote\}/);
  assert.equal((cs.match(/orderNote,   \/\/ A367/g) ?? []).length, 3);             // kitchen, pay-first kitchen, guest check
});
ok('a web tap never joins a line that carries a note', () => {
  assert.match(read('apps/dashboard/src/pages/pos/cashier/useCart.ts'),
    /prev\.find\(i => i\.product\.id === product\.id && i\.selectedVariants\.length === 0 && !i\.notes\)/);
});
ok('the web cashier screen has the note editor on lines and on the order, with the owner\'s picks', () => {
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /data-testid="line-note-btn"/);
  assert.match(cs, /data-testid="order-note-btn"/);
  assert.match(cs, /picks=\{notePicks\}/);
  assert.match(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts'), /setNotePicks\(parseNotePicks\(init\.noteQuickPicks \?\? null\)\)/);
});
ok('the owner edits the quick picks beside the kitchen list', () => {
  const rs = read('apps/dashboard/src/pages/settings/RestaurantSettingsPage.tsx');
  assert.match(rs, /Quick notes for orders/);
  assert.match(rs, /saveSetting\('order_note_picks', JSON\.stringify\(list\)\)/);
});
ok('the kitchen display shows the order note above the dishes', () => {
  assert.match(read('apps/dashboard/src/pages/kds/KDSPage.tsx'), /\{ticket\.orders\?\.notes && \(/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
