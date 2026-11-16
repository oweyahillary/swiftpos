/**
 * table-move-kitchen.test.mjs — Transfer table tells the kitchen (owner, 2026-11-05: "a kitchen 'moved to Table N' slip
 * after Transfer", from the 8l report).
 *
 * A dine-in order the kitchen already has moves to another table: the kitchen gets what it has of the order again under
 * MOVED, with the new table and "From table <old>" (shared/printing's production ticket), so the food goes to the right
 * table. The desktop's side (kitchen:move, its ledger) is run in apps/desktop/test/print-bill-transfer.test.mjs (M).
 *
 *   node --no-warnings tests/table-move-kitchen.test.mjs
 *
 *   K  the REAL web bundle (escposRenderer.js, built from shared/printing): a kitchen ticket with `moved` reads MOVED, the
 *      new table and the old one; without it the bytes are what they were (no MOVED, no "From table").
 *   W  the web POS (source): the order, its cloud id and its ticket number move to the new table together; one the kitchen
 *      has had is moved on the cloud and its sent lines print under MOVED at kitchen and dispatch only.
 *   C  the cloud (source): POST /api/orders/:id/move-table — whoever may sell, the caller's business and branch, an open
 *      dine-in order only, the table required.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - render.ts without the MOVED banner                                 → K "MOVED, the new table, the old one"
 *   - printRouted not passing `moved` to the station                     → W "passes moved to every station"
 *   - transferTable not moving sentOrderNumbers                          → W "the ticket number moves too"
 *   - the route without .eq('status', 'open') on the update              → C "an open dine-in order only"
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.TABLE_MOVE_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, TABLE_MOVE_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 800)}`); fail++; } };

try {
  const B = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
  const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);

  console.log('\nK. The kitchen ticket (the web bundle)');
  const biz = B.buildReceiptBusinessConfig({ name: 'B Foods', currency: 'KES', vat_rate: 16 }, undefined, 0, {});
  const order = { billNumber: 'W-7', orderType: 'dine_in', tableNumber: '7', cashierName: 'Amina', soldAt: '2026-11-05T09:00:00Z',
    kotCount: 0, lines: [{ name: 'Wings', quantity: 2, unitPrice: 65000, lineTotal: 130000, units: [], stationIds: ['k1'] }],
    payments: [], changeGiven: 0, total: 130000 };
  const text = (bytes) => Buffer.from(bytes).toString('latin1');
  const moved = text(E.renderStationEscPos(order, biz, { id: 'k1', type: 'kitchen', paperWidthMm: 80, moved: { from: '4' } }));
  const plain = text(E.renderStationEscPos(order, biz, { id: 'k1', type: 'kitchen', paperWidthMm: 80 }));
  ok('MOVED, the new table, the old one', moved.includes('MOVED') && moved.includes('Table  7') && moved.includes('From table  4'), moved);
  ok('the dishes the kitchen has are on it', /Wings/i.test(moved));
  ok('without a move: no MOVED, no "From table"', !plain.includes('MOVED') && !plain.includes('From table'));
  ok('without a move: the table line as before, and a shorter ticket', plain.includes('Table  7') && plain.length < moved.length);

  console.log('\nW. The web POS');
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const tt = cs.slice(cs.indexOf('async function transferTable()'), cs.indexOf('// Fire a held course'));
  ok('the Transfer button calls transferTable', cs.includes('onClick={() => { void transferTable(); }}'));
  ok('the order, its cloud id and its ticket number move to the new table together',
    tt.includes('setSentOrderIds(rekey);') && tt.includes('setOpenOrders(prev => rekey('), tt);
  ok('the ticket number moves too', tt.includes('setSentOrderNumbers(rekey);'), tt);
  ok('an order not yet sent stops there (nothing for the cloud or the kitchen)', /setTransferTarget\(null\);\s+if \(!sentId\) return;/.test(tt), tt);
  ok('one the kitchen has had is moved on the cloud', tt.includes("await posApi.post(`/api/orders/${sentId}/move-table`, { table_number: target.name });"), tt);
  ok('its sent lines print under MOVED, at kitchen and dispatch only',
    tt.includes('const withKitchen = cart.filter(it => it.order_item_id);')
      && /kinds: \['kitchen', 'dispatch'\], moved: \{ from: String\(order\.tableName \?\? ''\) \}/.test(tt), tt);
  const pr = read('apps/dashboard/src/lib/printRouted.ts');
  ok('printRouted passes moved to every station', pr.includes('voided: a.voided, moved: a.moved };'));

  console.log('\nC. The cloud');
  const o = read('apps/server/src/routes/orders.ts');
  const route = o.slice(o.indexOf("router.post('/:id/move-table'"), o.indexOf('// A8: PATCH /api/orders/:id/split'));
  ok('whoever may sell (orders.create)', route.startsWith("router.post('/:id/move-table', sells,"), route.slice(0, 80));
  ok('the table is required', route.includes("if (!table) { res.status(400)"), route);
  ok('the caller\'s business and branch', route.includes(".eq('business_id', req.businessId).maybeSingle()") && route.includes('assertBranchAccess(req, order.branch_id)'), route);
  ok('an open dine-in order only (checked, and the update itself scoped to open)',
    route.includes("order.status !== 'open' || order.order_type !== 'dine_in'")
      && /\.update\(\{ table_number: table \}\)\.eq\('id', order\.id\)\.eq\('business_id', req\.businessId\)\.eq\('status', 'open'\)/.test(route), route);
  // Offline replay (Till stage 2): a table moved with no connection is buffered and replayed by the TILL's own order id
  // (idempotency_key), so the route resolves it with cloudOrderId before looking the order up — as void/refund/pay do.
  ok('a table moved offline replays by the till\'s own id (cloudOrderId)',
    route.includes('await cloudOrderId(req.params.id, req.businessId!)') && route.includes(".eq('id', orderId)"), route);
  const fc = o.slice(o.indexOf("router.post('/:id/fire-course'"), o.indexOf("router.post('/:id/move-table'"));
  ok('a course fired offline replays by the till\'s own id too (cloudOrderId)',
    fc.includes('await cloudOrderId(req.params.id, req.businessId!)'), fc.slice(0, 200));
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
