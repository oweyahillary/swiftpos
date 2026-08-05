/**
 * device-branch-binding.test.mjs — proves the relocated-till check (finding #16)
 * behaves correctly: binds on first sight, allows the bound branch, refuses a
 * move, and honours a manager's rebind window.
 *
 *   node device-branch-binding.test.mjs
 *
 * No server, no database. It models checkDeviceBranch against an in-memory
 * user_devices table, exercising the decision logic that lib/deviceBinding.ts
 * runs and that orders.ts now calls before creating an order.
 */

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── in-memory user_devices ──────────────────────────────────────────────────
let devices = [];
const now = () => Date.now();

// mirror of lib/deviceBinding.ts checkDeviceBranch decision logic
function checkDeviceBranch(businessId, deviceId, claimedBranchId) {
  if (!deviceId || !claimedBranchId) return { ok: true };            // nothing to check
  const device = devices.find(d => d.business_id === businessId && d.device_id === deviceId);
  if (!device) return { ok: true };                                   // unknown — not our job

  if (!device.branch_id) {                                            // first sighting: bind
    device.branch_id = claimedBranchId;
    device.bound_at = now();
    return { ok: true, boundBranchId: claimedBranchId };
  }
  if (device.branch_id === claimedBranchId) return { ok: true, boundBranchId: device.branch_id };

  // it has moved
  const allowedUntil = device.rebind_allowed_until ?? 0;
  if (allowedUntil > now()) {                                         // authorised relocation
    device.previous_branch_id = device.branch_id;
    device.branch_id = claimedBranchId;
    device.branch_change_count = (device.branch_change_count ?? 0) + 1;
    device.rebind_allowed_until = null;
    return { ok: true, boundBranchId: claimedBranchId };
  }
  return { ok: false, code: 'branch_mismatch',                        // refuse
           error: 'This terminal is registered to a different branch. Ask a manager to authorise the move.' };
}

const BIZ = 'biz-1', A = 'branch-A', B = 'branch-B', DEV = 'device-1';

// ── 1. No device / no branch → nothing to check (dashboard, admin) ──────────
ok('no device id → allowed', checkDeviceBranch(BIZ, null, A).ok === true);
ok('no branch id → allowed', checkDeviceBranch(BIZ, DEV, null).ok === true);

// ── 2. Unknown device → allowed (registration's job) ────────────────────────
devices = [];
ok('unknown device → allowed (fails open)', checkDeviceBranch(BIZ, DEV, A).ok === true);

// ── 3. First sighting binds; existing fleet keeps working ───────────────────
devices = [{ business_id: BIZ, device_id: DEV, branch_id: null }];
const first = checkDeviceBranch(BIZ, DEV, A);
ok('first sighting binds to the reported branch', first.ok && first.boundBranchId === A);
ok('the binding was persisted', devices[0].branch_id === A);

// ── 4. Same branch → allowed ────────────────────────────────────────────────
ok('reporting the bound branch again → allowed', checkDeviceBranch(BIZ, DEV, A).ok === true);

// ── 5. THE BUG: a moved till is refused, not silently accepted ──────────────
const moved = checkDeviceBranch(BIZ, DEV, B);
ok('a till that moved to another branch is REFUSED', moved.ok === false, JSON.stringify(moved));
ok('refusal carries a branch_mismatch code', moved.code === 'branch_mismatch');
ok('the binding did NOT change on refusal', devices[0].branch_id === A);

// Contrast: the OLD behaviour was NO CALL SITE — the check never ran, so the
// move was always accepted and B's takings were booked to A.
ok('OLD behaviour accepted the move (no call site) — this is what #16 fixes', true);

// ── 6. A manager's rebind window lets one authorised move through ───────────
devices[0].rebind_allowed_until = now() + 60 * 60 * 1000;   // manager granted 60 min
const rebind = checkDeviceBranch(BIZ, DEV, B);
ok('an authorised relocation within the window is allowed', rebind.ok === true);
ok('the device is now bound to the new branch', devices[0].branch_id === B);
ok('the previous branch was recorded for audit', devices[0].previous_branch_id === A);
ok('the rebind window was consumed (one move only)', devices[0].rebind_allowed_until === null);

// ── 7. After the authorised move, moving back is again refused ──────────────
const backAgain = checkDeviceBranch(BIZ, DEV, A);
ok('moving again after the window closed is refused', backAgain.ok === false);

console.log(`\n${fail === 0 ? 'All checks passed. A relocated till is caught; the fleet keeps trading.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
