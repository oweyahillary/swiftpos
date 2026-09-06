/**
 * manager-create-po.test.mjs — A228 source guards (rule 24), mutation-checkable.
 * A manager raises a PO for their OWN branch, straight to Ordered (option a: no
 * approval step). Suppliers + ingredients feed the picker; qty>0 lines are sent.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rx = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('A228: creates a PO for the manager\'s OWN branch', () => {
  assert.match(rx, /posApi\.post<\{ id: string \}>\('\/api\/stock\/purchase-orders', \{\s*branch_id: branchId/);
});
ok('A228: sends it straight to Ordered (option a — no approval)', () => {
  assert.match(rx, /posApi\.patch\(`\/api\/stock\/purchase-orders\/\$\{po\.id\}`, \{ status: 'ordered' \}\)/);
});
ok('A228: only lines with a quantity are ordered', () => {
  assert.match(rx, /\.filter\(i => i\.quantity_ordered > 0\)/);
});
ok('A228: lazy-loads suppliers + active ingredients for the picker', () => {
  assert.match(rx, /posApi\.get<\{ id: string; name: string \}\[\]>\('\/api\/stock\/suppliers'\)/);
  assert.match(rx, /\/api\/stock\/ingredients\?status=active/);
});
ok('A228: a New PO button opens the form', () => {
  assert.match(rx, /onClick=\{\(\) => void openNewPO\(\)\}/);
  assert.match(rx, /New PO/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
