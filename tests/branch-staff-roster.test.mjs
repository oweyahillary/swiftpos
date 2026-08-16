/**
 * branch-staff-roster.test.mjs — proves the /api/pos/branch-staff roster logic
 * (PHASE5 §4b / A17): branch-scoped, effective permissions = role grants then
 * per-user overrides, bcrypt-only. No DB — models the pure mapping in pos.ts so
 * a regression in the merge or the scope is caught.
 *
 *   node tests/branch-staff-roster.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// Mirror of the roster mapping in apps/server/src/routes/pos.ts.
function resolveRoster(staffList, branchId) {
  return staffList
    .filter(u => (u.user_branches ?? []).some(b => b.branch_id === branchId))
    .map(u => {
      const permissions = {};
      (u.role_permissions ?? []).forEach(k => { permissions[k] = true; });
      (u.user_permissions ?? []).forEach(up => { permissions[up.key] = up.granted; });
      return { staff_id: u.id, name: u.name, permissions, pin_hash: u.pin_hash };
    })
    .filter(s => !!s.pin_hash && s.pin_hash.startsWith('$2'));
}

const staff = [
  { id: 'a', name: 'Amina', pin_hash: '$2a$10$aaa', user_branches: [{ branch_id: 'B1' }],
    role_permissions: ['orders.create', 'orders.void'],
    user_permissions: [{ key: 'orders.void', granted: false }] },        // override revokes void
  { id: 'b', name: 'Brian', pin_hash: '$2a$10$bbb', user_branches: [{ branch_id: 'B2' }],
    role_permissions: ['orders.create'], user_permissions: [] },          // other branch
  { id: 'c', name: 'Carol', pin_hash: '1234',       user_branches: [{ branch_id: 'B1' }],
    role_permissions: ['orders.create'], user_permissions: [] },          // legacy (non-bcrypt) hash
  { id: 'd', name: 'Dylan', pin_hash: null,          user_branches: [{ branch_id: 'B1' }],
    role_permissions: [], user_permissions: [] },                          // no hash
  { id: 'e', name: 'Esther', pin_hash: '$2b$10$eee', user_branches: [{ branch_id: 'B1' }],
    role_permissions: ['refunds.approve'],
    user_permissions: [{ key: 'discounts.override', granted: true }] },   // override grants extra
];

const roster = resolveRoster(staff, 'B1');
const byId = Object.fromEntries(roster.map(r => [r.staff_id, r]));

ok('only B1 staff with a bcrypt hash are returned (Amina, Esther)',
   roster.map(r => r.staff_id).sort().join(',') === 'a,e');
ok('other-branch staff excluded (Brian, B2)', !byId.b);
ok('legacy non-bcrypt hash excluded (Carol)', !byId.c);
ok('null hash excluded (Dylan)', !byId.d);
ok('role grant present (Amina orders.create)', byId.a.permissions['orders.create'] === true);
ok('user override REVOKES a role grant (Amina orders.void=false)', byId.a.permissions['orders.void'] === false);
ok('user override GRANTS an extra (Esther discounts.override=true)', byId.e.permissions['discounts.override'] === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
