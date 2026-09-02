/**
 * sync-push-partition.test.mjs — A180.
 *
 * The guard that stops one malformed row 500-ing a whole /api/sync/push batch.
 * Runs the REAL exported helper (apps/server/src/lib/syncPush.ts). The per-row
 * upsert around it is integration/target-verified; here we prove the decision.
 */
import { isUuid, partitionByValidId } from '../apps/server/src/lib/syncPush.ts';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

const GOOD = '11111111-2222-3333-4444-555555555555';
const BAD = 'exp_1787776714494_w0ash';   // the exact field value

ok('a real UUID is accepted', isUuid(GOOD));
ok('the field value exp_… is rejected', !isUuid(BAD));
ok('a non-string id is rejected', !isUuid(12345) && !isUuid(null) && !isUuid(undefined));

const { valid, rejected } = partitionByValidId(
  [{ id: GOOD, amount: 1 }, { id: BAD, amount: 2 }, { id: 'not-a-uuid', amount: 3 }], 'expenses');

ok('the good row is kept', valid.length === 1 && valid[0].id === GOOD);
ok('both bad rows are rejected', rejected.length === 2);
ok('rejection names the table and a code', rejected.every(r => r.table === 'expenses' && r.code === 'invalid_id'));
ok('the bad expense is rejected by its own id (not the whole batch)', rejected.some(r => r.id === BAD));

// MUTATION (rules 10, 23): the load-bearing property is that a BAD id never lands
// in `valid` (that is what used to reach the uuid column and 500 the batch).
ok('mutation guard: no bad id leaks into valid', !valid.some(v => v.id === BAD || v.id === 'not-a-uuid'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
