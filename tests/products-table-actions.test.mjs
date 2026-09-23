/**
 * products-table-actions.test.mjs — A318: the Products table's row actions stay on screen.
 *
 *   node tests/products-table-actions.test.mjs
 *
 * Owner 2026-09-23: "family meals am not able to edit prices but burgers i can". Edit/Delete were rendered for every
 * row, but the table sat in an `overflow-hidden` card: long descriptions (Family Meals) widened the Product column and
 * the actions were pushed past the card edge — clipped, no scrollbar. Burgers (short/no descriptions) fitted.
 *
 * The behaviour was measured in a real browser on the bench (the REAL ProductsPage, the dashboard's Tailwind build, the
 * owner's rows): before — Family Meals at 1100 px: Edit visible 0/5, no user-scrollable container, while Burgers at the
 * same width was 3/3; after — Edit and Delete hit-testable in every row at 900–1920 px in every filter, and a click on
 * Edit opens that product's form. CI has no browser, so this file pins the three things that produce that behaviour.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - remove the inner overflow-x-auto wrapper   → "the table scrolls inside the card" fails
 *   - drop sticky/right-0 from the actions cell   → "the actions cell is pinned right" fails
 *   - drop its opaque background                  → "…with an opaque background" fails
 *   - drop sticky from the header's last cell     → "the header's actions cell is pinned too" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/products/ProductsPage.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

// The products table: the <table> whose header has the "Product" column.
const tableAt = src.indexOf('<table', src.indexOf('rounded-xl overflow-hidden'));
const before = src.slice(Math.max(0, tableAt - 600), tableAt);
ok('found the products table', tableAt > 0 && /Product<\/th>/.test(src.slice(tableAt, tableAt + 2000)));
ok('the table scrolls inside the card (overflow-x-auto between the clipping card and <table>)',
  /overflow-hidden">[\s\S]*<div className="overflow-x-auto">\s*<table/.test(before + src.slice(tableAt, tableAt + 6)));

// The actions cell: the <td> that holds the Edit button.
const editAt = src.indexOf('onClick={() => openEdit(p)}');
const tdOpen = src.lastIndexOf('<td', editAt);
const td = src.slice(tdOpen, src.indexOf('>', tdOpen) + 1);
ok('the actions cell holds Edit', tdOpen > 0 && editAt > tdOpen);
ok('the actions cell is pinned right (sticky right-0)', /\bsticky\b/.test(td) && /\bright-0\b/.test(td), td);
ok('…with an opaque background, so scrolled cells pass beneath it', /\bbg-gray-900\b/.test(td), td);
ok('the actions never wrap out of the cell', /justify-end whitespace-nowrap/.test(src.slice(tdOpen, editAt)));

// Header: the last <th> of the products table's header row.
const headEnd = src.indexOf('</tr>', tableAt);
const lastTh = src.slice(src.lastIndexOf('<th', headEnd), headEnd);
ok('the header\'s actions cell is pinned too (columns stay aligned)', /\bsticky\b/.test(lastTh) && /\bright-0\b/.test(lastTh), lastTh);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
