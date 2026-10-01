/**
 * prospect-features.test.mjs — 0.6.27: a prospect's requests, switched per client in the admin portal (cloud + web).
 *
 * Owner, 2026-09-30: "we can find a way of turning this features on and off per clients requests rather than killing
 * some of them totally". The till's side runs for real in apps/desktop/test/prospect-features.test.mjs.
 *
 *   node tests/prospect-features.test.mjs
 *
 * RUNS the shared rules (type-stripped: posFeatures, delivery, expenseMethod, confirmReasons, historyView) and the
 * cloud's expense validation (lib/schemas.ts CreateExpenseSchema, zod); pins the routes and screens (they need the
 * database / React). Migration 111 runs for real in scripts/test-migration-111.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: pos/init without posFeatures → its pin fails; PUT /api/flags lets a client set a POS switch
 * → "the client cannot" fails; the order list without the own-sales filter → its pin fails; a till's sale also paid to
 * the rider by the cloud (no surface check) → "never twice" fails; shiftExpenses counting every expense → "only cash"
 * fails; CreateExpenseSchema back to category/date → "the dashboard's expense is accepted" fails; the confirm route
 * without the reasons check → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.PROSPECT_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, PROSPECT_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lib = (f) => import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib', f)).href);
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const F = await lib('posFeatures.ts');
const D = await lib('delivery.ts');
const X = await lib('expenseMethod.ts');
const Q = await lib('confirmReasons.ts');
const H = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/historyView.ts')).href);

console.log('0.6.27 — the prospect\'s requests (cloud + web)\n');

// ── The switches ─────────────────────────────────────────────────────────────
await ok('five switches, all off unless set; rows, objects and JSON read the same', () => {
  assert.deepEqual(F.POS_FEATURE_KEYS, ['blind_shift_close', 'delivery_fee', 'cashier_own_history', 'cashier_no_reprint', 'confirm_shows_cashier_figures', 'kitchen_void_approval', 'pay_before_kitchen']);   // 0.6.28 adds the last two
  assert.ok(Object.values(F.parsePosFeatures(null)).every((v) => v === false));
  assert.equal(F.parsePosFeatures([{ key: 'delivery_fee', enabled: true }, { key: 'loyalty_enabled', enabled: true }]).delivery_fee, true);
  assert.equal(F.parsePosFeatures('{"delivery_fee":"true"}').delivery_fee, false);
  assert.equal(F.parsePosFeatures('not json').delivery_fee, false);
});
await ok('pos/init sends every switch (an older till ignores it)', () => {
  assert.match(read('apps/server/src/routes/pos.ts'), /\n\s+posFeatures: await \(async \(\) => \{\s*const \{ data \} = await supabase\.from\('feature_flags'\)\.select\('key, enabled'\)\s*\.eq\('business_id', req\.businessId\)\.in\('key', \[\.\.\.POS_FEATURE_KEYS\]\);\s*return parsePosFeatures\(data \?\? \[\]\);/);
});
await ok('the client cannot set a POS switch — only the admin portal (owner\'s decision)', () => {
  assert.match(read('apps/server/src/routes/flags.ts'), /if \(\(POS_FEATURE_KEYS as readonly string\[\]\)\.includes\(req\.params\.key\)\) \{\s*res\.status\(403\)/);
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.match(ap, /\{POS_FEATURES\.map\(pf => \{/);
  assert.match(ap, /onClick=\{\(\) => toggleFeature\(pf\.key, !on\)\}/);
});

// ── 2 + 3 + 4: the delivery fee ──────────────────────────────────────────────
await ok('a delivery with the switch needs a rider and a fee; without it, as before', () => {
  assert.equal(D.deliveryProblem(true, 'delivery', ' ', 300), 'Enter the rider’s name for this delivery.');
  assert.equal(D.deliveryProblem(true, 'delivery', 'Eugene', ''), 'Enter the delivery fee for this delivery.');
  assert.equal(D.deliveryProblem(true, 'delivery', 'Eugene', '300'), null);
  assert.equal(D.deliveryProblem(false, 'delivery', '', ''), null);
  assert.equal(D.deliveryProblem(true, 'takeaway', '', ''), null);
});
await ok('the fee is cleaned (never negative, never absurd); the customer pays bill + tip + fee', () => {
  assert.equal(D.cleanDeliveryFee('1,250.456'), 1250.46);
  assert.equal(D.cleanDeliveryFee(-5), 0);
  assert.equal(D.cleanDeliveryFee(1e9), 0);
  assert.equal(D.amountDue(1000, 50, 300), 1350);
});
await ok('History reads "Delivery — Eugene"; the pay-out names the rider and the bill', () => {
  assert.equal(D.orderTypeLabel('delivery', '  Eugene '), 'Delivery — Eugene');
  assert.equal(D.orderTypeLabel('dine_in'), 'Dine in');
  assert.equal(D.riderPayoutReason('Eugene', 'T1-7'), 'Delivery fee — Eugene (#T1-7)');
});
const orders = read('apps/server/src/routes/orders.ts');
await ok('the sale reconciles bill + tip + fee (create_order_atomic, migration 111) and stores the fee', () => {
  assert.match(orders, /const deliveryFee = order_type === 'delivery' \? cleanDeliveryFee\(deliveryFeeRaw\) : 0;/);
  assert.match(orders, /delivery_fee: deliveryFee,   \/\/ 0\.6\.27/);
  assert.match(read('migrations/111_prospect_requests.sql'), /v_due   := v_total \+ v_tip \+ v_fee;/);
});
await ok('a web sale\'s rider is paid from its shift\'s drawer — never twice for a till\'s sale (the till pays its own)', () => {
  assert.match(orders, /if \(deliveryFee > 0 && req\.surface !== 'desktop'\) \{\s*await payRider\(/);
  assert.match(orders, /if \(payFee > 0 && req\.surface !== 'desktop'\) \{\s*await payRider\(/);
  assert.match(orders, /if \(Number\(\(order as any\)\.delivery_fee \?\? 0\) > 0\) await returnRiderPayout\(orderId\);/);
});
await ok('a tab paid later (/pay) collects the fee too, and the web sends it', () => {
  assert.match(orders, /const payFee = order\.order_type === 'delivery' \? cleanDeliveryFee\(deliveryFeeRaw\) : 0;\s*const amountDue = round2\(payTotal \+ payTip \+ payFee\);/);
  const pm = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.match(pm, /const grandTotal    = Math\.round\(\(chargedTotal \+ tipAmount \+ deliveryFee\) \* 100\) \/ 100;/);
  // Merged with the owner's web /pay fix (buildPayPayload carries discount + tip): the fee rides the same body.
  assert.equal((pm.match(/existingOrderId \? buildPayPayload\(payments\) : buildOrderPayload\(payments\)/g) ?? []).length, 2);
  assert.match(pm, /function buildPayPayload\(payments: object\[\]\) \{[\s\S]{0,300}\.\.\.\(deliveryFee > 0 \? \{ delivery_fee: deliveryFee \} : \{\}\),/);
});
await ok('the web POS asks the rider and fee before Charge (switch on)', () => {
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /const problem = deliveryProblem\(posFeatures\.delivery_fee, getOrderType\(\), activeRider, activeFeeText\);/);
  assert.equal((cs.match(/openPayment\((false|true)\)/g) ?? []).length, 3);
});

// ── 5 + 9: expenses ──────────────────────────────────────────────────────────
await ok('only a cash expense leaves the drawer; the others come off their own method', () => {
  assert.equal(X.cleanExpenseMethod(' M-Pesa '), 'm_pesa');
  assert.equal(X.cleanExpenseMethod(null), 'cash');
  assert.deepEqual(X.nonCashExpenses([{ amount: 200, payment_method: 'cash' }, { amount: 1200, payment_method: 'mpesa' }, { amount: 50 }]), { mpesa: 1200 });
  const sh = read('apps/server/src/routes/shifts.ts');
  assert.match(sh, /\.from\('expenses'\)\.select\('amount'\)\.eq\('shift_id', shiftId\)\s*\/\/[^\n]*\n\s*\.eq\('payment_method', 'cash'\);/);
  assert.match(sh, /\.from\('expenses'\)\.select\('id, amount'\)\.eq\('shift_id', id\)\.eq\('payment_method', 'cash'\);/);
  assert.match(sh, /for \(const \[m, v\] of Object\.entries\(nonCashExpenses\(spentRows \?\? \[\]\)\)\) out\[m\] =/);
  assert.match(read('apps/server/src/routes/sync.ts'), /payment_method:      cleanExpenseMethod\(e\.payment_method\),/);
});
await ok('the Z-report line is the TYPE first, then the description, then the method when not cash', () => {
  assert.equal(X.expenseLabel('Transport', 'boda to market', 'cash'), 'Transport — boda to market');
  assert.equal(X.expenseLabel('Gas', 'gas', 'mpesa'), 'Gas · M-Pesa');
  assert.equal(X.expenseLabel(null, 'Airtime', null), 'Airtime');
});
await ok('the dashboard\'s expense is accepted (it was refused "Validation failed" — the schema asked for category/date)', async () => {
  const { CreateExpenseSchema } = await lib('schemas.ts');
  const r = CreateExpenseSchema.safeParse({ branch_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', expense_category_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c',
    description: 'Gas', amount: 500, paid_by: '', expense_date: '2026-09-30', payment_method: 'mpesa' });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.expense_category_id, '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c');   // kept, not stripped
  assert.equal(r.data.payment_method, 'mpesa');
  assert.ok(!CreateExpenseSchema.safeParse({ branch_id: 'x', description: '', amount: -1 }).success);
});

// ── 6 + 7: History ───────────────────────────────────────────────────────────
await ok('History filters and orders by payment method or type (never changes the list it is given)', () => {
  const list = [
    { created_at: '2026-09-30T10:00:00Z', order_type: 'takeaway', payments: [{ method: 'cash', amount: 100 }] },
    { created_at: '2026-09-30T11:00:00Z', order_type: 'delivery', payments: [{ method: 'mpesa', amount: 300 }] },
    { created_at: '2026-09-30T12:00:00Z', order_type: 'takeaway', payments: [{ method: 'cash', amount: 50 }, { method: 'mpesa', amount: 50 }] },
  ];
  assert.deepEqual(H.historyView(list, { sort: 'time' }).map((o) => o.created_at.slice(11, 13)), ['12', '11', '10']);
  assert.deepEqual(H.historyView(list, { method: 'cash' }).length, 1);
  assert.deepEqual(H.historyView(list, { sort: 'type' }).map((o) => o.order_type), ['delivery', 'takeaway', 'takeaway']);
  assert.deepEqual(H.historyView(list, { sort: 'method' }).map(H.orderMethod), ['cash', 'mpesa', 'split']);
  assert.equal(list[0].created_at, '2026-09-30T10:00:00Z');
});
await ok('the cloud narrows a cashier to their own sales and says whether Reprint is offered (a manager sees all)', () => {
  assert.match(orders, /const ownOnly = !manager && features\.cashier_own_history;\s*if \(ownOnly\) query = query\.eq\('cashier_id', req\.userId/);
  assert.match(orders, /can_reprint: manager \|\| !features\.cashier_no_reprint/);
  const h = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(h, /\{canReprint && <button/);
  assert.match(h, /\{orderTypeLabel\(order\.order_type, order\.delivery_person\)\}/);
});

// ── 1 + 8: the blind close, the manager's reasons ────────────────────────────
await ok('a blind close: the cloud hands a cashier no figures and asks no variance note', () => {
  const sh = read('apps/server/src/routes/shifts.ts');
  assert.match(sh, /if \(!callerMayConfirm\(req\) && \(await businessPosFeatures\(req\.businessId\)\)\.blind_shift_close\) \{\s*res\.json\(\{\s*id: shift\.id,[^}]*blind: true, declare_methods: declareMethods,/);
  assert.match(sh, /if \(!isManager && \(await businessPosFeatures\(req\.businessId\)\)\.blind_shift_close\) \{\s*res\.json\(\{ \.\.\.closed, expected_cash: null, cash_variance: null, blind: true,/);
  assert.match(sh, /&& !\(!callerMayConfirm\(req\) && \(await businessPosFeatures\(req\.businessId\)\)\.blind_shift_close\)\) \{/);
});
await ok('a differing count needs a reason; only the differing ones are kept', () => {
  assert.deepEqual(Q.reasonsNeeded({ cash: 1234, mpesa: 100 }, { cash: 1200, mpesa: 100, card: 5 }), ['cash', 'card']);
  assert.deepEqual(Q.reasonsNeeded(null, { cash: 1 }), []);
  assert.deepEqual(Q.cleanReasons({ cash: '  34   float ', mpesa: 'x' }, ['cash']), { cash: '34 float' });
  assert.deepEqual(Q.missingReasons(['cash', 'card'], { cash: 'ok' }), ['card']);
  const sh = read('apps/server/src/routes/shifts.ts');
  assert.match(sh, /if \(req\.surface !== 'desktop' && \(await businessPosFeatures\(req\.businessId\)\)\.confirm_shows_cashier_figures\) \{\s*const missing = missingReasons\(needed, reasons\);/);
  assert.match(sh, /confirm_reasons: reasons \}\)/);
});
await ok('the web and dashboard confirm screens show the cashier\'s figure and send the reasons (switch on)', () => {
  const m = read('apps/dashboard/src/pages/pos/ShiftModal.tsx');
  assert.match(m, /\/api\/shifts\/\$\{closeResult\.id\}\/confirm-view/);
  assert.match(m, /const reasonsBody = confirmView\.showCashier \? \{ confirm_reasons: confirmReasons \} : \{\};/);
  const c = read('apps/dashboard/src/components/ShiftConfirmations.tsx');
  assert.match(c, /\/api\/shifts\/\$\{target\.id\}\/confirm-view/);
});
await ok('schema 59 is the required desktop schema', () => {
  assert.ok(Number(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/.exec(read('apps/server/src/lib/desktopSchema.ts'))[1]) >= 59);   // 0.6.28 moved it to 60
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
