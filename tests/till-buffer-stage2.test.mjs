/**
 * till-buffer-stage2.test.mjs — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7, §4.8): the offline store-and-forward
 * rules in @zaptill/core/tillBuffer. Pure, so run straight on the source.
 *
 *   node --no-warnings tests/till-buffer-stage2.test.mjs
 *
 * Covers: which writes may go offline (and which are refused); the order uuid / idempotency key a write carries; the
 * replay batch keeps an order and its void together and in creation order; acks mark rows synced / retry / failed and a
 * sale is never lost; the table-taken question; and the two retention clocks (unsent kept forever, sent kept 30 days).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - bufferableKind allowing GET                         → "a read is never buffered"
 *   - nextBatch splitting an order from its void          → "an order and its void go together"
 *   - applyAcks dropping a conflicted sale                → "a conflicted sale is kept (never lost)"
 *   - partitionForRetention removing an unsent old row    → "unsent is kept however old"
 *   - partitionForRetention removing a sent row in window → "a sent row inside the window is kept"
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const B = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/tillBuffer.ts')).href);

let _seq = 0;
const row = (kind, orderUuid, over = {}) => ({
  id: over.id ?? `row-${orderUuid}-${kind}`, seq: over.seq ?? ++_seq, kind, orderUuid,
  createdAt: over.createdAt ?? new Date(1_700_000_000_000 + (over.seq ?? _seq) * 1000).toISOString(),
  req: over.req ?? { method: 'POST', path: '/api/orders', body: {} },
  state: over.state ?? 'pending', tries: over.tries ?? 0, syncedAt: over.syncedAt ?? null,
});

console.log('\n1. What may be taken offline (§4.7)');
eq('POST /orders is an order', B.bufferableKind('POST', '/api/orders'), 'order');
eq('POST /orders/:id/void is a void', B.bufferableKind('POST', '/api/orders/abc/void'), 'void');
eq('POST /orders/:id/refund is a refund', B.bufferableKind('POST', '/api/orders/abc/refund'), 'refund');
eq('POST /orders/:id/pay is a payment', B.bufferableKind('POST', '/orders/abc/pay'), 'payment');
eq('POST /expenses is an expense', B.bufferableKind('POST', '/api/expenses'), 'expense');
eq('POST /orders/:id/move-table is an order_op', B.bufferableKind('POST', '/api/orders/abc/move-table'), 'order_op');
eq('POST /orders/:id/fire-course is an order_op', B.bufferableKind('POST', '/api/orders/abc/fire-course'), 'order_op');
eq('query strings are dropped', B.bufferableKind('POST', '/api/orders?x=1'), 'order');
ok('a read is never buffered', B.bufferableKind('GET', '/api/orders') === null);
ok('a DELETE offline is refused', B.bufferableKind('DELETE', '/api/orders/abc') === null);
ok('an unknown write is refused (nothing silently vanishes)', B.bufferableKind('POST', '/api/settings/theme') === null);

console.log('\n2. The order uuid / idempotency key');
eq('a void takes the order id from its path', B.orderUuidOf('void', '/api/orders/ORD1/void', {}), 'ORD1');
eq('a table move takes the order id from its path', B.orderUuidOf('order_op', '/api/orders/ORD1/move-table', { table_number: '5' }), 'ORD1');
eq('an order takes its body uuid', B.orderUuidOf('order', '/api/orders', { uuid: 'ORD2' }), 'ORD2');
eq('an expense takes its idempotency_key', B.orderUuidOf('expense', '/api/expenses', { idempotency_key: 'E1' }), 'E1');
eq('withIdempotencyKey adds the key', B.withIdempotencyKey({ total: 100 }, 'ORD3'), { total: 100, idempotency_key: 'ORD3' });
eq('withIdempotencyKey keeps an existing key', B.withIdempotencyKey({ idempotency_key: 'K' }, 'ORD3'), { idempotency_key: 'K' });
ok('withIdempotencyKey does not mutate the input', (() => { const b = { total: 1 }; B.withIdempotencyKey(b, 'X'); return b.idempotency_key === undefined; })());

console.log('\n3. The replay batch (§4.7 step 3)');
_seq = 0;
const o1 = row('order', 'O1', { seq: 1 });
const p1 = row('payment', 'O1', { seq: 2 });
const o2 = row('order', 'O2', { seq: 3 });
const v1 = row('void', 'O1', { seq: 4 });  // a void of O1 rung up AFTER O2 was created
const batch = B.nextBatch([o1, p1, o2, v1], 100);
ok('an order and its void go together (same batch, not split)',
  batch.some((r) => r.orderUuid === 'O1' && r.kind === 'void') && batch.some((r) => r.orderUuid === 'O1' && r.kind === 'order'));
ok('a void is never before its order', batch.findIndex((r) => r.kind === 'order' && r.orderUuid === 'O1') < batch.findIndex((r) => r.kind === 'void' && r.orderUuid === 'O1'));
ok('rows come in creation order', batch.map((r) => r.seq).every((s, i, a) => i === 0 || a[i - 1] <= s));
eq('a tiny cap stops at a group boundary, never mid-order', B.nextBatch([o1, p1, o2, v1], 2).map((r) => r.orderUuid), ['O1', 'O1', 'O1']);
eq('synced rows are not in the batch', B.nextBatch([{ ...o1, state: 'synced', syncedAt: 't' }, o2], 100).map((r) => r.orderUuid), ['O2']);

console.log('\n4. Acks: a sale is never lost (§4.7 step 5)');
const now = '2026-11-07T00:00:00.000Z';
const acked = B.applyAcks([o1, o2], [{ orderUuid: 'O1', result: 'ok', at: 't1' }], now);
eq('ok marks synced with the server time', [acked[0].state, acked[0].syncedAt], ['synced', 't1']);
eq('an un-acked row is untouched', acked[1].state, 'pending');
const conf = B.applyAcks([o1], [{ orderUuid: 'O1', result: 'conflict', at: 't2', conflict: { kind: 'table_taken', orderUuid: 'O1', orderNumber: 3012, table: '5' } }], now);
eq('a conflicted sale is kept (never lost)', conf[0].state, 'synced');
const retry1 = B.applyAcks([o1], [{ orderUuid: 'O1', result: 'retry' }], now);
eq('retry keeps it pending and counts a try', [retry1[0].state, retry1[0].tries], ['pending', 1]);
const parked = B.applyAcks([{ ...o1, tries: B.MAX_TRIES - 1 }], [{ orderUuid: 'O1', result: 'retry' }], now);
eq('too many retries parks it failed (kept, surfaced)', parked[0].state, 'failed');
const reack = B.applyAcks([{ ...o1, state: 'synced', syncedAt: 't1' }], [{ orderUuid: 'O1', result: 'ok', at: 't9' }], now);
eq('a re-ack of a synced row is a no-op (idempotent)', reack[0].syncedAt, 't1');

console.log('\n5. The table-taken question (§4.7)');
eq('the prompt names the order and table', B.conflictPrompt({ kind: 'table_taken', orderUuid: 'O1', orderNumber: 3012, table: '5' }), 'Order #3012 was on Table 5, now taken — move it?');
ok('a stock variance asks nothing', B.conflictPrompt({ kind: 'stock_variance', orderUuid: 'O1', item: 'Tusker', shortBy: 2 }) === null);

console.log('\n6. Retention — two clocks (§4.8)');
const old = '2026-01-01T00:00:00.000Z';         // > 30 days before `now`
const recent = '2026-11-01T00:00:00.000Z';      // < 30 days before `now`
const unsentOld = row('order', 'U1', { seq: 10, state: 'pending', createdAt: old });
const sentOld = row('order', 'S1', { seq: 11, state: 'synced', syncedAt: old });
const sentRecent = row('order', 'S2', { seq: 12, state: 'synced', syncedAt: recent });
const part = B.partitionForRetention([unsentOld, sentOld, sentRecent], now);
ok('unsent is kept however old', part.keep.some((r) => r.orderUuid === 'U1') && !part.remove.some((r) => r.orderUuid === 'U1'));
ok('a sent row older than the window is removed', part.remove.some((r) => r.orderUuid === 'S1'));
ok('a sent row inside the window is kept', part.keep.some((r) => r.orderUuid === 'S2'));
ok('an old sent receipt cannot be reprinted offline', B.canReprintOffline(sentOld, now) === false);
ok('an unsent receipt can always be reprinted', B.canReprintOffline(unsentOld, now) === true);

console.log('\n7. The status bar (Till stage 2)');
const st = B.bufferStatus([o1, p1, o2, { ...v1, state: 'synced', syncedAt: 't5' }, row('order_op', 'M1', { seq: 15, state: 'pending' }), { ...row('order', 'F1', { seq: 20 }), state: 'failed', tries: B.MAX_TRIES }], false);
eq('sales waiting counts pending order rows (a pending table move is not a sale)', st.salesWaiting, 2);
eq('stuck counts parked rows', st.stuck, 1);
eq('last synced is the newest ack', st.lastSynced, 't5');
ok('offline is reported', st.online === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
