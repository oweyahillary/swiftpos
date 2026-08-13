/**
 * role-tier.test.mjs — the onboarding seeder normalises role names (register A63).
 *
 * The seeder decided a new role's grant tier by an un-normalised, exact match
 * (nm === 'branch_manager'), so a business that typed "Branch Manager" with a
 * space fell through to 'none' and was seeded with ZERO permissions — no error,
 * no staff access. Same shape as A61, one layer up. roleTier now normalises with
 * the SAME lower(replace(name,' ','_')) the grant migrations use.
 *
 * Driven against the REAL compiled function, not a model of it — build first:
 *   cd apps/server && npm run build && node ../../tests/role-tier.test.mjs
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let roleTier;
try {
  ({ roleTier } = require(path.join(here, '../apps/server/dist/lib/roleTier.js')));
} catch {
  console.error('\nCannot load apps/server/dist/lib/roleTier.js — build the server first:\n' +
                '  cd apps/server && npm run build\n');
  process.exit(1);
}

let passed = 0, failed = 0;
const eq = (label, got, want) => {
  if (got === want) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} — got ${got}, want ${want}`); }
};

console.log('\nrole-tier — A63 name normalisation\n');

// The regression: a space-typed manager name must resolve to the manager tier,
// not fall through to 'none' (an empty rights set).
eq('"Branch Manager" (space) -> manager (A63)', roleTier('Branch Manager'), 'manager');
eq('"branch_manager" -> manager',               roleTier('branch_manager'), 'manager');
eq('"Branch  Manager" (2 spaces) matches the migration shape too',
   roleTier('Branch  Manager'), roleTier('branch__manager')); // both normalise the same way

// The ordinary cases still resolve.
eq('"Manager" -> manager',   roleTier('Manager'),   'manager');
eq('"MANAGER" -> manager',   roleTier('MANAGER'),   'manager');
eq('"Supervisor" -> manager',roleTier('Supervisor'),'manager');
eq('"Admin" -> full',        roleTier('Admin'),     'full');
eq('"owner" -> full',        roleTier('owner'),     'full');
eq('"Cashier" -> cashier',   roleTier('Cashier'),   'cashier');

// A genuinely custom role gets nothing (owner configures it) — and a name that
// merely CONTAINS a keyword must not be swept in.
eq('"Trainee Manager" -> none (not swept into manager)', roleTier('Trainee Manager'), 'none');
eq('"Waiter" -> none',       roleTier('Waiter'),    'none');
eq('empty name -> none',     roleTier(''),          'none');

console.log(`\n${failed === 0
  ? `all ${passed} passed — the seeder can no longer create a zero-permission manager.`
  : `${failed} FAILED (${passed} passed)`}`);
process.exit(failed === 0 ? 0 : 1);
