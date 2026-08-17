/**
 * sync-float-routing.test.mjs — proves a float whose parent shift is NOT owned/
 * present is REJECTED, never silently dropped (register A85 / SS1).
 *
 *   node tests/sync-float-routing.test.mjs
 *
 * No DB. Models the /push floats decision in apps/server/src/routes/sync.ts:
 * for each float, if its shift is in ownedShiftSet → upsert (counted), else →
 * rejected with table 'float_transactions' + code 'missing_shift'. The bug this
 * guards: the till marks every float NOT in `rejected` as synced, so a silent
 * skip loses a cash-drawer movement.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// mirror of the server decision (upsert always "succeeds" here; we only model routing)
function routeFloats(floats, ownedShiftIds) {
  const owned = new Set(ownedShiftIds);
  const upserted = [];
  const rejected = [];
  for (const f of floats) {
    if (!owned.has(f.shift_id)) {
      rejected.push({ id: f.id, code: 'missing_shift', table: 'float_transactions' });
    } else {
      upserted.push(f.id);
    }
  }
  return { upserted, rejected };
}

// every incoming float is accounted for — the core invariant that prevents loss
function everyFloatAccountedFor(floats, res) {
  const seen = new Set([...res.upserted, ...res.rejected.map(r => r.id)]);
  return floats.every(f => seen.has(f.id)) && seen.size === floats.length;
}

{
  const floats = [
    { id: 'f1', shift_id: 's1' },   // owned
    { id: 'f2', shift_id: 's2' },   // shift NOT owned (rejected this push)
    { id: 'f3', shift_id: 's1' },   // owned
  ];
  const res = routeFloats(floats, ['s1']);

  ok('owned-shift floats are upserted', res.upserted.join(',') === 'f1,f3', res.upserted.join(','));
  ok('float with unowned shift is REJECTED, not dropped',
     res.rejected.length === 1 && res.rejected[0].id === 'f2');
  ok('rejection carries table float_transactions + missing_shift',
     res.rejected[0].table === 'float_transactions' && res.rejected[0].code === 'missing_shift');
  ok('EVERY incoming float is either upserted or rejected (no silent skip)',
     everyFloatAccountedFor(floats, res));
}

{
  // all shifts owned → nothing rejected
  const floats = [{ id: 'f1', shift_id: 's1' }, { id: 'f2', shift_id: 's1' }];
  const res = routeFloats(floats, ['s1']);
  ok('all-owned → no rejections', res.rejected.length === 0 && res.upserted.length === 2);
  ok('all-owned → all accounted for', everyFloatAccountedFor(floats, res));
}

{
  // none owned → all rejected, none lost
  const floats = [{ id: 'f1', shift_id: 'sX' }, { id: 'f2', shift_id: 'sY' }];
  const res = routeFloats(floats, ['s1']);
  ok('none-owned → all rejected, zero upserted',
     res.rejected.length === 2 && res.upserted.length === 0);
  ok('none-owned → all accounted for (nothing marked synced by omission)',
     everyFloatAccountedFor(floats, res));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
