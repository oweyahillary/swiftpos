/**
 * product-info.test.mjs — A428 (owner, 2026-10-09: "how can the cashier view menu description for ease of explaining to the
 * customer?"). An ⓘ on a product with a description, on the till and the web POS, opens it; nothing is added to the order
 * until "Add to order". Pinned on the source (React is not run here).
 *
 *   node test/product-info.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: the ⓘ's tap not stopped → "the ⓘ adds nothing" fails; the ⓘ shown on every product →
 * "only with a description" fails; "Add to order" dropped → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const till = read('src/renderer/pages/POSPage.tsx');
const web = read('../dashboard/src/pages/pos/CashierScreen.tsx');

for (const [name, src, add] of [['till', till, 'handleTap(p)'], ['web POS', web, 'addToCart(p)']]) {
  ok(`${name}: the ⓘ only on a product with a description`, /\{String\(\(?product(?: as any\))?\.description \?\? ''\)\.trim\(\) && \(\s*<span role="button"/.test(src));
  ok(`${name}: the ⓘ adds nothing — its tap stops at the ⓘ and opens the description`,
    src.includes('onClick={(e) => { e.stopPropagation(); setInfoProduct(product); }}'));
  ok(`${name}: the card shows the description; "Add to order" adds it, "Close" does not`,
    /data-testid="product-info-card"/.test(src) && /\{infoProduct\.description\}/.test(src)
    && src.includes(`onClick={() => { const p = infoProduct; setInfoProduct(null); ${add}; }}`)
    && /onClick=\{\(\) => setInfoProduct\(null\)\}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
