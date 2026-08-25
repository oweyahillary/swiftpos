/**
 * node-reference-bundle.test.mjs — proves the A24 reference-snapshot reshape
 * (referenceBundle.mapReferenceBundle): the node turns its LOCAL rows into the
 * CLOUD shapes pullCatalogue consumes, so a peer fed by the node writes its
 * catalogue identically to one fed by the cloud.
 *
 * Drives the REAL compiled dist/main/referenceBundle.js — mapReferenceBundle is
 * pure (no SQLite, no Electron), so it runs on plain Node. This does NOT prove
 * the SQL reads in buildReferenceBundle or the HTTP wiring — those are
 * target-only (rule 16).
 *
 * The asserts target the mappings that corrupt a catalogue SILENTLY if wrong:
 *   - products.is_kitchen is a TRI-STATE (null|0|1). The writer only stores it
 *     when typeof === 'boolean', so a number read straight back becomes null on
 *     every product. Must map 0->false, 1->true, null->null.
 *   - users local role_name -> cloud roles:{name}; the writer reads roles?.name.
 *   - print_stations + category_stations link table -> station.category_ids[].
 *   - flat combo_items -> Record<combo_id, component[]>.
 *
 *   Run:  npx tsc -b tsconfig.main.json --force   (in apps/desktop)
 *         node tests/node-reference-bundle.test.mjs
 */
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main', 'referenceBundle.js');
if (!fs.existsSync(dist)) {
  console.error('dist/main/referenceBundle.js not built. In apps/desktop run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}
const { mapReferenceBundle } = await import(pathToFileURL(dist).href);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// A representative local row set — the shapes SQLite hands back (INTEGER 0/1/null
// for booleans, role_name flat, stations split across two tables).
const rows = {
  products: [
    // is_kitchen present-true, present-false, and NULL (the tri-state that breaks)
    { id: 'p1', category_id: 'c1', name: 'Wings', description: null, base_price: 500, branch_price: 550,
      image_url: null, has_variants: 1, has_modifiers: 0, track_stock: 1, status: 'active',
      barcode: null, plu: null, is_fuel: 0, is_kitchen: 1 },
    { id: 'p2', category_id: 'c1', name: 'Soda', description: null, base_price: 100, branch_price: null,
      image_url: null, has_variants: 0, has_modifiers: 0, track_stock: 1, status: 'active',
      barcode: null, plu: null, is_fuel: 0, is_kitchen: 0 },
    { id: 'p3', category_id: 'c2', name: 'Diesel', description: null, base_price: 0, branch_price: null,
      image_url: null, has_variants: 0, has_modifiers: 0, track_stock: 0, status: 'active',
      barcode: null, plu: null, is_fuel: 1, is_kitchen: null },
  ],
  categories: [{ id: 'c1', name: 'Food', color: '#f00', icon: null, sort_order: 0, status: 'active', is_kitchen: 1 }],
  comboItems: [
    { combo_id: 'k1', product_id: 'p1', name: 'Wings', quantity: 2, sort_order: 0, is_kitchen: 1 },
    { combo_id: 'k1', product_id: 'p2', name: 'Soda', quantity: 1, sort_order: 1, is_kitchen: 0 },
  ],
  paymentMethods: [{ code: 'glovo', name: 'Glovo', sort_order: 0 }],
  printStations: [{ id: 's1', name: 'Kitchen', kind: 'kitchen', sort_order: 0, active: 1 }],
  categoryStations: [{ category_id: 'c1', station_id: 's1' }],
  variantGroups: [{ id: 'vg1', product_id: 'p1', name: 'Size', required: 1, sort_order: 0 }],
  variantOptions: [{ id: 'vo1', variant_group_id: 'vg1', name: 'Large', price_adjustment: 50, sort_order: 0 }],
  modifierGroups: [{ id: 'mg1', product_id: 'p1', name: 'Sauce', min_select: 0, max_select: 2, sort_order: 0 }],
  modifierOptions: [{ id: 'mo1', modifier_group_id: 'mg1', name: 'BBQ', price: 0, sort_order: 0 }],
  stockLevels: [{ product_id: 'p1', branch_id: 'B1', quantity: 40, low_stock_threshold: 5 }],
  users: [
    { id: 'u1', name: 'Amina', role_name: 'cashier', status: 'active' },
    { id: 'u2', name: 'Ben', role_name: null, status: 'active' },
  ],
  tables: [{ id: 't1', name: 'T1', capacity: 4, sort_order: 0, slot_type: 'dining', pos_x: null, pos_y: null, zone: null, shape: null }],
  pumps: [{ id: 'pu1', branch_id: 'B1', fuel_product_id: 'p3', name: 'Pump 1', status: 'idle', sort_order: 0 }],
  config: {
    branchId: 'B1', vatRate: 16, ctlRate: 2, maxDiscountPct: 10, businessType: 'restaurant',
    receiptHeader: 'Kudo', receiptFooter: 'Karibu', kitchenExclusions: ['c9'], continuousOperation: true,
  },
};

const b = mapReferenceBundle(rows);
const prodById = Object.fromEntries(b.posInit.products.map(p => [p.id, p]));

// ── The tri-state, the whole reason this test exists ──
ok('is_kitchen 1 -> boolean true (survives the writer typeof guard)', prodById.p1.is_kitchen === true);
ok('is_kitchen 0 -> boolean false', prodById.p2.is_kitchen === false);
ok('is_kitchen null -> null (NOT false, NOT 0)', prodById.p3.is_kitchen === null);
ok('is_kitchen is never a number after mapping',
   b.posInit.products.every(p => typeof p.is_kitchen === 'boolean' || p.is_kitchen === null));

// ── Other boolean INTEGER -> boolean ──
ok('has_variants 1 -> true', prodById.p1.has_variants === true);
ok('has_modifiers 0 -> false', prodById.p1.has_modifiers === false);
ok('is_fuel 1 -> true', prodById.p3.is_fuel === true);
ok('branch_price null preserved', prodById.p2.branch_price === null);
ok('branch_price value preserved', prodById.p1.branch_price === 550);

// ── users: role_name -> roles:{name} (writer reads roles?.name) ──
const uById = Object.fromEntries(b.users.map(u => [u.id, u]));
ok('role_name -> roles.name', uById.u1.roles && uById.u1.roles.name === 'cashier');
ok('null role_name -> roles null (not {name:null})', uById.u2.roles === null);

// ── stations: two tables -> category_ids[] ──
const st = b.stations[0];
ok('station carries its linked category_ids', Array.isArray(st.category_ids) && st.category_ids[0] === 'c1');
ok('station active INTEGER -> boolean', st.active === true);

// ── combos: flat rows -> record keyed by combo_id ──
ok('combo_items -> Record<combo_id, component[]>', Array.isArray(b.posInit.comboItems.k1) && b.posInit.comboItems.k1.length === 2);
ok('combo component is_kitchen -> boolean', b.posInit.comboItems.k1[0].is_kitchen === true);

// ── config passthrough (the fields the writer reads off pos/init) ──
ok('vatRate passthrough', b.posInit.vatRate === 16);
ok('kitchenExclusions passthrough', Array.isArray(b.posInit.kitchenExclusions) && b.posInit.kitchenExclusions[0] === 'c9');
ok('continuousOperation passthrough', b.posInit.continuousOperation === true);
ok('paymentMethods reduced to {code,name}', b.posInit.paymentMethods[0].code === 'glovo' && !('sort_order' in b.posInit.paymentMethods[0]));

// ── the flat pieces are carried through for the peer's separate writers ──
ok('variantGroups carried', b.variantGroups[0].id === 'vg1');
ok('modifierOptions carried', b.modifierOptions[0].id === 'mo1');
ok('stockLevels carried', b.stockLevels[0].product_id === 'p1');
ok('tables carried', b.tables[0].id === 't1');
ok('pumps carried', b.pumps[0].id === 'pu1');
ok('bundle is tagged source:node', b.source === 'node');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
