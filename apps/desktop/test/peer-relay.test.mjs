/**
 * peer-relay.test.mjs — A19 (register A162). Proves buildPeerRelay, the decision
 * the node makes about whether a freshly-applied peer order can be forwarded to
 * the cloud faithfully. The failure modes here are money: forwarding a payload
 * the cloud 400s on parks a sale forever; forwarding one whose id/device
 * disagrees with its row can collapse two sales onto one cloud order; rebuilding
 * a payload from the node's tables (no variants/modifiers) under-totals it. So
 * the asserts target exactly those refusals, and that a good payload — modifiers
 * and all — passes through verbatim.
 *
 * Drives the REAL compiled dist/main/peerRelay.js — pure, no SQLite/Electron.
 * Does NOT prove the enqueue, the applyPeerRows wiring, or a real cloud POST —
 * those close on the live node+peer+cloud target (rule 16).
 *
 *   Run:  npx tsc -b tsconfig.main.json --force   (in apps/desktop)
 *         node test/peer-relay.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'peerRelay.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/peerRelay.js not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { buildPeerRelay, buildCloudOrderPayload } = await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// A well-formed peer order row as it arrives at the node: replicated order
// columns + the peer's ORIGINAL cloud payload on `_relayPayload`, whose items
// carry the variant/modifier selections the node's own tables do NOT hold.
const goodPayload = {
  branch_id: 'B1', order_number: 'A-1001', device_id: 'DEV-PEER',
  items: [{
    product_id: 'p1', quantity: 2,
    variants: [{ groupName: 'Size', optionName: 'Large' }],
    modifiers: [{ groupName: 'Extras', optionName: 'Bacon', price_adjustment: 50 }],
  }],
  payments: [{ method: 'cash', amount: 500, status: 'completed' }],
  shift_id: 'S1', created_at: '2026-08-25T09:00:00Z', idempotency_key: 'ORD-1',
};
const goodRow = () => ({ id: 'ORD-1', device_id: 'DEV-PEER', _relayPayload: JSON.parse(JSON.stringify(goodPayload)) });

// ── The happy path, and the fidelity that is the whole reason for stashing ──
const r = buildPeerRelay(goodRow());
ok('valid order → ok', r.ok === true);
ok('orderId is the row id', r.ok && r.orderId === 'ORD-1');
ok('idempotency_key guaranteed = order id', r.ok && r.payload.idempotency_key === 'ORD-1');
ok('items passed through verbatim (2 qty)', r.ok && r.payload.items[0].quantity === 2);
ok('VARIANT selection survives (would be lost if rebuilt from node tables)',
   r.ok && r.payload.items[0].variants[0].optionName === 'Large');
ok('MODIFIER + price adjustment survives (the under-total this design prevents)',
   r.ok && r.payload.items[0].modifiers[0].price_adjustment === 50);
ok('payments passed through', r.ok && r.payload.payments[0].amount === 500);

// idempotency_key absent → filled in from the order id (belt and suspenders)
{
  const row = goodRow(); delete row._relayPayload.idempotency_key;
  const d = buildPeerRelay(row);
  ok('absent idempotency_key → filled with order id', d.ok && d.payload.idempotency_key === 'ORD-1');
}

// legacy single `payment` (not `payments[]`) still counts as a leg
{
  const row = goodRow(); delete row._relayPayload.payments;
  row._relayPayload.payment = { method: 'cash', amount: 500 };
  ok('legacy single payment → ok', buildPeerRelay(row).ok === true);
}

// ── Refusals: never forward something the cloud would reject forever ──
{
  const row = goodRow(); delete row._relayPayload;
  const d = buildPeerRelay(row);
  ok('old peer, no _relayPayload → refused (NOT reconstructed lossily)', d.ok === false);
}
{
  const row = goodRow(); row._relayPayload.items = [];
  ok('empty items → refused (would 400 on cloud forever)', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); delete row._relayPayload.items;
  ok('missing items → refused', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); delete row._relayPayload.payments;
  ok('no payments at all → refused', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); delete row._relayPayload.branch_id;
  ok('missing branch_id → refused', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); delete row._relayPayload.order_number;
  ok('missing order_number → refused', buildPeerRelay(row).ok === false);
}

// ── Refusals: never let a payload dedupe against the WRONG cloud order ──
{
  const row = goodRow(); row._relayPayload.idempotency_key = 'SOMEONE-ELSE';
  ok('idempotency_key ≠ order id → refused (would misattribute money)', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); row._relayPayload.device_id = 'DEV-OTHER';
  ok('payload device_id ≠ row device → refused (re-stamped in transit)', buildPeerRelay(row).ok === false);
}
{
  const row = goodRow(); delete row.id;
  ok('order row with no id → refused', buildPeerRelay(row).ok === false);
}

// ── buildCloudOrderPayload: the SHARED builder both the till's direct push and
//    the node's forward use, so the two payloads for one order are identical ──
const rawSale = {
  branch_id: 'B1', order_number: 'A-1001', kot_sent: true,
  items: [{ product_id: 'p1', quantity: 1, modifiers: [{ groupName: 'Extras', optionName: 'Bacon', price_adjustment: 50 }] }],
  payments: [{ method: 'mpesa', amount: 300 }],
};
const ctx = { shiftId: 'S1', deviceId: 'DEV-PEER', orderId: 'ORD-9', createdAt: '2026-08-25T09:00:00Z' };
const cloud = buildCloudOrderPayload(rawSale, ctx);
ok('builder drops kot_sent (no cloud column)', !('kot_sent' in cloud));
ok('builder marks payment legs completed (else cloud reports M-Pesa unaccounted, A93)',
   cloud.payments[0].status === 'completed');
ok('builder carries shift_id/device_id from ctx', cloud.shift_id === 'S1' && cloud.device_id === 'DEV-PEER');
ok('builder sets idempotency_key + _localOrderId = order id', cloud.idempotency_key === 'ORD-9' && cloud._localOrderId === 'ORD-9');
ok('builder uses the ORIGINAL created_at (not now)', cloud.created_at === '2026-08-25T09:00:00Z');
ok('builder preserves item modifiers verbatim', cloud.items[0].modifiers[0].price_adjustment === 50);

// legacy single `payment`
{
  const c = buildCloudOrderPayload({ branch_id: 'B', order_number: 'N', items: [{ product_id: 'p' }], payment: { method: 'cash', amount: 10 } }, ctx);
  ok('builder folds legacy single payment into payments[]', Array.isArray(c.payments) && c.payments[0].method === 'cash');
}

// ── Round-trip: what the till builds, the node forwards faithfully ──
// This is the whole feature composed: the peer builds the cloud payload, carries
// it as _relayPayload on the order row, and the node accepts it for forwarding.
{
  const relayRow = { id: 'ORD-9', device_id: 'DEV-PEER', _relayPayload: buildCloudOrderPayload(rawSale, ctx) };
  const decision = buildPeerRelay(relayRow);
  ok('round-trip: built payload is accepted by the node relay', decision.ok === true);
  ok('round-trip: modifier price survives build → forward (the under-total this design prevents)',
     decision.ok && decision.payload.items[0].modifiers[0].price_adjustment === 50);
  ok('round-trip: idempotency_key stays the order id end to end',
     decision.ok && decision.payload.idempotency_key === 'ORD-9');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
