/**
 * menu-template.test.mjs — A307: the in-app menu upload template (dashboard MenuUpload.tsx
 * downloadTemplate) offers the tabs and the worked upgrade examples we rely on.
 *
 *   node tests/menu-template.test.mjs
 *
 * The template is generated client-side with SheetJS, so its content lives in source; this
 * guards it against silent regressions (e.g. the fries example being dropped, or the ladder
 * baseline rule falling out of the Read me).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - remove the "Fries size" rows          → "fries upgrade example present" fails
 *   - remove the "Drink size" rows          → "drink-size upgrade example present" fails
 *   - drop the "ONE option MUST be 0" line  → "Read me explains the ladder baseline" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/products/MenuUpload.tsx'), 'utf8');
// Just the template generator, so unrelated code can't satisfy a check by accident.
const fn = src.slice(src.indexOf('function downloadTemplate'), src.indexOf("XLSX.writeFile(wb, 'swiftpos-restaurant-import-template.xlsx')") + 60);

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

ok('canonical SwiftPOS title (not a client name)', /SwiftPOS — Restaurant menu upload template/.test(fn) && !/Kudo Kudo/.test(fn));
ok('all five tabs built', ["'Read me'","'Products'","'Upgrades & Spices'","'Recipe'","'Ingredients'"].every(t => fn.includes(t)));
ok('Products header carries is_kitchen + plu_code', /'is_kitchen'/.test(fn) && /'plu_code'/.test(fn));
ok('drink-size upgrade example present', /'Drink size'.*'upgrade'/.test(fn) && /'1\.25L'/.test(fn));
ok('fries upgrade example present (Regular 0 / Large paid)',
   /'Fries size'/.test(fn) && /'Regular Fries'.*'Regular'.*\b0\b/.test(fn) && /'Regular Fries'.*'Large'.*\b60\b/.test(fn));
ok('Read me explains the ladder baseline (one option = 0)', /ONE option MUST be 0/i.test(fn));
ok('Read me explains free vs upgrade', /free\b/.test(fn) && /upgrade\b/.test(fn));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
