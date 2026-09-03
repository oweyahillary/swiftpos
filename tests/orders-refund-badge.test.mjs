/**
 * orders-refund-badge.test.mjs — A195 (refunded orders must be visually distinct).
 *
 * A refund keeps the order status 'completed' (the sale stands, with a reversal
 * leg). On the owner Orders list that made a refunded sale pixel-identical to a
 * clean one. The signal already reaches the client: `GET /api/orders` returns
 * `payments ( method, amount, status )`, and a refund inserts a leg with
 * status 'refunded'. This test locks:
 *   1. the detector keys off a 'refunded' payment leg (not the order status);
 *   2. the server still writes that leg with status:'refunded' (so the signal exists);
 *   3. the page renders a Refunded badge and stops offering Refund on it.
 *
 * Source-level; mutation-checkable — flip the detector's predicate, drop the
 * server's status:'refunded', or remove the badge and a named assertion fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/orderRefund.ts'), 'utf8');
const page   = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/OrdersPage.tsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/orders.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('detector: a refund is a "refunded" payment leg, not an order status', () => {
  assert.match(helper, /p\?\.status === 'refunded'/,
    "isRefunded must look for a payment leg with status 'refunded' (status stays 'completed')");
});

ok('server: the refund still writes the signal the detector reads', () => {
  // If the reversal leg ever stops being status:'refunded', the badge goes dark
  // silently — pin the producer so the two can't drift.
  assert.match(server, /status:\s*'refunded'/,
    "the refund handler must insert a payment leg with status:'refunded'");
  assert.match(server, /amount:\s*-Math\.abs/,
    'the reversal leg must be negative (a genuine reversal, not a second charge)');
});

ok('page: renders a Refunded badge off the detector', () => {
  assert.match(page, /isRefunded\(o\.payments\)/, 'the row must call isRefunded on the order payments');
  assert.match(page, /Refunded\s*<\/span>/, 'a "Refunded" badge must render');
});

ok('page: does not offer Refund on an already-refunded order', () => {
  assert.match(page, /includes\('refund'\) && !isRefunded\(o\.payments\)/,
    'the Refund button must be suppressed once the order is refunded (server would 400)');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
