/**
 * product-days.test.mjs — 0.6.31: a product SHOWN only on chosen days (still sold any day).
 *
 * Owner, 2026-10-02: "show products only on chosen days, but the product should be able to sell anyday not just the
 * selected day" (a pizza client's Tuesday and Thursday offer). The shared rule run for real; the cloud's menu-import parser
 * run from the built server; source assertions on the routes and the screens.
 *
 * MUTATIONS TO CONFIRM BITE: onGrid ignores the search → "a search finds it on any day" fails; showsOnDay hides a
 * product with a bad value → "a bad stored value never hides a product" fails; the till / web POS grid without the day
 * rule → its source pin fails; the QR menu unfiltered → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const D = await import(pathToFileURL(path.join(ROOT, 'shared/productDays.ts')).href);
const TUE = new Date(2026, 9, 6, 12), WED = new Date(2026, 9, 7, 12);   // Tue 6 Oct 2026, Wed 7 Oct 2026 (local)

await ok('days are read from names, numbers or JSON; none or all seven = every day (null)', () => {
  assert.deepStrictEqual(D.cleanShowDays('Tue, Thu'), [2, 4]);
  assert.deepStrictEqual(D.cleanShowDays('thursday tuesday'), [2, 4]);
  assert.deepStrictEqual(D.cleanShowDays([4, 2, 2]), [2, 4]);
  assert.deepStrictEqual(D.cleanShowDays('[2,4]'), [2, 4]);
  assert.strictEqual(D.cleanShowDays([]), null);
  assert.strictEqual(D.cleanShowDays([0, 1, 2, 3, 4, 5, 6]), null);
  assert.strictEqual(D.cleanShowDays('every day'), null);
  assert.strictEqual(D.cleanShowDays('Funday'), undefined);
  assert.strictEqual(D.cleanShowDays([9]), undefined);
});
await ok('on its days it is on the grid; on other days it is not', () => {
  assert.strictEqual(D.showsToday([2, 4], TUE), true);
  assert.strictEqual(D.showsToday([2, 4], WED), false);
  assert.strictEqual(D.showsToday(null, WED), true);
});
await ok('a search finds it on any day — it still sells', () => {
  assert.strictEqual(D.onGrid([2, 4], true, WED), true);
  assert.strictEqual(D.onGrid([2, 4], false, WED), false);
});
await ok('a bad stored value never hides a product', () => {
  assert.strictEqual(D.showsOnDay('nonsense', 3), true);
});
await ok('the label', () => {
  assert.strictEqual(D.showDaysLabel([2, 4]), 'Tue, Thu');
  assert.strictEqual(D.showDaysLabel(null), 'Every day');
});

// ── The menu upload (the cloud's real parser, from the built server) ─────────
const DIST = path.join(ROOT, 'apps/server/dist');
if (fs.existsSync(path.join(DIST, 'lib/productImport.js'))) {
  const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
  const P = require(path.join(DIST, 'lib/productImport.js'));
  const opts = { isCreate: false, categoryProvided: false, categoryId: null };
  await ok('menu upload: a show_days column "Tue, Thu" is stored as [2, 4]; DELETE = every day; a bad one is refused', () => {
    assert.deepStrictEqual(P.buildProductPatch({ name: 'Offer', show_days: 'Tue, Thu' }, opts).patch.show_days, [2, 4]);
    assert.strictEqual(P.buildProductPatch({ name: 'Offer', show_days: 'DELETE' }, opts).patch.show_days, null);
    assert.match(P.buildProductPatch({ name: 'Offer', show_days: 'Funday' }, opts).error, /invalid show_days/);
    assert.ok(!('show_days' in P.buildProductPatch({ name: 'Offer' }, opts).patch), 'a blank column must leave the days alone');
  });
} else {
  console.log('SKIP  menu upload (apps/server/dist not built)');
}

// ── The wiring (source) ───────────────────────────────────────────────────────
await ok('cloud: create and edit validate show_days; the QR menu shows a product only on its days (business day)', () => {
  const r = read('apps/server/src/routes/products.ts');
  assert.match(r, /const createDays = cleanShowDays\(show_days\);/);
  assert.match(r, /show_days:      createDays,/);
  assert.match(r, /if \(show_days     !== undefined\) updates\.show_days     = updateDays;/);
  const q = read('apps/server/src/routes/qr.ts');
  assert.match(q, /\.filter\(\(p: any\) => showsOnDay\(p\.show_days, bizDay\)\)/);
  assert.match(q, /products:   menuProducts,/);
});
await ok('till and web POS grids: on the grid on its days, found by a search any day', () => {
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /const matchDay    = onGrid\(\(p as any\)\.show_days, search\.trim\(\) !== ''\);\s*return p\.status === 'active' && matchCat && matchSearch && matchFuel && matchDay;/);
  assert.match(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /const matchDay = onGrid\(\(p as any\)\.show_days, search\.trim\(\) !== ''\);\s*return p\.status === 'active' && matchCat && matchSearch && matchFuel && matchDay;/);
});
await ok('dashboard: the product form sets the days; the upload template documents the column', () => {
  const f = read('apps/dashboard/src/pages/products/ProductsPage.tsx');
  assert.match(f, /data-testid="show-days"/);
  assert.match(f, /show_days: cleanShowDays\(form\.show_days\) \?\? null,/);
  assert.match(read('apps/dashboard/src/pages/products/MenuUpload.tsx'), /'status', 'show_days'\]/);
});
await ok('migration 113 and the schema index carry products.show_days', () => {
  assert.match(read('migrations/113_product_show_days.sql'), /ADD COLUMN IF NOT EXISTS show_days smallint\[\];/);
  assert.strictEqual(JSON.parse(read('scripts/schema-index.json')).products.show_days, '"ARRAY"');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
