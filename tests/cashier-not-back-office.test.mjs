// A499 — a cashier signs in to the till (and the web POS) and lands on the POS, not the manager screens.
// Owner, 2026-10-15, with a screenshot of cashier "Test 1" on 1.0.15 looking at Settings › staff: "when cashier log in it
// takes them to users this is bad". The cashier role's legacy customers.manage expanded (A490) to customers.credit, and the
// voids/refunds/reprints a till owner lets cashiers do are POS actions too — none of them made the holder "back office", but
// isBackOffice counted them, so every such cashier was routed to the manager page (and asked for a sign-in code on the web).
//
//   node --no-warnings tests/cashier-not-back-office.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const keysOf = (map) => [...P.expandMap(map)].filter((k) => !P.OPEN_BEFORE_A490.includes(k));
const legacyCashier = { 'sales.create': true, 'sales.discount': true, 'customers.manage': true, 'shifts.manage': false };

console.log('\nA cashier is not back office\n');
ok('a cashier from before A490 (customers.manage) is not back office', () => {
  assert.equal(P.isBackOffice(keysOf(legacyCashier)), false);
});
ok('the catalogue\'s own cashier defaults are not back office', () => {
  assert.equal(P.isBackOffice(P.defaultKeysFor('cashier')), false);
});
ok('a cashier the owner lets void, refund, reprint and give credit is still not back office', () => {
  const held = [...P.defaultKeysFor('cashier'), ...P.POS_ACTION_KEYS];
  assert.equal(P.isBackOffice(held), false);
});
ok('every POS action key is a real catalogue key', () => {
  for (const k of P.POS_ACTION_KEYS) assert.ok(P.PERMISSIONS.some((p) => p.key === k), k);
});
ok('a manager is back office, and so is the owner (*)', () => {
  assert.equal(P.isBackOffice(P.defaultKeysFor('manager')), true);
  assert.equal(P.isBackOffice(['*']), true);
});
ok('one back-office key on top of a cashier makes them back office', () => {
  assert.equal(P.isBackOffice([...P.defaultKeysFor('cashier'), 'reports.sales']), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
