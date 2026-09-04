/**
 * modifier-option-add.test.mjs — A148 (add an option to a SAVED modifier group).
 * The group-create form added options and a saved group could DELETE them, but had
 * no "add option to an existing group" control. This wires the live endpoint.
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/products/VariantsDrawer.tsx'), 'utf8');
const srv  = fs.readFileSync(path.join(root, 'apps/server/src/routes/modifiers.ts'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('server: POST /options exists, guarded + business-scoped', () => {
  assert.match(srv, /router\.post\('\/options', requirePermission\('products\.manage'\)/, 'endpoint must be permission-gated');
  assert.match(srv, /modifierGroupOwned\(modifier_group_id, req\.businessId\)/, 'must verify the group belongs to the business');
});
ok('client: a saved group can add an option via the endpoint', () => {
  assert.match(page, /api\.post\('\/api\/modifiers\/options', \{[\s\S]*?modifier_group_id: addOpt\.groupId/, 'must POST to /api/modifiers/options with the group id');
  assert.match(page, /await fetchAll\(\);/, 'must refresh after adding');
});
ok('client: an "Add option" control is rendered on saved groups', () => {
  assert.match(page, /\+ Add option/, 'the add-option button must render');
  assert.match(page, /setAddOpt\(\{ groupId: group\.id/, 'the button must target the specific saved group');
});
console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
