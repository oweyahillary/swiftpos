/**
 * node-verify-pin.test.mjs — proves the node's verify-pin decision refuses on two
 * matches and returns the single match otherwise (PHASE5 §4c / A17). Models the
 * decision in branchStaff.ts::verifyPinAtNode (which is coupled to safeStorage +
 * bcrypt, so the pure decision is modelled here). Guards the invariant that a
 * shared PIN is never guessed.
 *
 *   node tests/node-verify-pin.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// Mirror of the decision after bcrypt comparison: `matches` are the roster rows
// whose hash matched the PIN.
function decide(rosterLength, matches) {
  if (rosterLength === 0) return { ok: false, reason: 'no_roster' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  if (matches.length === 0) return { ok: false, reason: 'no_match' };
  return { ok: true, staff: matches[0] };
}

ok('empty roster → no_roster', decide(0, []).reason === 'no_roster');
ok('no candidate matched → no_match', decide(3, []).reason === 'no_match');
ok('exactly one match → ok', (() => { const v = decide(3, [{ staff_id: 'a' }]); return v.ok && v.staff.staff_id === 'a'; })());
ok('two share the PIN → REFUSED (ambiguous), never guessed',
   decide(3, [{ staff_id: 'a' }, { staff_id: 'b' }]).reason === 'ambiguous');
ok('three share the PIN → still refused', decide(5, [{}, {}, {}]).reason === 'ambiguous');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
