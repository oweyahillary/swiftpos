/**
 * batches.test.mjs — A413: batches and expiry dates — the rules (lib/batches.ts, run for real) and pins on the routes.
 *
 * Owner, 2026-10-06: "Batch and expiry-date tracking for stock". Decided: products and ingredients; what is left in each
 * batch is worked out oldest-expiry first from the stock level.
 *
 * MUTATIONS TO CONFIRM BITE: allocateBatches filling from the FIRST batch to leave (not the last) → "what has gone came
 * from the oldest expiry" fails; expiryStatus calling the expiry day itself expired → "good through its date" fails;
 * a restock's batch written in units for a by-piece product → "pieces for a by-piece product" fails; the client_id
 * check removed from the wastage route → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const B = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/batches.ts')).href);
const batch = (id, qty, expiry, received = '2026-10-01T08:00:00Z') => ({ id, quantity_received: qty, expiry_date: expiry, received_at: received });

console.log('\nWhat is left in each batch\n');
await ok('what has gone came from the oldest expiry: 30 received in three batches, 18 held → the two latest hold it', () => {
  const r = B.allocateBatches(18, [batch('b1', 10, '2026-10-10'), batch('b2', 10, '2026-10-20'), batch('b3', 10, '2026-10-30')]);
  assert.deepEqual(r.batches.map((a) => [a.batch.id, a.remaining]), [['b1', 0], ['b2', 8], ['b3', 10]]);
  assert.equal(r.unbatched, 0);
});
await ok('order: earliest expiry first; no expiry date last; the same date → the earlier delivery first', () => {
  const o = B.consumptionOrder([batch('late', 1, '2026-12-01'), batch('none', 1, null), batch('b', 1, '2026-11-01', '2026-10-05T00:00:00Z'),
    batch('a', 1, '2026-11-01', '2026-10-02T00:00:00Z')]);
  assert.deepEqual(o.map((b) => b.id), ['a', 'b', 'late', 'none']);
});
await ok('stock beyond the batches is "no batch recorded" — older, so it went first', () => {
  const r = B.allocateBatches(25, [batch('b1', 10, '2026-10-10'), batch('b2', 10, '2026-10-20')]);
  assert.deepEqual(r.batches.map((a) => a.remaining), [10, 10]); assert.equal(r.unbatched, 5);
});
await ok('nothing held → nothing left anywhere; a negative level is nothing', () => {
  assert.deepEqual(B.allocateBatches(0, [batch('b1', 5, '2026-10-10')]).batches.map((a) => a.remaining), [0]);
  assert.deepEqual(B.allocateBatches(-3, [batch('b1', 5, '2026-10-10')]).batches.map((a) => a.remaining), [0]);
});
await ok('fractions (kg, litres) keep three decimals', () => {
  const r = B.allocateBatches(1.25, [batch('b1', 2.5, '2026-10-10'), batch('b2', 0.75, '2026-10-20')]);
  assert.deepEqual(r.batches.map((a) => a.remaining), [0.5, 0.75]);
});

console.log('\nExpiry\n');
await ok('good through its date: the expiry day itself is "soon", the day after is "expired"', () => {
  assert.equal(B.expiryStatus('2026-10-06', '2026-10-06'), 'soon');
  assert.equal(B.expiryStatus('2026-10-05', '2026-10-06'), 'expired');
  assert.equal(B.daysLeft('2026-10-05', '2026-10-06'), -1);
});
await ok('soon = within the chosen days; later = ok; no date = none', () => {
  assert.equal(B.expiryStatus('2026-10-13', '2026-10-06', 7), 'soon');
  assert.equal(B.expiryStatus('2026-10-14', '2026-10-06', 7), 'ok');
  assert.equal(B.expiryStatus('2026-10-14', '2026-10-06', 14), 'soon');
  assert.equal(B.expiryStatus(null, '2026-10-06'), 'none');
});
await ok('a typed date: real days only (no 31 Feb), blank is none, nonsense is refused', () => {
  assert.equal(B.cleanExpiry('2026-12-31', '2026-10-06'), '2026-12-31');
  assert.equal(B.cleanExpiry('', '2026-10-06'), null); assert.equal(B.cleanExpiry(undefined, '2026-10-06'), null);
  assert.equal(B.cleanExpiry('2026-02-31', '2026-10-06'), 'bad'); assert.equal(B.cleanExpiry('31/12/2026', '2026-10-06'), 'bad');
  assert.equal(B.cleanExpiry('2099-01-01', '2026-10-06'), 'bad');
  assert.equal(B.cleanBatchNo('  LOT 42  '), 'LOT 42'); assert.equal(B.cleanBatchNo('   '), null);
});
await ok('pieces for a by-piece product: 2 cartons of 24 is 48', () => {
  assert.equal(B.heldUnits(2, true, 24), 48); assert.equal(B.heldUnits(2, false, 24), 2); assert.equal(B.heldUnits(3, true, null), 3);
});
await ok('the headline counts only batches with stock left, and values them', () => {
  const s = B.expirySummary([{ status: 'expired', remaining: 4, unit_cost: 50 }, { status: 'expired', remaining: 0, unit_cost: 50 },
    { status: 'soon', remaining: 2, unit_cost: 10 }, { status: 'ok', remaining: 9, unit_cost: 1 }, { status: 'soon', remaining: 1, unit_cost: null }]);
  assert.deepEqual(s, { expired: 1, soon: 2, expiredValue: 200, soonValue: 20 });
});

console.log('\nThe cloud\n');
const R = read('apps/server/src/routes/batches.ts');
await ok('the list: anyone who records wastage, adjusts or receives stock; a manager sees their own branch', () => {
  assert.match(R, /router\.get\('\/', requireAnyPermission\('inventory\.waste', 'inventory\.adjust', 'inventory\.receive'\)/);
  assert.match(R, /const scoped = branchScope\(req\)/);
  assert.match(R, /if \(scoped && !assertBranchAccess\(req, scoped\)\)/);
  assert.match(read('apps/server/src/routes/index.ts'), /router\.use\('\/batches',\s+batchesRoutes\);/);
});
await ok('what is left is worked out from the stock level (pieces for a by-piece product), never stored', () => {
  assert.match(R, /allocateBatches\(held\.get\(key\) \?\? 0, group\)/);
  assert.match(R, /Number\(p\?\.sold_by === 'piece' \? l\.qty_pieces : l\.quantity\)/);
  assert.ok(!/remaining:\s*[^,]*\}\)\.eq\(/.test(R) && !/update\(\{[^}]*remaining/.test(R), 'no stored balance');
});
await ok('closing a batch is the owner tier\'s; fixing a date is whoever receives', () => {
  assert.match(R, /router\.post\('\/:id\/close', requirePermission\('inventory\.adjust'\)/);
  assert.match(R, /router\.patch\('\/:id', requireAnyPermission\('inventory\.receive', 'inventory\.adjust'\)/);
});
await ok('receiving writes the batch: product restock (in pieces when by the piece), ingredient add, every GRN line — never failing the receipt', () => {
  const inv = read('apps/server/src/routes/inventory.ts'), st = read('apps/server/src/routes/stock.ts'), bs = read('apps/server/src/lib/batchStore.ts');
  assert.match(inv, /if \(type === 'restock' && wantsBatch\(expiry_date, batch_no\)\)/);
  assert.match(inv, /quantity: heldUnits\(quantityChange, p\.sold_by === 'piece', p\.pieces_per_unit\)/);
  assert.match(st, /if \(type === 'add' && delta > 0 && wantsBatch\(expiry_date, batch_no\)\)/);
  assert.match(st, /source: 'grn', sourceRef: grn_number/);
  assert.match(bs, /never thrown/); assert.ok(!/throw /.test(bs.replace(/\/\*[\s\S]*?\*\//g, '')), 'batchStore never throws');
});
await ok('a till\'s write-off sent twice is recorded once (client_id); its person and time are kept', () => {
  const w = read('apps/server/src/routes/wastage.ts');
  assert.match(w, /if \(clientId\) \{\s*const \{ data: seen \} = await supabase\.from\('wastage_entries'\)\.select\('ref, value'\)\.eq\('business_id', req\.businessId\)\.eq\('client_id', clientId\);/);
  assert.match(w, /duplicate: true/);
  assert.match(w, /const fromTill = req\.surface === 'desktop';/);
  assert.match(w, /recorded_by_name: byName/);
  assert.match(w, /if \(!bt \|\| bt\.branch_id !== branchId \|\| \(kind === 'product' \? bt\.product_id : bt\.ingredient_id\) !== id\) return 'bad';/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
