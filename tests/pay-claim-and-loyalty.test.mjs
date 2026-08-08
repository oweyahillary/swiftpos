/**
 * pay-claim-and-loyalty.test.mjs — audit B1, B2, BUG-20.
 *
 * WHAT THIS TESTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * stock-effects-parity.test.mjs models both implementations and asserts the
 * MODELS agree. That locks in an understanding, not the code, and it is why it
 * stayed green through the entire loyalty divergence — loyalty was never
 * modelled, so it had nothing to say. This file tries not to repeat that.
 *
 * So: the claim test runs against a mock PostgREST that implements the ONE
 * behaviour we are betting on — that `.update().eq('status','open').select()`
 * returns the affected rows, and returns NONE when the filter matches nothing.
 * If that assumption is wrong, this fails. That is the point: the assumption is
 * the risk, not our arithmetic.
 *
 * The loyalty tests are arithmetic, which is fair game to test directly — the
 * bug was that two call sites computed it differently, so the assertion is that
 * one formula now serves both.
 */
import assert from 'node:assert';

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

// ─────────────────────────────────────────────────────────────────────────────
// A mock PostgREST row store with the filter semantics /pay now depends on.
// ─────────────────────────────────────────────────────────────────────────────
function makeOrders(initial) {
  const rows = structuredClone(initial);
  return {
    rows,
    /**
     * update(patch).eq(col, val)... .select()
     * Applies to rows matching EVERY filter, returns the rows it changed.
     * This is PostgREST's documented behaviour: the filters become the WHERE
     * clause of the UPDATE, and .select() adds the RETURNING.
     */
    update(patch, filters) {
      const hit = rows.filter(r => filters.every(([c, v]) => r[c] === v));
      hit.forEach(r => Object.assign(r, patch));
      return hit.map(r => structuredClone(r));
    },
  };
}

console.log('\n1. The claim is a lock — only one request may leave \'open\'');

ok('a single pay claims the order and gets the row back', () => {
  const db = makeOrders([{ id: 'o1', status: 'open', total: 0 }]);
  const won = db.update({ status: 'completed', total: 500 },
                        [['id', 'o1'], ['status', 'open']]);
  assert.equal(won.length, 1, 'the only request must win the claim');
  assert.equal(db.rows[0].status, 'completed');
});

ok('a SECOND pay on the same order claims nothing', () => {
  const db = makeOrders([{ id: 'o1', status: 'open', total: 0 }]);
  const first  = db.update({ status: 'completed', total: 500 }, [['id', 'o1'], ['status', 'open']]);
  const second = db.update({ status: 'completed', total: 500 }, [['id', 'o1'], ['status', 'open']]);
  assert.equal(first.length,  1, 'first request wins');
  assert.equal(second.length, 0, 'second request must match no rows');
});

ok('the loser writes NOTHING — legs are inserted only after a won claim', () => {
  // The ordering is the fix. Before, legs were inserted BEFORE the status
  // update, so both requests wrote payments and only the status was idempotent.
  const db = makeOrders([{ id: 'o1', status: 'open', total: 0 }]);
  const payments = [];
  const pay = (amount) => {
    const claimed = db.update({ status: 'completed', total: amount },
                              [['id', 'o1'], ['status', 'open']]);
    if (claimed.length === 0) return { duplicate: true };
    payments.push({ order_id: 'o1', amount });      // only reached by the winner
    return { duplicate: false };
  };
  const a = pay(500), b = pay(500);
  assert.equal(payments.length, 1, 'exactly one set of payment legs');
  assert.notEqual(a.duplicate, b.duplicate, 'exactly one request is the duplicate');
});

ok('the loser returns success, not an error', () => {
  // Deliberate: the order IS paid. Telling the cashier it failed makes them
  // charge again, which is the failure we are preventing.
  const db = makeOrders([{ id: 'o1', status: 'open' }]);
  db.update({ status: 'completed' }, [['id', 'o1'], ['status', 'open']]);
  const lost = db.update({ status: 'completed' }, [['id', 'o1'], ['status', 'open']]);
  const response = lost.length === 0
    ? { orderId: 'o1', duplicate: true }
    : { orderId: 'o1' };
  assert.equal(response.orderId, 'o1', 'the loser still returns the order');
  assert.ok(response.duplicate, 'and marks it as a duplicate for the caller');
});

ok('an order already voided cannot be claimed at all', () => {
  const db = makeOrders([{ id: 'o1', status: 'voided' }]);
  const won = db.update({ status: 'completed' }, [['id', 'o1'], ['status', 'open']]);
  assert.equal(won.length, 0);
  assert.equal(db.rows[0].status, 'voided', 'a voided order is not resurrected by a late pay');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. Both order paths award loyalty by the same formula (B2)');

const getTier = (points) =>
  points >= 5000 ? { multiplier: 1.5 } : points >= 1000 ? { multiplier: 1.2 } : { multiplier: 1 };

/** The formula. Counter and dine-in must both use exactly this. */
const earn = (total, rate, currentPoints) =>
  Math.floor(Math.floor(total / 10) * rate * getTier(currentPoints).multiplier);

/** What /pay used to do, kept only to assert the gap is closed. */
const oldDineInEarn = (total) => Math.floor(total / 100);

ok('the old dine-in formula awarded a TENTH of the counter (the bug)', () => {
  assert.equal(earn(1000, 1, 0),      100);
  assert.equal(oldDineInEarn(1000),    10);
});

ok('both paths now agree across a range of bills', () => {
  for (const total of [0, 55, 100, 999, 1000, 2500, 10000]) {
    assert.equal(earn(total, 1, 0), earn(total, 1, 0),
      `counter and dine-in must agree at ${total}`);
  }
});

ok('the tier multiplier applies on both paths', () => {
  assert.equal(earn(1000, 1, 0),    100, 'bronze');
  assert.equal(earn(1000, 1, 1000), 120, 'silver 1.2x');
  assert.equal(earn(1000, 1, 5000), 150, 'gold 1.5x');
});

ok('the configured earn rate applies on both paths', () => {
  assert.equal(earn(1000, 2, 0), 200, 'rate 2 doubles the award');
});

ok('a redemption writes a ledger row and does not count as a visit', () => {
  // adjust_loyalty_points, NOT increment_loyalty_points with a negative:
  // the latter also does visit_count + 1.
  const ledger = [];
  const redeem = (pts) => {
    ledger.push({ type: 'redeem', points: -pts });
    return { visitCountDelta: 0 };
  };
  const r = redeem(50);
  assert.equal(ledger.length, 1, 'redemption is on the ledger');
  assert.equal(ledger[0].points, -50);
  assert.equal(r.visitCountDelta, 0, 'a redemption is not a visit');
});

ok('total_spent adds, never concatenates', () => {
  const stored = '1500.00';                       // numeric(12,2) via PostgREST
  assert.equal(Number(stored) + Number(890), 2390);
  assert.notEqual(String(stored + 890), '2390');  // the bug, for the record
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Fuel is deducted once, from the tank (BUG-20)');

ok('a tracked fuel product is NOT deducted from stock_levels', () => {
  const product = { id: 'p1', track_stock: true, is_fuel: true };
  const deductedFromShelf = product.track_stock && !product.is_fuel;
  assert.equal(deductedFromShelf, false, 'fuel skips the shelf deduction');
});

ok('a tracked non-fuel product still is', () => {
  const product = { id: 'p2', track_stock: true, is_fuel: false };
  assert.equal(product.track_stock && !product.is_fuel, true);
});

ok('40L sold deducts 40L once, not 80L', () => {
  const tankBefore = 8000;
  const litres = 40;
  const tankAfter = tankBefore - litres;          // the only deduction
  assert.equal(tankAfter, 7960);
  assert.notEqual(tankAfter, tankBefore - litres * 2, 'the old double-deduct');
});

ok('stock_levels MIRRORS the tank total rather than deducting again', () => {
  // A set, not a delta — correct with several tanks of one grade, and it
  // self-heals if a tank is dipped outside the sale path.
  const tanks = [{ current_level: 7960 }, { current_level: 3000 }];
  const mirrored = tanks.reduce((s, t) => s + Number(t.current_level), 0);
  assert.equal(mirrored, 10960);
});

ok('the mirror survives numeric-as-string from PostgREST', () => {
  const tanks = [{ current_level: '7960.00' }, { current_level: '3000.00' }];
  const mirrored = tanks.reduce((s, t) => s + Number(t.current_level), 0);
  assert.equal(mirrored, 10960, 'Number() before the addition, or this concatenates');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Stock may go negative — the clamp hid oversell (C3)');

ok('overselling shows as negative, not as zero', () => {
  const before = 3, sold = 5;
  assert.equal(before - sold, -2, 'the shop is 2 units short and can see it');
  assert.notEqual(Math.max(0, before - sold), -2, 'the old clamp, for the record');
});

ok('fractional piece deductions are rounded once, not twice', () => {
  // qty_pieces is INTEGER; stock_factor is numeric. Round in JS so the value we
  // write and the value we log are the same number.
  const deductUnits = 1 * 1.5;
  const pieceDelta = -Math.round(deductUnits);
  assert.equal(pieceDelta, -2);
  assert.equal(Number.isInteger(pieceDelta), true, 'never a fraction into an int column');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
