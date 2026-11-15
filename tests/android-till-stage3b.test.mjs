/**
 * android-till-stage3b.test.mjs — ZapTill for Android, Till stage 3 Slice B: PUSH a completed sale to the branch server
 * (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3B.md). The Shop POS reshapes its captured cloud order body into the
 * server's replicated orders row (+ lines, payments, and the verbatim _relayPayload for the A19 cloud relay) and offers
 * it to POST /node/sync; the server's idempotent ingest holds it. This RUNS shop/branchSync.ts with the native
 * BranchServer / link / device injected.
 *
 *   node --no-warnings tests/android-till-stage3b.test.mjs   (bundles apps/android/src with esbuild; native leaves stubbed
 *                                                              so it runs in CI's offline-suites job with no NODE_PATH)
 *
 * RUNS:
 *   R  orderRowFromBody (pure): the captured body → the replicated orders row; money/customer columns from the body,
 *      synthesised stable line/payment ids, and _relayPayload = the body (idempotency_key preserved) + the cashier.
 *   P  pushOrdersToNode: the /node/sync call (device, branch, tables.orders; X-Node-Secret + device key); applied_ids
 *      parsed; a transport failure / no link → ok:false.
 *   O  the outbox: enqueue reshapes and stores; drain removes what the server holds, retries the rest, drops after the cap.
 *   S  checked in source: /node/sync, the device-key header, _relayPayload, and the deferred /node/since pull.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - orderRowFromBody dropping _relayPayload           → R "the faithful cloud payload rides along (A19)"
 *   - orderRowFromBody reading total from ctx not body  → R "the branch-report figures come from the body"
 *   - drainToNode removing a row the server did not hold → O "a row the server did not take is kept and retried"
 *   - pushOrdersToNode treating a null answer as ok      → P "no answer from the server is not success"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till3b-'));
// Native neighbours stubbed (pulled in through tillSession / branchServer) so the suite is hermetic — no NODE_PATH, no
// Android deps installed, as CI's offline-suites job runs it.
fs.writeFileSync(path.join(tmp, 'stub-capacitor-core.cjs'),
  `module.exports = { registerPlugin: () => ({}), CapacitorHttp: { request: async () => ({ status: 0, data: null }) }, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } };`);
fs.writeFileSync(path.join(tmp, 'stub-preferences.cjs'),
  `module.exports = { Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'stub-secure-storage.cjs'),
  `module.exports = { SecureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, clear: async () => {} } };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { orderRowFromBody, pushOrdersToNode, enqueueOrderFor, drainToNode, nextNodeSeq, InMemoryNodeOutbox, OUTBOX_MAX_TRIES }
    from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/branchSync.ts'))};
`);
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'),
  alias: {
    '@zaptill/core': path.join(ROOT, 'packages/core/src'),
    '@capacitor/core': path.join(tmp, 'stub-capacitor-core.cjs'),
    '@capacitor/preferences': path.join(tmp, 'stub-preferences.cjs'),
    '@aparajita/capacitor-secure-storage': path.join(tmp, 'stub-secure-storage.cjs'),
  },
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: 'https://dev-api.zaptill.co.ke' }) },
  logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const LINK = { url: 'https://192.168.1.9:4100', cert: 'CERT', securityCode: 'AB-CD-EF', name: 'Shop', nodeSecret: 'NS', deviceToken: 'DT' };
const BODY = {
  idempotency_key: 'ORD-1', branch_id: 'BR1', order_number: 'T1-42', order_type: 'dine_in', table_number: '5',
  subtotal: 1000, vat_amount: 160, ctl_amount: 0, discount_amount: 0, tip_amount: 0, total: 1160,
  customer_id: null, customer_name: 'Jane', customer_phone: null, shift_id: 'SH1', pump_id: null, notes: null,
  items: [{ product: { id: 'P1', name: 'Pizza', categories: [{ id: 'C1', name: 'Mains' }] }, unitPrice: 500, quantity: 2, lineTotal: 1000, notes: 'extra cheese' }],
  payments: [{ method: 'cash', amount: 1160, reference: '' }],
};
const CTX = { deviceId: 'android-dev', seq: 7, branchId: 'BR1', createdAt: '2026-11-12T10:00:00Z', cashierId: 'U9' };
/** A stubbed nodeRequest: records args, returns `resp` (a NodeResponse | null). */
function stub(resp) { const calls = []; return { fn: async (...a) => { calls.push(a); return resp; }, calls }; }

const run = async () => {

  console.log('\nR. orderRowFromBody (pure)');
  {
    const row = M.orderRowFromBody(BODY, CTX);
    eq('the order id is the idempotency key', row.id, 'ORD-1');
    eq('status is completed', row.status, 'completed');
    eq('the branch-report figures come from the body', [row.subtotal, row.vat_amount, row.total], [1000, 160, 1160]);
    eq('device id and seq are this tablet\'s', [row.device_id, row.seq], ['android-dev', 7]);
    eq('the cashier is credited when known', row.cashier_id, 'U9');
    const it = row._items[0];
    eq('a line: stable id, product and money', [it.id, it.order_id, it.product_id, it.product_name, it.unit_price, it.quantity, it.subtotal], ['ORD-1-i0', 'ORD-1', 'P1', 'Pizza', 500, 2, 1000]);
    eq('a line category name is flattened', it.category_name, 'Mains');
    const pay = row._payments[0];
    eq('a payment: stable id, method, amount, completed', [pay.id, pay.order_id, pay.method, pay.amount, pay.status], ['ORD-1-p0', 'ORD-1', 'cash', 1160, 'completed']);
    ok('the faithful cloud payload rides along (A19)', !!row._relayPayload && row._relayPayload.idempotency_key === 'ORD-1' && Array.isArray(row._relayPayload.items) && Array.isArray(row._relayPayload.payments));
    eq('the relay payload carries the cashier', row._relayPayload.cashier_id, 'U9');
    ok('no id → no row', M.orderRowFromBody({ items: [] }, CTX) === null);
  }

  console.log('\nP. pushOrdersToNode');
  {
    const row = M.orderRowFromBody(BODY, CTX);
    const good = stub({ status: 200, body: JSON.stringify({ ok: true, results: { orders: { applied: 1, duplicate: 0, cursor: 7, rejected: [], applied_ids: ['ORD-1'] } } }), headers: {} });
    const out = await M.pushOrdersToNode([row], { link: LINK, device: 'android-dev', request: good.fn });
    eq('a held row comes back in applied_ids', [out.ok, out.appliedIds], [true, ['ORD-1']]);
    const [lnk, method, pth, bodyStr, headers] = good.calls[0];
    eq('it POSTs /node/sync', [method, pth], ['POST', '/node/sync']);
    const sent = JSON.parse(bodyStr);
    eq('the batch names the device, branch and the orders table', [sent.device_id, sent.branch_id, sent.tables.orders.length], ['android-dev', 'BR1', 1]);
    eq('the branch access code + device key are sent', [lnk.nodeSecret, headers['x-device-token'], headers['x-device-id']], ['NS', 'DT', 'android-dev']);

    const dead = stub(null);
    eq('no answer from the server is not success', (await M.pushOrdersToNode([row], { link: LINK, device: 'd', request: dead.fn })).ok, false);
    eq('no branch server → not success', (await M.pushOrdersToNode([row], { link: null })).ok, false);
    eq('an empty batch is a trivial success', (await M.pushOrdersToNode([], { link: LINK })).ok, true);
  }

  console.log('\nO. the outbox (enqueue / drain)');
  {
    const outbox = new M.InMemoryNodeOutbox();
    const r = await M.enqueueOrderFor(outbox, BODY, { deviceId: 'android-dev', branchId: 'BR1', createdAt: '2026-11-12T10:00:00Z' });
    ok('enqueue reshapes and stores the sale', !!r && r.id === 'ORD-1' && (await outbox.all()).length === 1);

    // Two waiting; the server holds only A.
    const box = new M.InMemoryNodeOutbox();
    await box.put({ id: 'A', seq: 1, row: { id: 'A', branch_id: 'BR1' }, tries: 0 });
    await box.put({ id: 'B', seq: 2, row: { id: 'B', branch_id: 'BR1' }, tries: 0 });
    const holdsA = stub({ status: 200, body: JSON.stringify({ results: { orders: { applied_ids: ['A'], rejected: [] } } }), headers: {} });
    const d1 = await M.drainToNode(box, { link: LINK, device: 'd', request: holdsA.fn });
    eq('one held, none dropped', [d1.held, d1.dropped], [1, 0]);
    const left = await box.all();
    ok('the held row leaves, the other is kept and retried', left.length === 1 && left[0].id === 'B' && left[0].tries === 1);

    // A transport failure keeps everything.
    const dead = stub(null);
    const before = (await box.all()).length;
    await M.drainToNode(box, { link: LINK, device: 'd', request: dead.fn });
    ok('a row the server did not take is kept and retried', (await box.all()).length === before);

    // Dropped only after the cap (a row the server never takes must not grow the outbox forever).
    const capBox = new M.InMemoryNodeOutbox();
    await capBox.put({ id: 'C', seq: 1, row: { id: 'C', branch_id: 'BR1' }, tries: M.OUTBOX_MAX_TRIES - 1 });
    const holdsNone = stub({ status: 200, body: JSON.stringify({ results: { orders: { applied_ids: [], rejected: [{ id: 'C', reason: 'bad' }] } } }), headers: {} });
    const d2 = await M.drainToNode(capBox, { link: LINK, device: 'd', request: holdsNone.fn });
    ok('a row the server keeps refusing is dropped at the cap', d2.dropped === 1 && (await capBox.all()).length === 0);
  }

  console.log('\nS. checked in source');
  {
    const src = read('apps/android/src/shop/branchSync.ts');
    ok('pushes to /node/sync', src.includes("'/node/sync'"));
    ok('sends this POS\'s device key', src.includes("'x-device-token'"));
    ok('carries the verbatim cloud payload for the A19 relay', src.includes('_relayPayload'));
    ok('the /node/since pull is deferred, in writing', /node\/since/.test(src) && /defer/i.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
};
run();
