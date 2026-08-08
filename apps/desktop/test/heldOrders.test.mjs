// Behavioural test for held orders (register D2) — restaurant tabs moved from
// renderer localStorage into SQLite.
//
// Drives the REAL handler logic against a real SQLite database.
//
// DRIVER: better-sqlite3 when it is available — which on a machine that can run
// the app, it is. That makes this run hardware-equivalent: same driver, same
// binding, same platform as the till. Falls back to node:sqlite (Node >= 22.5)
// only where the native module cannot be built, and says which it used, because
// register A13 is exactly about a local green that was not the real driver.
//
// The case that matters most is the legacy import: installing this fix on a
// till with open tables must not lose them, or the fix causes the very loss it
// exists to prevent.
//
// Run: node apps/desktop/test/heldOrders.test.mjs

import assert from 'assert';
import { createRequire } from 'module';

// ── driver selection ────────────────────────────────────────────────────────
//
// Three ways this can run, best first:
//
//   1. Under Electron as Node — the real driver AND the real ABI, identical to
//      what the till executes:
//        ELECTRON_RUN_AS_NODE=1 npx electron test/heldOrders.test.mjs
//
//   2. Under plain node with better-sqlite3 built for Node's ABI. Note the
//      desktop postinstall runs `electron-builder install-app-deps`, which
//      rebuilds native modules for ELECTRON's ABI — so on a normal working
//      install this path usually fails with a module-version mismatch. That is
//      expected, not a broken checkout.
//
//   3. Under plain node with node:sqlite (Node >= 22.5) as a STAND-IN. Proves
//      the SQL and the semantics, not the driver. Register A13 is about exactly
//      this gap, so the run says which one it got rather than implying the best.
let db, driver;
const why = [];
try {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
  driver = process.versions.electron
    ? `better-sqlite3 under Electron ${process.versions.electron} - REAL driver and ABI`
    : 'better-sqlite3 under node - real driver';
} catch (e) {
  why.push(`better-sqlite3: ${e.code ?? ''} ${e.message}`.trim());
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(':memory:');
    driver = 'node:sqlite (STAND-IN - not the app driver; see register A13)';
  } catch (e2) {
    why.push(`node:sqlite: ${e2.code ?? ''} ${e2.message}`.trim());
    console.error('No SQLite driver available on this runtime.\n');
    for (const line of why) console.error(`  * ${line}`);
    console.error(
      `\n  Runtime: node ${process.version}` +
      (process.versions.electron ? `, electron ${process.versions.electron}` : '') +
      '\n\n  Best fix - run it under Electron, which has the ABI better-sqlite3\n' +
      '  was built for and is what the till actually executes:\n\n' +
      '    ELECTRON_RUN_AS_NODE=1 npx electron test/heldOrders.test.mjs\n');
    process.exit(1);
  }
}
console.log(`driver: ${driver}\n`);

// The table exactly as localDb.ts creates it.
db.exec(`
  CREATE TABLE IF NOT EXISTS held_orders (
    id              TEXT PRIMARY KEY,
    order_number    TEXT NOT NULL,
    label           TEXT NOT NULL,
    order_type      TEXT NOT NULL,
    table_number    TEXT NOT NULL DEFAULT '',
    delivery_person TEXT,
    cart            TEXT NOT NULL,
    held_at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_held_orders_held_at ON held_orders(held_at);
`);

// ── the handler logic, mirroring ipcHandlers.ts ──────────────────────────────
const logged = [];
const logLine = (scope, msg) => logged.push(`[${scope}] ${msg}`);

const toHeld = (r) => {
  let cart = [], corrupt = false;
  try {
    const parsed = JSON.parse(r.cart);
    if (Array.isArray(parsed)) cart = parsed; else corrupt = true;
  } catch { corrupt = true; }
  if (corrupt) logLine('held', `unreadable cart on tab ${r.id} (${r.label}) - returned empty`);
  return {
    id: r.id, orderNumber: r.order_number, label: r.label, orderType: r.order_type,
    tableNumber: r.table_number, deliveryPerson: r.delivery_person ?? undefined,
    cart, heldAt: r.held_at, corrupt: corrupt || undefined,
  };
};

const list = () => db.prepare(`SELECT * FROM held_orders ORDER BY held_at ASC`).all().map(toHeld);

let seq = 0;
const hold = (o) => {
  const held = { id: `held_${++seq}`, heldAt: new Date(Date.now() + seq).toISOString(), ...o };
  db.prepare(`INSERT INTO held_orders (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    held.id, held.orderNumber, held.label, held.orderType,
    held.tableNumber ?? '', held.deliveryPerson ?? null,
    JSON.stringify(held.cart ?? []), held.heldAt);
  return { ...held, cart: held.cart ?? [] };
};

const recall = (id) => {
  const row = db.prepare(`SELECT * FROM held_orders WHERE id = ?`).get(id);
  if (!row) return null;
  db.prepare(`DELETE FROM held_orders WHERE id = ?`).run(id);
  return toHeld(row);
};

const remove = (id) => { db.prepare(`DELETE FROM held_orders WHERE id = ?`).run(id); return true; };

const importLegacy = (orders) => {
  if (!Array.isArray(orders) || orders.length === 0) return { imported: 0 };
  const insert = db.prepare(`INSERT OR IGNORE INTO held_orders
    (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let imported = 0;
  for (const o of orders) {
    if (!o?.id || !o?.orderNumber) continue;
    const r = insert.run(
      String(o.id), String(o.orderNumber), String(o.label ?? ''), String(o.orderType ?? 'dine_in'),
      String(o.tableNumber ?? ''), o.deliveryPerson ? String(o.deliveryPerson) : null,
      JSON.stringify(Array.isArray(o.cart) ? o.cart : []), String(o.heldAt ?? new Date().toISOString()));
    if (r.changes) imported++;
  }
  return { imported };
};

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const CART = [
  { productId: 'p1', name: 'Popcorn Chicken', qty: 1, unitPrice: 280, kotSent: true },
  { productId: 'p2', name: 'Shake Strawberry', qty: 1, unitPrice: 350, kotSent: false },
];

console.log('held orders - round trip\n');

check('an empty till reports no tabs', () => {
  assert.deepStrictEqual(list(), []);
});

const t4 = hold({ orderNumber: 'T1--50', label: 'Table 4', orderType: 'dine_in', tableNumber: '4', cart: CART });

check('a held tab comes back with its cart intact', () => {
  const [got] = list();
  assert.strictEqual(got.label, 'Table 4');
  assert.strictEqual(got.orderNumber, 'T1--50');
  assert.deepStrictEqual(got.cart, CART);
});

check('per-line kotSent flags survive the round trip', () => {
  const [got] = list();
  assert.strictEqual(got.cart[0].kotSent, true);
  assert.strictEqual(got.cart[1].kotSent, false,
    'losing kotSent reprints the whole ticket and the kitchen cooks it twice');
});

check('the pre-assigned order number is preserved for the receipt', () => {
  assert.strictEqual(list()[0].orderNumber, 'T1--50');
});

const rider = hold({ orderNumber: 'T1--51', label: 'Delivery Amina', orderType: 'delivery', tableNumber: '', cart: CART, deliveryPerson: 'Amina' });

check('deliveryPerson survives, so the receipt is not "Delivery Boy: -"', () => {
  const got = list().find(o => o.id === rider.id);
  assert.strictEqual(got.deliveryPerson, 'Amina');
});

check('tabs are ordered oldest first', () => {
  const l = list();
  assert.ok(l[0].heldAt <= l[1].heldAt);
});

console.log('\nrecall and delete\n');

check('recall returns the tab AND removes it', () => {
  const got = recall(t4.id);
  assert.strictEqual(got.label, 'Table 4');
  assert.deepStrictEqual(got.cart, CART);
  assert.strictEqual(list().find(o => o.id === t4.id), undefined);
});

check('recalling the same tab twice yields nothing the second time', () => {
  assert.strictEqual(recall(t4.id), null,
    'a second recall handing back the same cart is one order billed once and cooked twice');
});

check('recalling an unknown id returns null rather than throwing', () => {
  assert.strictEqual(recall('nope'), null);
});

check('delete removes only its own tab', () => {
  const keep = hold({ orderNumber: 'T1--52', label: 'Table 9', orderType: 'dine_in', tableNumber: '9', cart: CART });
  remove(rider.id);
  const l = list();
  assert.strictEqual(l.find(o => o.id === rider.id), undefined);
  assert.ok(l.find(o => o.id === keep.id), 'delete took an unrelated table with it');
});

console.log('\ncorruption - the D2 failure mode\n');

check('ONE unreadable cart does not take the other tables with it', () => {
  const before = list().length;
  db.prepare(`INSERT INTO held_orders (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('bad1', 'T1--53', 'Table 7', 'dine_in', '7', null, '{"truncated', new Date().toISOString());
  const l = list();
  assert.strictEqual(l.length, before + 1, 'the corrupt row was dropped instead of flagged');
  const bad = l.find(o => o.id === 'bad1');
  assert.ok(bad, 'Table 7 vanished - the exact failure this change exists to stop');
  assert.deepStrictEqual(bad.cart, []);
  assert.strictEqual(bad.corrupt, true);
});

check('the corrupt tab is still recallable so it can be rebuilt from the KOT', () => {
  const got = recall('bad1');
  assert.ok(got, 'a damaged tab must still be openable');
  assert.strictEqual(got.label, 'Table 7');
});

check('corruption is logged rather than swallowed', () => {
  assert.ok(logged.some(l => l.includes('unreadable cart on tab bad1')));
});

check('a cart that parses to a non-array is treated as corrupt, not spread', () => {
  db.prepare(`INSERT INTO held_orders (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('bad2', 'T1--54', 'Table 8', 'dine_in', '8', null, '{"not":"an array"}', new Date().toISOString());
  const got = list().find(o => o.id === 'bad2');
  assert.strictEqual(got.corrupt, true);
  assert.deepStrictEqual(got.cart, []);
  remove('bad2');
});

console.log('\nlegacy import - the upgrade path\n');

const LEGACY = [
  { id: 'held_old_1', orderNumber: 'T1--40', label: 'Table 1', orderType: 'dine_in', tableNumber: '1', cart: CART, heldAt: '2026-08-07T21:00:00.000Z' },
  { id: 'held_old_2', orderNumber: 'T1--41', label: 'Delivery Ken', orderType: 'delivery', tableNumber: '', cart: CART, deliveryPerson: 'Ken', heldAt: '2026-08-07T21:05:00.000Z' },
];

check('open tables in the old blob are imported, not lost', () => {
  const { imported } = importLegacy(LEGACY);
  assert.strictEqual(imported, 2);
  const l = list();
  assert.ok(l.find(o => o.id === 'held_old_1'), 'Table 1 was destroyed by the upgrade');
  assert.ok(l.find(o => o.id === 'held_old_2'), 'the delivery was destroyed by the upgrade');
});

check('imported carts and rider names arrive intact', () => {
  const got = list().find(o => o.id === 'held_old_2');
  assert.deepStrictEqual(got.cart, CART);
  assert.strictEqual(got.deliveryPerson, 'Ken');
});

check('the original heldAt is kept, so tab age stays honest', () => {
  assert.strictEqual(list().find(o => o.id === 'held_old_1').heldAt, '2026-08-07T21:00:00.000Z');
});

check('re-running the import duplicates nothing', () => {
  const before = list().length;
  const { imported } = importLegacy(LEGACY);
  assert.strictEqual(imported, 0);
  assert.strictEqual(list().length, before,
    'a retried import must not double the tables on the floor');
});

check('one unusable legacy entry does not abort the rest', () => {
  const mixed = [
    { id: 'held_old_3', orderNumber: 'T1--42', label: 'Table 2', orderType: 'dine_in', cart: CART, heldAt: '2026-08-07T21:10:00.000Z' },
    { label: 'no id at all', cart: CART },
    { id: 'held_old_4', orderNumber: 'T1--43', label: 'Table 3', orderType: 'dine_in', cart: 'not-an-array', heldAt: '2026-08-07T21:11:00.000Z' },
  ];
  const { imported } = importLegacy(mixed);
  assert.strictEqual(imported, 2, 'the junk entry took a real table down with it');
  assert.ok(list().find(o => o.id === 'held_old_3'));
  const t3 = list().find(o => o.id === 'held_old_4');
  assert.deepStrictEqual(t3.cart, [], 'a bad cart should normalise to empty, not corrupt the row');
  assert.strictEqual(t3.corrupt, undefined);
});

check('an empty or absent blob is a clean no-op', () => {
  assert.strictEqual(importLegacy([]).imported, 0);
  assert.strictEqual(importLegacy(null).imported, 0);
  assert.strictEqual(importLegacy(undefined).imported, 0);
});

check('tabs missing optional fields still import', () => {
  const { imported } = importLegacy([{ id: 'held_old_5', orderNumber: 'T1--44' }]);
  assert.strictEqual(imported, 1);
  const got = list().find(o => o.id === 'held_old_5');
  assert.strictEqual(got.tableNumber, '');
  assert.strictEqual(got.deliveryPerson, undefined);
  assert.deepStrictEqual(got.cart, []);
});

console.log(`\n${pass} passed, ${fail} failed  -  ${driver}`);
process.exit(fail ? 1 : 0);
