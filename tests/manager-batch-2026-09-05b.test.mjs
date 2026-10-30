/**
 * manager-batch-2026-09-05b.test.mjs — source guards for this batch.
 *   A215 — inventory.ts write routes must carry a permission gate (were requireAuth-only).
 *   A219 — (retired with the web manager portal, A608 2026-10-29).
 * Source-level (rule 24), mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inv = fs.readFileSync(path.join(root, 'apps/server/src/routes/inventory.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── A215 ──────────────────────────────────────────────────────────────────
ok('A215: POST /adjust is gated on inventory.adjust (owner-only)', () => {
  assert.match(inv, /router\.post\('\/adjust',\s*requirePermission\('inventory\.adjust'\)/,
    'POST /adjust must require inventory.adjust');
});
ok('A215: PATCH /threshold is gated (adjust or receive), not open to any auth user', () => {
  // A595: reorder levels are their own part of BOTH adjust and receive (inventory.reorder — every holder of either got it).
  assert.match(inv, /router\.patch\('\/:product_id\/threshold',\s*requirePermission\('inventory\.reorder'\)/,
    'PATCH /threshold must require inventory.reorder');
});
ok('A215: the guards are imported', () => {
  assert.match(inv, /requirePermission,\s*requireAnyPermission|requireAnyPermission[\s\S]*requirePermission/,
    'both guards must be imported from rbac');
});

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the A219 sidebar (branch name as the primary label) lived only in ManagerDashboard.tsx.

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
