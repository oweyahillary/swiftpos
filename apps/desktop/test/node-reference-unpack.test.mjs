/**
 * node-reference-unpack.test.mjs — proves the A24 peer-side unpack
 * (referenceBundle.unpackNodeBundle) that batch -b feeds into pullCatalogue's
 * write transaction. The whole risk of the peer read is DATA LOSS from a partial
 * or old-build node bundle, so the asserts target the DON'T-WIPE guards:
 *   - a bundle missing `tables` → tablesFetched=false (peer keeps its table map)
 *   - missing `pumps` → pumpsFetched=false
 *   - missing `stations` → stations=null (routing not wiped)
 *   - missing `paymentMethods` → null (tenders not wiped)
 *   - numeric config coerced (numOrNull); junk → null, so a bad value can't
 *     overwrite a good VAT/discount ceiling.
 *
 * Drives the REAL compiled dist/main/referenceBundle.js — pure, no SQLite/
 * Electron. Does NOT prove the pullCatalogue wiring or the write transaction —
 * those close on the two-till target (rule 16).
 *
 *   Run:  npx tsc -b tsconfig.main.json --force   (in apps/desktop)
 *         node test/node-reference-unpack.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'referenceBundle.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/referenceBundle.js not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { unpackNodeBundle } = await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// A complete, well-formed bundle (as the current node serves).
const full = {
  source: 'node',
  posInit: {
    products: [{ id: 'p1' }], categories: [{ id: 'c1' }],
    comboItems: { k1: [{ product_id: 'p1' }] },
    paymentMethods: [{ code: 'glovo', name: 'Glovo' }],
    branchId: 'B1', vatRate: 16, ctlRate: 2, maxDiscountPct: 10,
    businessType: 'restaurant', receiptHeader: 'Kudo', receiptFooter: 'Karibu',
    kitchenExclusions: ['c9'], continuousOperation: true,
  },
  variantGroups: [{ id: 'vg1' }], variantOptions: [{ id: 'vo1' }],
  modifierGroups: [{ id: 'mg1' }], modifierOptions: [{ id: 'mo1' }],
  stockLevels: [{ product_id: 'p1' }],
  users: [{ id: 'u1', roles: { name: 'cashier' } }],
  tables: [{ id: 't1' }], pumps: [{ id: 'pu1' }],
  stations: [{ id: 's1', category_ids: ['c1'] }],
};

const r = unpackNodeBundle(full);
ok('full bundle: products/categories carried', r.products.length === 1 && r.categories.length === 1);
ok('full bundle: tablesFetched true, table carried', r.tablesFetched === true && r.diningTables.length === 1);
ok('full bundle: pumpsFetched true', r.pumpsFetched === true && r.pumps.length === 1);
ok('full bundle: stations non-null', Array.isArray(r.stations) && r.stations.length === 1);
ok('full bundle: paymentMethods non-null', Array.isArray(r.paymentMethods) && r.paymentMethods.length === 1);
ok('full bundle: comboItems record carried', r.comboItems.k1 && r.comboItems.k1.length === 1);
ok('full bundle: config vat coerced', r.config.vatRate === 16 && r.config.continuousOperation === true);

// ── The don't-wipe guards: a PARTIAL bundle (old-build node) omits arrays ──
const partial = { source: 'node', posInit: { products: [{ id: 'p1' }], categories: [] } };
const rp = unpackNodeBundle(partial);
ok('missing tables → tablesFetched FALSE (peer keeps its table map)', rp.tablesFetched === false && rp.diningTables.length === 0);
ok('missing pumps → pumpsFetched FALSE', rp.pumpsFetched === false);
ok('missing stations → stations NULL (routing not wiped)', rp.stations === null);
ok('missing paymentMethods → NULL (tenders not wiped)', rp.paymentMethods === null);
ok('missing variantGroups → [] (safe empty)', Array.isArray(rp.variantGroups) && rp.variantGroups.length === 0);
ok('still carries what IS present (products)', rp.products.length === 1);

// ── Config coercion: junk must not overwrite a good value ──
const junkCfg = unpackNodeBundle({ posInit: { vatRate: 'not-a-number', maxDiscountPct: '', kitchenExclusions: 'oops', businessType: '' } });
ok('junk vatRate → null (leaves last-known-good)', junkCfg.config.vatRate === null);
ok('empty maxDiscountPct → null', junkCfg.config.maxDiscountPct === null);
ok('string vatRate that IS numeric → coerced', unpackNodeBundle({ posInit: { vatRate: '16' } }).config.vatRate === 16);
ok('non-array kitchenExclusions → null (not distributed)', junkCfg.config.kitchenExclusions === null);
ok('empty businessType → null (guarded like the cloud path)', junkCfg.config.businessType === null);

// ── comboItems must be an object, never an array/garbage ──
ok('array comboItems → {} (never iterated as a record of carts)',
   Object.keys(unpackNodeBundle({ posInit: { comboItems: [1, 2] } }).comboItems).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
