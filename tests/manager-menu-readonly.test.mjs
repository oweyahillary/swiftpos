/**
 * manager-menu-readonly.test.mjs — A208 (read-only manager Menu tab).
 *
 * Product decision: web menu EDITING stays owner-only. Managers get a READ-ONLY
 * Menu tab (view products/prices/category/active) so they can answer "what's on,
 * what's the price" without editing. The critical property: this tab makes NO
 * mutating call — no create/update/delete of products.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tab = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerMenuTab.tsx'), 'utf8');
const mgr = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('tab: reads the menu (products) grouped by category', () => {
  assert.match(tab, /posApi\.get<Product\[\]>\('\/api\/products'\)/, 'must fetch /api/products');
  assert.match(tab, /categories\?\.name/, 'must group by category');
});

ok('tab: is READ-ONLY — zero mutating calls', () => {
  const muts = tab.match(/posApi\.(post|patch|put|delete)\(/g) || [];
  assert.strictEqual(muts.length, 0, `a read-only menu tab must make no mutations; found ${muts.length}`);
});

ok('dashboard: Menu tab gated on products.view (read perm), wired', () => {
  assert.match(mgr, /key: 'menu',[\s\S]*?permission: 'products\.view'/, "Menu nav item gated on products.view (read)");
  assert.match(mgr, /case 'menu': return <ManagerMenuTab/, 'the switch must render the Menu tab');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
