/**
 * void-refund.test.mjs — A355 (2026-09-28): reversing a sale from the till's History.
 *
 * Owner, on v0.6.17 (M4): "i cant find where a manager refunds" — the only way in was a button labelled "Void" that
 * disappeared 30 minutes after the sale, shown to everyone including cashiers; and a refused PIN always read "Invalid
 * supervisor PIN", whatever the cloud said.
 *
 *   node test/void-refund.test.mjs
 *
 * RUNS the real src/renderer/lib/voidRefund.ts (type-stripped), then pins that POSPage, App and VoidModal use it.
 *
 * MUTATIONS TO CONFIRM BITE: `<= VOID_WINDOW_MIN` → `< 0` → "Void / Refund inside 30 minutes" fails; drop the
 * isRefunded check → "an already-refunded sale" fails; `canVoid = true` back → the POSPage pin fails; the old
 * "Invalid supervisor PIN" rewrite back in VoidModal → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.VOID_REFUND_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, VOID_REFUND_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/voidRefund.ts')).href);
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const NOW = Date.parse('2026-09-28T12:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const sale = (minAgo, extra = {}) => ({ status: 'completed', created_at: at(minAgo), total: 500, refunded_amount: 0, ...extra });

ok('inside the 30-minute void window: "Void / Refund", opening on void', () => {
  assert.deepEqual(V.reverseAction(sale(0), NOW), { label: 'Void / Refund', mode: 'void' });
  assert.deepEqual(V.reverseAction(sale(30), NOW), { label: 'Void / Refund', mode: 'void' });
});
ok('after 30 minutes the button STAYS, as "Refund" (it used to vanish)', () => {
  assert.deepEqual(V.reverseAction(sale(31), NOW), { label: 'Refund', mode: 'refund' });
  assert.deepEqual(V.reverseAction(sale(60 * 24 * 3), NOW), { label: 'Refund', mode: 'refund' });
});
ok('an already-refunded sale, a voided one, or an open one: no button', () => {
  assert.equal(V.reverseAction(sale(90, { refunded_amount: 500 }), NOW), null);
  assert.equal(V.reverseAction(sale(5, { refunded_amount: '120.00' }), NOW), null);
  assert.equal(V.reverseAction(sale(5, { status: 'voided' }), NOW), null);
  assert.equal(V.reverseAction(sale(5, { status: 'open' }), NOW), null);
});
ok('a web POS sale on this drawer gets the same buttons (A336 stage 2)', () => {
  assert.deepEqual(V.reverseAction(sale(45, { origin: 'web' }), NOW), { label: 'Refund', mode: 'refund' });
});
ok('a till clock slightly ahead never makes a negative age', () => {
  assert.equal(V.ageMinutes({ created_at: at(-3) }, NOW), 0);
  assert.equal(V.ageMinutes({ created_at: 'not a date' }, NOW), 0);
});
ok('who may void or refund: owner ("*") and orders.void — never a cashier (the owner\'s rule)', () => {
  assert.equal(V.mayVoidRefund({ permissions: { '*': true } }), true);
  assert.equal(V.mayVoidRefund({ permissions: { 'orders.void': true, 'orders.create': true } }), true);
  assert.equal(V.mayVoidRefund({ permissions: { 'orders.create': true } }), false);
  assert.equal(V.mayVoidRefund({ permissions: { 'orders.void': false } }), false);
  assert.equal(V.mayVoidRefund(null), false);
});
ok('the refusal shows the cloud\'s own words; a wrong PIN clears the box', () => {
  assert.deepEqual(V.reverseErrorMessage('That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', 'Refund failed'),
    { message: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', clearPin: true });
  const perm = V.reverseErrorMessage('This role cannot refund. A manager needs to grant the "orders.void" permission to it.', 'Refund failed');
  assert.equal(perm.clearPin, false);
  assert.match(perm.message, /cannot refund/);
  assert.deepEqual(V.reverseErrorMessage('Nobody can approve this yet. Give a staff member a manager role and a PIN in Staff.', 'x'),
    { message: 'Nobody can approve this yet. Give a staff member a manager role and a PIN in Staff.', clearPin: false });
  assert.deepEqual(V.reverseErrorMessage('', 'Refund failed'), { message: 'Refund failed', clearPin: false });
});

const pos = read('src/renderer/pages/POSPage.tsx');
ok('POSPage: History buttons from reverseAction, gated on canVoidRefund (no more "canVoid = true")', () => {
  assert.match(pos, /const canVoid = canVoidRefund;/);
  assert.ok(!/const canVoid = true;/.test(pos));
  assert.match(pos, /const reverse  = canVoid \? reverseAction\(o\) : null;/);
  assert.match(pos, /\{reverse && \(\s*<button[\s\S]*?\{reverse\.label\}/);
  assert.ok(!/ageMin <= 30/.test(pos) && !/>expired</.test(pos), 'the 30-minute cut-off and the "expired" label are gone');
  assert.match(pos, /\{isRefunded\(o\) && \(/);
});
ok('A358: History ITSELF is for everyone (0.6.18 hid it from cashiers) — only its reversal buttons are gated', () => {
  const i = pos.indexOf('{/* Order history (everyone)');
  assert.ok(i > 0, 'the History button block');
  const block = pos.slice(i, pos.indexOf('History\n', i) + 8);
  assert.ok(!/canVoid &&/.test(block), 'the History button is not wrapped in canVoid');
  assert.match(pos, /max-w-4xl max-h-\[80vh\]/, 'the wider window (the longer buttons no longer scroll sideways)');
});
ok('App passes canVoidRefund from the signed-in staff\'s permissions', () => {
  assert.match(read('src/renderer/App.tsx'), /canVoidRefund=\{mayVoidRefund\(staff\)\}/);
});
const vm = read('src/renderer/components/VoidModal.tsx');
ok('VoidModal: "Manager PIN", the cloud\'s message, no "Invalid supervisor PIN" rewrite', () => {
  assert.match(vm, />Manager PIN</);
  assert.match(vm, /const shown = reverseErrorMessage\(msg, isRefund \? 'Refund failed' : 'Void failed'\);/);
  const code = vm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/Invalid supervisor PIN/.test(code) && !/Supervisor PIN/.test(code));
  assert.match(vm, /const isExpired = ageMin > VOID_WINDOW_MIN;/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
