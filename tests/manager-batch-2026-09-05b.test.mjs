/**
 * manager-batch-2026-09-05b.test.mjs — source guards for this batch.
 *   A215 — inventory.ts write routes must carry a permission gate (were requireAuth-only).
 *   A219 — sidebar shows the branch name as the primary label, business name as subtitle.
 * Source-level (rule 24), mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inv = fs.readFileSync(path.join(root, 'apps/server/src/routes/inventory.ts'), 'utf8');
const md  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── A215 ──────────────────────────────────────────────────────────────────
ok('A215: POST /adjust is gated on inventory.adjust (owner-only)', () => {
  assert.match(inv, /router\.post\('\/adjust',\s*requirePermission\('inventory\.adjust'\)/,
    'POST /adjust must require inventory.adjust');
});
ok('A215: PATCH /threshold is gated (adjust or receive), not open to any auth user', () => {
  assert.match(inv, /router\.patch\('\/:product_id\/threshold',\s*requireAnyPermission\('inventory\.adjust',\s*'inventory\.receive'\)/,
    'PATCH /threshold must require adjust-or-receive');
});
ok('A215: the guards are imported', () => {
  assert.match(inv, /requirePermission,\s*requireAnyPermission|requireAnyPermission[\s\S]*requirePermission/,
    'both guards must be imported from rbac');
});

// ── A219 ──────────────────────────────────────────────────────────────────
ok('A219: sidebar renders branchName as the bold primary line', () => {
  assert.match(md, /text-sm font-bold text-white truncate">\{session\.branchName\}/,
    'the bold sidebar line must be the branch name');
});
ok('A219: business name drops to the muted subtitle', () => {
  assert.match(md, /text-xs text-gray-500 truncate">\{business\?\.name \?\? 'SwiftPOS'\}/,
    'the business/POS name must be the subtitle, not the primary label');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
