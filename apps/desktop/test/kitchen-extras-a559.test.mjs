// A559 — a TILL sale's extras and notes on the kitchen ticket, through the till's real print path.
//
// Owner, 2026-10-22, after testing 1.0.20: "yes let it print in the kitchen receipt too, and notes also since some can
// only be done by the chef".
//
// Drives the REAL compiled dist/main: ipc/shared.ts's queueThermal (what order:create and escpos:printProduction call)
// → escposBridge.printSale → shared/printing's toUnits + render, on a REAL SQLite file (print stations and the category
// routing in it), electron shimmed. Only the spool is stood in for: printWorker.queueTickets is replaced by one that
// keeps what it is handed, and the test renders those tickets with the stations queueThermal built. The sale is shaped
// as POSPage sends it: VariantModal's extras ({ groupName, optionName, price }), each line's `notes`, the order's `notes`.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/kitchen-extras-a559.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen red, reverted): toUnits routing a modifier to ids.dispatch only (the pre-A559
// rule) → "the extra under its dish" fails; queueThermal dropping the order's note (note: null) → "the order's note"
// fails; printSale dropping the line note (note: undefined) → "the line's note" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a559-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const PW = require(path.join(dist, 'print', 'printWorker.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const { createIpcShared } = require(path.join(dist, 'ipc', 'shared.js'));
const P = require('@swiftpos/printing');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-22T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
B.setEscposEnabled(true);
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active) VALUES ('st-k', 'Kitchen', 'kitchen', 1, 1), ('st-d', 'Dispatch', 'dispatch', 2, 1)`).run();
db.prepare(`INSERT INTO category_stations (category_id, station_id) VALUES ('c-food', 'st-k')`).run();

// The spool stood in for: the tickets printSale queues, kept. A printer bound to each station on this till.
const queued = [];
PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.map((s) => s.id), skipped: [], failed: [] }; };
PW.assignments = () => [{ stationId: 'st-k', target: 'tcp://10.0.0.5:9100', paperWidthMm: 80 }, { stationId: 'st-d', target: 'tcp://10.0.0.6:9100', paperWidthMm: 80 }];
const { queueThermal } = createIpcShared(() => {});

// POSPage's escpos:printProduction payload (pages/POSPage.tsx): a till's cart line as the till builds it.
const product = (id, name, category_id = 'c-food') => ({ id, name, category_id, categories: null, description: null });
const payload = {
  order_number: 'T1-2001', order_type: 'takeaway', cashier_name: 'Cate',
  items: [
    { product: product('p-wings', 'Wings'), unitPrice: 650, quantity: 1, lineTotal: 650, selectedVariants: [],
      selectedModifiers: [{ groupId: 'g-x', groupName: 'Extras', optionId: 'o-cheese', optionName: 'Extra Cheese', price: 50 }],
      notes: 'Well done\nNo salt' },
    { product: product('p-burger', 'Chicken Burger'), unitPrice: 450, quantity: 2, lineTotal: 900,
      selectedVariants: [{ groupId: 'g-s', groupName: 'Spice', optionId: 'o-spicy', optionName: 'Spicy', priceAdjustment: 0 }], selectedModifiers: [], notes: null },
    { product: product('p-soda', 'Soda 500ml', 'c-drinks'), unitPrice: 120, quantity: 1, lineTotal: 120, selectedVariants: [],
      selectedModifiers: [{ groupId: 'g-i', groupName: 'Ice', optionId: 'o-ice', optionName: 'Ice', price: 0 }], notes: 'Cold one' },
  ],
  notes: 'Allergy: nuts — chef please check',
};

console.log('\nA559 — a till sale\'s extras and notes on the kitchen ticket (the till\'s real print path)\n');
const r = queueThermal(payload, ['kitchen', 'dispatch']);
ok('queueThermal → printSale queued the tickets (nothing failed)', queued.length === 1 && r.failed.length === 0, JSON.stringify(r));
const [{ contexts: [ctx], stations }] = queued;
const render = (kind) => {
  const station = stations.find((s) => s.kind === kind);
  return P.hasPrintableContent({ ...ctx, station }) ? P.toPreview(P.renderTicket({ ...ctx, station })) : '';
};
const K = render('kitchen');
const D = render('dispatch');
console.log(K);
const rows = (t) => t.split('\n').map((x) => x.replace(/\s+$/, ''));
const k = rows(K);
const at = k.indexOf('1   WINGS');
ok('the kitchen ticket has the dish', at >= 0, K);
ok('the extra under its dish: "+ Extra Cheese" (the till\'s { optionName })', k[at + 1] === '      + Extra Cheese', K);
ok('the line\'s note under it, one row per typed line', k[at + 2] === '      ** Well done' && k[at + 3] === '      ** No salt', K);
ok('the order\'s note, before the first dish', k.indexOf('NOTE: Allergy: nuts - chef please check') >= 0 && k.indexOf('NOTE: Allergy: nuts - chef please check') < at, K);
ok('a variant still on the dish\'s own row', k.includes('2   CHICKEN BURGER - SPICY'), K);
ok('the extras do not count as dishes: 2 items to cook (Wings, the burgers)', k.some((x) => x.trim() === '2 items to cook'), K);
ok('a soda (and its ice and its note) stays off the kitchen ticket', !/SODA|Ice|Cold one/.test(K), K);
ok('the packer still sees every extra and the soda\'s note', D.includes('+ Extra Cheese') && D.includes('+ Ice') && D.includes('** Cold one') && D.includes('NOTE: Allergy'), D);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
