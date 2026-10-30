// A490 — a change made on a till (a station, category, product, cashier or PIN) needs FINE keys, ALL of them, on the till
// and on the cloud alike (shared tillChanges.changeKeys). Found while building A490: the specs still named broad keys, and
// expanding staff.manage gives staff.view — which every person holds (before migration 134, and after it on every role) —
// so any cashier could have created or changed staff from a till.
//
//   node --no-warnings tests/till-change-keys.test.mjs
//
// MUTATIONS TO CONFIRM BITE: changeApply going back to expanding the spec's keys → "the cloud never expands" fails;
// changeKeys returning menu.edit for a price change → "a price change needs menu.prices" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/tillChanges.ts')).href);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const holdsAll = (held, keys) => keys.every((k) => P.hasPermission(held, k));

// A cashier: the floor, plus everything every person held before A490.
const cashier = P.expandMap({ 'orders.create': true, 'products.view': true, 'customers.view': true }, true);

console.log('\nTill changes need fine keys, all of them\n');
ok('every entity names fine keys only (no broad key, nothing unknown)', () => {
  for (const [e, spec] of Object.entries(T.ENTITY_SPECS)) for (const k of spec.permissions) assert.ok(P.isPermissionKey(k), `${e}: ${k}`);
});
ok('a cashier — even holding the staff list and everything everyone held — may make NONE of them', () => {
  assert.ok(cashier.has('staff.view'));
  for (const [e, op, data] of [['staff', 'create'], ['staff', 'update', { name: 'x' }], ['staff_pin', 'update'], ['product', 'create'],
    ['product', 'update', { base_price: 10 }], ['category', 'create'], ['station', 'create']]) {
    assert.equal(holdsAll(cashier, T.changeKeys(e, op, data)), false, `${e} ${op}`);
  }
});
ok('staff changes need staff.edit; menu changes menu.edit; stations stations.manage', () => {
  assert.deepEqual(T.changeKeys('staff', 'create'), ['staff.edit']);
  assert.deepEqual(T.changeKeys('staff_pin', 'update'), ['staff.pins']);   // A595: a PIN is its own part of staff.edit
  assert.deepEqual(T.changeKeys('category', 'create'), ['menu.edit']);
  assert.deepEqual(T.changeKeys('product', 'create', { name: 'Chips', base_price: 200 }), ['menu.edit']);
  assert.deepEqual(T.changeKeys('station', 'update'), ['stations.manage']);
});
ok('a price change needs menu.prices, a cost change menu.costs_edit (A595), anything else on the product menu.edit — all together', () => {
  assert.deepEqual(T.changeKeys('product', 'update', { base_price: 250 }), ['menu.prices']);
  assert.deepEqual(T.changeKeys('product', 'update', { cost_price: 90 }), ['menu.costs_edit']);   // A595: changing a cost is its own part
  assert.deepEqual(T.changeKeys('product', 'update', { name: 'Chips L', base_price: 250 }).sort(), ['menu.edit', 'menu.prices']);
  const pricer = P.expandKeys(['menu.prices']);
  assert.equal(holdsAll(pricer, T.changeKeys('product', 'update', { name: 'x', base_price: 1 })), false, 'a renamed product needs menu.edit too');
});
ok('a manager role from before A490 (products.manage, staff.manage) still makes them all', () => {
  const mgr = P.expandKeys(['products.manage', 'staff.manage', 'orders.create']);
  for (const [e, op, data] of [['staff', 'create'], ['product', 'update', { base_price: 1, cost_price: 1, name: 'x' }], ['station', 'create'], ['category', 'create']]) {
    assert.ok(holdsAll(mgr, T.changeKeys(e, op, data)), `${e} ${op}`);
  }
});
ok('the cloud and the till use this one rule, and the cloud never expands it', () => {
  const ca = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/changeApply.ts'), 'utf8');
  assert.match(ca, /const needed = changeKeys\(c\.entity, c\.op, c\.data\);/);
  assert.match(ca, /makerMay\(ctx\.businessId, c\.made_by, needed\)/);
  assert.doesNotMatch(ca, /expandKeys\(/);
  const cq = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/changeQueue.ts'), 'utf8');
  assert.match(cq, /import \{[^}]*changeKeys[^}]*\} from '@zaptill\/core\/tillChanges'/);
  assert.match(cq, /changeKeys\(entity, op, data\)\.every\(/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
