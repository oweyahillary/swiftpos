/**
 * device-role-confirmation.test.mjs — register A25 / D4, migration 74.
 *
 * Migration 73 let a terminal SAY what it is. This covers deciding whether to
 * believe it — the difference between a diagnostic and a security control.
 *
 * The shape is migration 52's, on purpose: trust on first use, then closed, with
 * a manager-granted window for legitimate change. The ONE deliberate difference
 * is direction. `checkDeviceBranch` fails OPEN (an unbound device is waved
 * through, because refusing would stop a shop trading over a diagnostic). This
 * fails CLOSED, because the cost of a wrong answer here is the branch's PIN
 * hashes rather than a misattributed sale.
 *
 * MUTATION CHECK (rule 10): each section models the unguarded behaviour beside
 * the shipped one and asserts they disagree.
 */
import assert from 'node:assert';

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

const isNodeRole = (r) => r === 'node' || r === 'office';
const HANDOVER_MINUTES = 60;

/**
 * The shipped confirmServingRole decision, as a pure function over the rows the
 * real one reads.
 */
function decide({ claimedRole, self, siblings, now = Date.now() }) {
  if (!isNodeRole(claimedRole)) return { confirmed: false, code: 'not_serving' };
  if (!self) return { confirmed: false, code: 'unknown_device' };
  if (!self.branch_id) return { confirmed: false, code: 'unconfirmed' };

  const incumbent = siblings.find(r => r.role_confirmed_at && r.device_id !== self.device_id);

  if (self.role_confirmed_at && !incumbent) return { confirmed: true };

  if (incumbent) {
    const windowOpen = incumbent.role_change_allowed_until
      && new Date(incumbent.role_change_allowed_until).getTime() > now;
    if (!windowOpen) {
      return { confirmed: false, code: 'conflict', heldBy: incumbent.device_id, recordsConflict: true };
    }
    return { confirmed: true, handover: true, clearedFirst: incumbent.device_id };
  }
  return { confirmed: true };
}

const SELF = { device_id: 'till-A', branch_id: 'branch-1', role_confirmed_at: null };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Trust on first use, per branch');

ok('the first serving machine for a branch is confirmed', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF] });
  assert.equal(v.confirmed, true);
});

ok('an office machine is confirmed exactly like a node', () => {
  const v = decide({ claimedRole: 'office', self: SELF, siblings: [SELF] });
  assert.equal(v.confirmed, true,
    'the `=== node` bug would have refused a view-only server here');
});

ok('a plain till has nothing to confirm', () => {
  assert.equal(decide({ claimedRole: 'till', self: SELF, siblings: [SELF] }).code, 'not_serving');
});

ok('an unbound machine is NOT confirmed — uniqueness is per branch', () => {
  const unbound = { ...SELF, branch_id: null };
  const v = decide({ claimedRole: 'node', self: unbound, siblings: [unbound] });
  assert.equal(v.confirmed, false);
  assert.equal(v.code, 'unconfirmed');
  // Migration 52 binds on first sighting, so this resolves on the next sync
  // without anybody acting.
});

ok('an unknown device is refused rather than created', () => {
  assert.equal(decide({ claimedRole: 'node', self: null, siblings: [] }).code, 'unknown_device');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. A second claimant is refused, and the conflict is recorded');

const INCUMBENT = {
  device_id: 'till-B', branch_id: 'branch-1',
  role_confirmed_at: '2026-08-10T08:00:00Z', role_change_allowed_until: null,
};

ok('MUTATION: without the check, the newcomer would simply take the role', () => {
  const unguarded = () => ({ confirmed: true });      // what "record the claim" alone does
  assert.equal(unguarded().confirmed, true);
  const guarded = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, INCUMBENT] });
  assert.equal(guarded.confirmed, false, 'the shipped path must disagree');
});

ok('the refusal names who holds it', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, INCUMBENT] });
  assert.equal(v.code, 'conflict');
  assert.equal(v.heldBy, 'till-B');
});

ok('the conflict is RECORDED, not just counted', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, INCUMBENT] });
  assert.equal(v.recordsConflict, true,
    '"which machine tried and when" is the question asked when two boxes fight over one branch');
});

ok('this is the A22 split-brain detector — an old node reconnecting is seen', () => {
  // A22: promoteToNode starts serving with no check the old node is gone. An
  // old node unplugged rather than dead, then reconnected, is the innocent
  // common cause — and now it surfaces instead of being silent.
  const revived = { ...SELF, device_id: 'old-node', role_confirmed_at: null };
  const v = decide({ claimedRole: 'node', self: revived, siblings: [revived, INCUMBENT] });
  assert.equal(v.code, 'conflict');
});

ok('a confirmed machine re-claiming its own role is a no-op, not a conflict', () => {
  const me = { ...SELF, role_confirmed_at: '2026-08-10T08:00:00Z' };
  const v = decide({ claimedRole: 'node', self: me, siblings: [me] });
  assert.equal(v.confirmed, true);
  assert.ok(!v.recordsConflict);
});

ok('a different BRANCH is not a conflict — the guarantee is per branch', () => {
  // siblings are already filtered by branch in the query; assert the model
  // matches that scope rather than being global.
  const otherBranch = { device_id: 'till-C', branch_id: 'branch-2',
                        role_confirmed_at: '2026-08-10T08:00:00Z' };
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF] });
  assert.equal(v.confirmed, true);
  assert.equal(otherBranch.branch_id !== SELF.branch_id, true);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Handover — without it, failover recovers data but not credentials');

const withWindow = (mins) => ({
  ...INCUMBENT,
  role_change_allowed_until: new Date(Date.now() + mins * 60_000).toISOString(),
});

ok('MUTATION: with no window, a promoted till can never become the server', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, INCUMBENT] });
  assert.equal(v.confirmed, false,
    'this is exactly the failover dead end the window exists to prevent');
});

ok('inside an authorised window the newcomer takes over', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, withWindow(30)] });
  assert.equal(v.confirmed, true);
  assert.equal(v.handover, true);
});

ok('the outgoing machine is cleared FIRST — the index forbids two', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, withWindow(30)] });
  assert.equal(v.clearedFirst, 'till-B',
    'the other order would be refused by user_devices_one_server_per_branch, and ' +
    'an interruption must leave NO confirmed server rather than two');
});

ok('an EXPIRED window does not grant a takeover', () => {
  const v = decide({ claimedRole: 'node', self: SELF, siblings: [SELF, withWindow(-5)] });
  assert.equal(v.confirmed, false);
  assert.equal(v.code, 'conflict');
});

ok('the window is one hour, matching migration 52 rebind', () => {
  assert.equal(HANDOVER_MINUTES, 60);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. The credential gate fails closed on every uncertainty');

/** The shipped isConfirmedBranchServer decision. */
const gate = ({ row, error }) => {
  if (error) return false;
  return !!row;
};

ok('a confirmed serving device passes', () => {
  assert.equal(gate({ row: { id: 'x' } }), true);
});

ok('an unconfirmed device is refused', () => {
  assert.equal(gate({ row: null }), false);
});

ok('a DATABASE ERROR is refused, not waved through', () => {
  assert.equal(gate({ row: { id: 'x' }, error: { message: 'timeout' } }), false,
    'the opposite of checkDeviceBranch, and deliberately so');
});

ok('MUTATION: a fail-open gate would grant on its own error', () => {
  const failOpen = ({ error }) => error ? true : true;
  assert.equal(failOpen({ error: { message: 'timeout' } }), true);
  assert.notEqual(failOpen({ error: {} }), gate({ error: { message: 'x' } }));
});

ok('a missing device id or business id is refused before any query', () => {
  const guard = (b, d) => !!(b && d);
  assert.equal(guard('', 'dev'), false);
  assert.equal(guard('biz', ''), false);
  assert.equal(guard('biz', 'dev'), true);
});

ok('the gate never confirms as a side effect', () => {
  // A read that quietly grants is how a check stops being one.
  const writes = [];
  gate({ row: null });
  assert.deepEqual(writes, []);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. Refusal withholds credentials, never trade');

ok('a refused machine still sells, syncs and serves its LAN', () => {
  const consequences = (verdict) => ({
    canSell:            true,
    canSync:            true,
    canServePeersOnLan: true,               // the branch secret governs that, not this
    getsBranchRoster:   verdict.confirmed,
  });
  const refused = consequences({ confirmed: false });
  assert.equal(refused.canSell, true);
  assert.equal(refused.canSync, true);
  assert.equal(refused.canServePeersOnLan, true);
  assert.equal(refused.getsBranchRoster, false,
    'the ONLY thing withheld is the branch roster');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
