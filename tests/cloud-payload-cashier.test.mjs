/**
 * cloud-payload-cashier.test.mjs — A169.
 *
 * The cloud order payload must carry `cashier_id`, and the peer's direct push
 * and the node's relay must build it identically (money-critical dedupe on
 * idempotency_key keeps whichever arrives first). Runs the REAL shared builder
 * (apps/desktop/src/main/peerRelay.ts), which is import-free and pure.
 */
import { buildCloudOrderPayload } from '../apps/desktop/src/main/peerRelay.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); } };

const order = {
  branch_id: 'b1', order_number: 'A-100', order_type: 'retail',
  total: 500, payments: [{ method: 'cash', amount: 500 }],
  items: [{ product: { id: 'p1' }, quantity: 1 }],
  kot_sent: true, // renderer hint — must be dropped
};
const ctx = { shiftId: 's1', deviceId: 'd1', orderId: 'o-1', createdAt: '2026-08-27T00:00:00Z', cashierId: 'cashier-9' };

const built = buildCloudOrderPayload(order, ctx);

ok('cloud payload carries cashier_id', built.cashier_id === 'cashier-9');
ok('null cashier survives as null', buildCloudOrderPayload(order, { ...ctx, cashierId: null }).cashier_id === null);
ok('renderer hint kot_sent is dropped', built.kot_sent === undefined);

// Byte-identical across the two paths: the node relay passes the SAME ctx values
// (from the peer's own order row), so the two payloads must be equal.
const peerPush = buildCloudOrderPayload(order, ctx);
const nodeRelay = buildCloudOrderPayload(order, { ...ctx }); // same values, as nodeIngest supplies
ok('peer push and node relay payloads are byte-identical',
  JSON.stringify(peerPush) === JSON.stringify(nodeRelay));

// MUTATION (rules 10, 23): if the builder dropped cashier_id, this goes red.
ok('mutation guard: cashier_id is present, not undefined', 'cashier_id' in built);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
