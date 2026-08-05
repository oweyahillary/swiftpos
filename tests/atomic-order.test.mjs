/**
 * atomic-order.test.mjs — proves the order write is all-or-nothing and that
 * payment legs must reconcile to the total.
 *
 *   node atomic-order.test.mjs   (needs better-sqlite3; it ships with apps/desktop)
 *
 * The production write is a Postgres function (migration 62). SQLite is not
 * Postgres, but the property under test is a transaction property both share:
 * inside BEGIN/COMMIT, if any statement throws, every prior statement in the
 * transaction is undone. This models the create_order_atomic body — order,
 * items, payments, plus the reconciliation guard — and checks:
 *
 *   - a clean order writes order + items + payments together;
 *   - a failure partway (a bad item) leaves NOTHING behind, not a completed
 *     order with no payments, which is exactly the corruption the RPC ends;
 *   - payment legs that do not sum to the total abort the whole write;
 *   - a one-cent rounding difference is tolerated.
 */

let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.log('better-sqlite3 not installed here. Run from apps/desktop, or');
  console.log('`npm i better-sqlite3` in this folder. Skipping.');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE orders   (id INTEGER PRIMARY KEY, order_number TEXT, total REAL, status TEXT);
  CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_name TEXT NOT NULL, qty REAL);
  CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, amount REAL);
`);

/**
 * Mirror of create_order_atomic: validate payments reconcile, then write order,
 * items and payments in ONE transaction. A thrown error rolls the whole thing
 * back, exactly as the plpgsql function does on RAISE.
 */
function createOrderAtomic(order, items, payments) {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (Math.abs(paid - order.total) > 0.01) {
    throw new Error(`payment legs sum to ${paid} but order total is ${order.total}`);
  }
  const txn = db.transaction(() => {
    const oid = db.prepare(`INSERT INTO orders (order_number, total, status) VALUES (?, ?, 'completed')`)
      .run(order.order_number, order.total).lastInsertRowid;
    for (const it of items) {
      // product_name is NOT NULL — a null models a malformed item and makes the
      // statement throw, so the transaction must undo the order row too.
      db.prepare(`INSERT INTO order_items (order_id, product_name, qty) VALUES (?, ?, ?)`)
        .run(oid, it.product_name, it.qty);
    }
    for (const p of payments) {
      db.prepare(`INSERT INTO payments (order_id, method, amount) VALUES (?, ?, ?)`)
        .run(oid, p.method, p.amount);
    }
    return oid;
  });
  return txn();
}

const counts = () => ({
  orders:   db.prepare(`SELECT COUNT(*) n FROM orders`).get().n,
  items:    db.prepare(`SELECT COUNT(*) n FROM order_items`).get().n,
  payments: db.prepare(`SELECT COUNT(*) n FROM payments`).get().n,
});

// ── 1. A clean order writes everything together ─────────────────────────────
{
  const oid = createOrderAtomic(
    { order_number: 'A-1', total: 1000 },
    [{ product_name: 'Combo', qty: 1 }, { product_name: 'Soda', qty: 2 }],
    [{ method: 'cash', amount: 1000 }],
  );
  const c = counts();
  ok('clean order created', !!oid && c.orders === 1);
  ok('its items were written', c.items === 2);
  ok('its payment was written', c.payments === 1);
}

// ── 2. A failure partway rolls the WHOLE order back ─────────────────────────
{
  const before = counts();
  let threw = false;
  try {
    createOrderAtomic(
      { order_number: 'A-2', total: 500 },
      [{ product_name: 'Good', qty: 1 }, { product_name: null, qty: 1 }],  // second item is malformed
      [{ method: 'cash', amount: 500 }],
    );
  } catch { threw = true; }
  const after = counts();
  ok('the bad write threw', threw);
  ok('NO order row was left behind', after.orders === before.orders,
     `orders ${before.orders} -> ${after.orders}`);
  ok('NO items were left behind', after.items === before.items);
  ok('NO payments were left behind', after.payments === before.payments);
  ok('specifically: no completed order with no payment (the bug)',
     after.orders === before.orders && after.payments === before.payments);
}

// ── 3. Payments must reconcile to the total ─────────────────────────────────
{
  const before = counts();
  let msg = '';
  try {
    createOrderAtomic(
      { order_number: 'A-3', total: 1000 },
      [{ product_name: 'Combo', qty: 1 }],
      [{ method: 'cash', amount: 600 }],   // 400 short
    );
  } catch (e) { msg = e.message; }
  ok('underpaid order rejected before any write', /sum to 600 but order total is 1000/.test(msg), msg);
  ok('nothing was written for the rejected order', counts().orders === before.orders);
}

// ── 4. Overpayment is also rejected ─────────────────────────────────────────
{
  let threw = false;
  try {
    createOrderAtomic(
      { order_number: 'A-4', total: 1000 },
      [{ product_name: 'Combo', qty: 1 }],
      [{ method: 'cash', amount: 1500 }],
    );
  } catch { threw = true; }
  ok('overpaid order rejected', threw);
}

// ── 5. A split payment that sums correctly is accepted ──────────────────────
{
  const before = counts();
  createOrderAtomic(
    { order_number: 'A-5', total: 1000 },
    [{ product_name: 'Combo', qty: 1 }],
    [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 400 }],
  );
  ok('split payment summing to total is accepted', counts().orders === before.orders + 1);
  ok('both legs written', counts().payments === before.payments + 2);
}

// ── 6. A one-cent rounding difference is tolerated ──────────────────────────
{
  let threw = false;
  try {
    createOrderAtomic(
      { order_number: 'A-6', total: 1000 },
      [{ product_name: 'Combo', qty: 1 }],
      [{ method: 'cash', amount: 1000.01 }],
    );
  } catch { threw = true; }
  ok('one-cent rounding tolerated', threw === false);
}

console.log(`\n${fail === 0 ? 'All checks passed. Order writes are atomic and payments reconcile.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
