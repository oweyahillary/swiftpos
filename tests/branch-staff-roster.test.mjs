/**
 * branch-staff-roster.test.mjs — proves the /api/pos/branch-staff roster logic
 * (PHASE5 §4b / A17): branch-scoped, effective permissions = role grants then
 * per-user overrides, bcrypt-only. No DB — models the pure mapping in pos.ts so
 * a regression in the merge or the scope is caught.
 *
 * A426 (owner, 2026-10-09: every till behind a branch server said "This branch server has no staff roster yet" while
 * the same PINs signed in on the server): the branch rule is now the REAL one from apps/server/dist/lib/branchAccess.js,
 * shared with PIN sign-in — staff with no branch assigned work at every branch, so they are on every branch's roster.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/branch-staff-roster.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - worksAtBranch back to "only explicitly assigned"        → "staff with no branch assigned are on the roster" fails
 *   - pos.ts or auth.ts with its own branch check again        → the "one rule" pins fail
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist/lib/branchAccess.js');
if (!fs.existsSync(DIST)) { console.log('Build the server first: cd apps/server && npm run build'); process.exit(1); }
const { worksAtBranch } = createRequire(import.meta.url)(DIST);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// Mirror of the roster mapping in apps/server/src/routes/pos.ts.
function resolveRoster(staffList, branchId) {
  return staffList
    .filter(u => worksAtBranch(u.user_branches, branchId))
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
  { id: 'f', name: 'Faith', pin_hash: '$2b$10$fff', user_branches: [],
    role_permissions: ['orders.create'], user_permissions: [] },          // A426: no branch assigned = every branch
  { id: 'g', name: 'George', pin_hash: '$2b$10$ggg',
    role_permissions: ['orders.create'], user_permissions: [] },          // A426: user_branches missing altogether
];

const roster = resolveRoster(staff, 'B1');
const byId = Object.fromEntries(roster.map(r => [r.staff_id, r]));

ok('B1 staff with a bcrypt hash are returned (Amina, Esther, and Faith and George who have no branch assigned)',
   roster.map(r => r.staff_id).sort().join(',') === 'a,e,f,g');
ok('A426: staff with no branch assigned are on the roster — a shop where nobody is tied to a branch is not empty',
   !!byId.f && !!byId.g && resolveRoster(staff.filter(u => ['f', 'g'].includes(u.id)), 'B1').length === 2);
ok('…and on every branch\'s roster (B2 too), as PIN sign-in lets them work anywhere',
   resolveRoster(staff, 'B2').map(r => r.staff_id).sort().join(',') === 'b,f,g');
ok('other-branch staff excluded (Brian, B2)', !byId.b);
ok('legacy non-bcrypt hash excluded (Carol)', !byId.c);
ok('null hash excluded (Dylan)', !byId.d);
ok('role grant present (Amina orders.create)', byId.a.permissions['orders.create'] === true);
ok('user override REVOKES a role grant (Amina orders.void=false)', byId.a.permissions['orders.void'] === false);
ok('user override GRANTS an extra (Esther discounts.override=true)', byId.e.permissions['discounts.override'] === true);

const src = (p) => fs.readFileSync(path.join(ROOT, 'apps/server/src', p), 'utf8');
ok('A426: one rule — the roster route uses worksAtBranch and no branch check of its own',
   /\.filter\(\(u: any\) => worksAtBranch\(u\.user_branches, branchId\)\)/.test(src('routes/pos.ts'))
   && !/user_branches \?\? \[\]\)\.some/.test(src('routes/pos.ts')));
ok('A426: …and PIN sign-in uses the same function',
   /if \(!worksAtBranch\(matchedUser\.user_branches, branch_id\)\)/.test(src('routes/auth.ts'))
   && !/branchAccess\.length > 0/.test(src('routes/auth.ts')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
