/**
 * tip-reconciliation — the regression that would have caught BUG-01/02.
 *
 * WHY THIS FILE EXISTS
 * discount-clamp.test.mjs models the CLIENT's payment maths. atomic-order.test.mjs
 * models the RPC's reconciliation guard. Both passed. Neither was ever fed the
 * other, so the one place they contradicted each other went unnoticed — and the
 * contradiction was even written down, in a comment, at discount-clamp.test.mjs:96:
 *
 *   "the order total sent to the server excludes tip; legs incl tip reconcile to
 *    total+tip on the client, and the server validates legs against total."
 *
 * Read that twice. It states the bug. The test then asserted the harmless half.
 *
 * This file composes the two models. Every case runs the client's own arithmetic
 * straight into the server's own guard.
 */
import assert from 'node:assert';

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// ── CLIENT (apps/dashboard PaymentModal + apps/desktop lib/payment.ts) ───────
function clientCharge(subtotal, discountRaw, tip, maxPct = 10) {
  const capped = round2(Math.min(Math.max(0, discountRaw), subtotal * (maxPct / 100), subtotal));
  const total  = round2(subtotal - capped);      // the BILL — excludes tip
  return { capped, total, amountDue: round2(total + tip), tip };
}

// ── SERVER (migrations/66_order_atomic_tip_reconciliation.sql) ───────────────
function createOrderAtomic(order, legs) {
  const due  = Number(order.total) + Number(order.tip_amount ?? 0);
  const paid = legs.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.01) {
    throw new Error(`payment legs sum to ${paid} but the amount due is ${due}`);
  }
  return { ok: true };
}

// ── SERVER (/pay, the dine-in path — must agree with the RPC) ───────────────
function payPath(order, legs) {
  const due  = round2(Number(order.total) + Math.max(0, Number(order.tip_amount) || 0));
  const paid = legs.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.01) throw new Error('PAYMENT_MISMATCH');
  return { ok: true };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const accepts = (fn) => { try { fn(); return true; } catch { return false; } };

// ── 1. The bug, both order paths ────────────────────────────────────────────
for (const [label, submit] of [['POST /orders', createOrderAtomic], ['POST /:id/pay', payPath]]) {
  for (const tip of [0, 50, 90, 0.01]) {
    const c = clientCharge(1000, 250, tip);
    ok(`${label}: tip ${tip} reconciles`,
       accepts(() => submit({ total: c.total, tip_amount: c.tip },
                            [{ method: 'cash', amount: c.amountDue }])),
       `legs=${c.amountDue} total=${c.total} tip=${c.tip}`);
  }
}

// ── 2. The bill excludes the tip — VAT base and revenue must not move ───────
{
  const a = clientCharge(1000, 0, 0);
  const b = clientCharge(1000, 0, 200);
  ok('a tip does not change orders.total', a.total === b.total, `${a.total} vs ${b.total}`);
  ok('but it does change what is collected', b.amountDue - a.amountDue === 200);
}

// ── 3. Split tender across a tipped sale ────────────────────────────────────
{
  const c = clientCharge(1000, 0, 100);          // due 1100
  ok('split legs summing to total + tip are accepted',
     accepts(() => createOrderAtomic({ total: c.total, tip_amount: c.tip },
       [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 500 }])));
}

// ── 4. The guard still guards — this is anti-tampering, not a loosening ─────
{
  const c = clientCharge(1000, 0, 100);
  ok('underpayment is still refused',
     !accepts(() => createOrderAtomic({ total: c.total, tip_amount: c.tip },
       [{ method: 'cash', amount: 1000 }])));
  ok('overpayment is still refused',
     !accepts(() => createOrderAtomic({ total: c.total, tip_amount: c.tip },
       [{ method: 'cash', amount: 1200 }])));
  ok('a tip claimed but not paid is refused',
     !accepts(() => createOrderAtomic({ total: 900, tip_amount: 90 },
       [{ method: 'cash', amount: 900 }])));
  ok('one-cent rounding is still tolerated',
     accepts(() => createOrderAtomic({ total: 900, tip_amount: 90 },
       [{ method: 'cash', amount: 990.01 }])));
}

// ── 5. Untipped sales are byte-for-byte unchanged ──────────────────────────
{
  ok('no tip_amount field at all still works',
     accepts(() => createOrderAtomic({ total: 900 }, [{ method: 'cash', amount: 900 }])));
  ok('and still refuses a wrong amount',
     !accepts(() => createOrderAtomic({ total: 900 }, [{ method: 'cash', amount: 950 }])));
}

// ── 6. The two order paths cannot drift apart again ────────────────────────
{
  let agree = true;
  for (const tip of [0, 1, 50, 99.99]) {
    for (const paid of [900, 950, 990, 999.99]) {
      const order = { total: 900, tip_amount: tip };
      const legs  = [{ method: 'cash', amount: paid }];
      if (accepts(() => createOrderAtomic(order, legs)) !== accepts(() => payPath(order, legs))) agree = false;
    }
  }
  ok('POST /orders and /pay agree on every combination', agree);
}

console.log(`\n${fail === 0 ? 'All checks passed. A tipped sale reconciles on both order paths.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
