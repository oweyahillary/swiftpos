// POST /node/print — a Shop POS tablet prints through its branch server (Till stage 1, docs/ANDROID-APP-DESIGN.md §11).
//
// Owner, 2026-11-05: the branch server is there "so that printing can be easier". A tablet that joined this server sends
// the whole ticket and the server prints it with ITS stations, printer assignments and spool — the desktop's own path.
//
// Drives the REAL compiled dist/main: nodePrintRelay.relayPrint → ipc/shared.ts's queueThermal → escposBridge.printSale →
// shared/printing's render, on a REAL SQLite file, electron shimmed; only the spool is stood in for (printWorker.queueTickets
// keeps what it is handed). The tickets' ESC/POS bytes are compared, not only their text.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/node-print-relay.test.mjs
//
//   J  the jobs: receipt → the receipt station only; kitchen → kitchen + dispatch, never the receipt; proforma → "BILL - NOT A
//      RECEIPT", no number, no payments, and refused without the online licence; void → the VOID banner, and only with the void
//   W  the answer in words: a station with no printer here is named; printing off on the server says so; a bad request
//      queues nothing
//   D  the desktop's own sales are byte-for-byte unchanged: a tablet's receipt is the very ticket the desktop's own sale screen
//      prints for the same order (escpos:printProduction / queueThermal, untouched), and the server's route is behind the
//      branch access code and a proven device key, like /node/verify-pin
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - kindsOf('kitchen') → ['kitchen', 'dispatch', 'receipt']                   → J "never the receipt"
//   - relayPrint without the requireOnlineLicence() check for proforma           → J "refused without the online licence"
//   - orderFor('proforma') keeping payments                                       → J "no payments"
//   - relayProblem() returning null                                               → W "the station with no printer is named"
//   - /node/print answered before the device-key check (no proven(who.verdict))   → D "behind a proven device key"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-relay-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.24' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false }, shell: {} };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const PW = require(path.join(dist, 'print', 'printWorker.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const R = require(path.join(dist, 'nodePrintRelay.js'));
const { createIpcShared } = require(path.join(dist, 'ipc', 'shared.js'));
const { registerSaleHandlers } = require(path.join(dist, 'ipc', 'sale.js'));
const P = require('@swiftpos/printing');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 1500)}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', 'KES', '2026-11-05T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-SRV', device_role: 'node', terminal_code: 'S1', device_name: 'Branch server' });
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active) VALUES ('st-k', 'Kitchen', 'kitchen', 1, 1), ('st-d', 'Dispatch', 'dispatch', 2, 1), ('st-r', 'POS', 'receipt', 3, 1)`).run();
db.prepare(`INSERT INTO category_stations (category_id, station_id) VALUES ('c-food', 'st-k')`).run();

const queued = [];
PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.map((s) => s.id), skipped: [], failed: [] }; };
let assigned = [{ stationId: 'st-k', target: 'tcp://10.0.0.5:9100', paperWidthMm: 80 }, { stationId: 'st-d', target: 'usb://EPSON', paperWidthMm: 80 },
  { stationId: 'st-r', target: 'tcp://10.0.0.7:9100', paperWidthMm: 80 }];
PW.assignments = () => assigned;
const handlers = {};
const ctx = createIpcShared((channel, fn) => { handlers[channel] = fn; });
registerSaleHandlers(ctx);
const licence = (on) => db.prepare(`UPDATE device_config SET web_pos_enabled = ? WHERE id = 1`).run(on ? 1 : 0);
const deps = { queueThermal: ctx.queueThermal, escposEnabled: B.escposEnabled, requireOnlineLicence: ctx.requireOnlineLicence };
B.setEscposEnabled(true);
licence(true);

// What a tablet sends: the web POS's order, as the dashboard's shopPos.serverPrintOrder builds it.
const product = (id, name, category_id = 'c-food') => ({ id, name, category_id, description: null });
const items = [
  { product: product('p-wings', 'Wings'), unitPrice: 650, quantity: 2, lineTotal: 1300, selectedVariants: [], selectedModifiers: [], notes: 'no salt', course: null, measureUnit: null },
  { product: product('p-soda', 'Soda 500ml', 'c-drinks'), unitPrice: 120, quantity: 1, lineTotal: 120, selectedVariants: [], selectedModifiers: [], notes: null, course: null, measureUnit: null },
];
const order = { order_number: 'A1-0042', order_type: 'dine_in', cashier_name: 'Wanjiru', table_number: '4', notes: null, items,
  payments: [{ method: 'cash', amount: 1500 }], change_given: 80, total: 1420, discount_amount: 0, tip_amount: 0, delivery_fee: 0, delivery_free: false };
const AT = new Date('2026-11-05T12:00:00Z');
const render = (entry, kind) => {
  const station = entry.stations.find((s) => s.kind === kind);
  return station ? P.renderTicket({ ...entry.contexts[0], soldAt: AT, station }) : null;
};
const text = (entry, kind) => { const t = render(entry, kind); return t ? P.toPreview(t) : ''; };
const relay = (body) => { queued.length = 0; return R.relayPrint(body, deps); };

console.log('\nJ. the jobs\n');
{
  const r = relay({ job: 'receipt', order });
  ok('receipt: printed, nothing to report', r.status === 200 && r.body.ok === true && r.body.problem === null, JSON.stringify(r));
  ok('receipt: the receipt station only', queued.length === 1 && queued[0].stations.every((s) => s.kind === 'receipt'), JSON.stringify(queued[0]?.stations));
  const t = text(queued[0], 'receipt');
  ok('receipt: the bill number, the cashier, the lines and the payment', t.includes('Bill No.: A1-0042') && /Wanjiru/.test(t) && /Wings/.test(t) && /CASH/.test(t), t);
}
{
  const r = relay({ job: 'kitchen', order: { ...order, kitchen_void: { by: 'x', reason: 'y' } } });
  const kinds = queued[0]?.stations.map((s) => s.kind) ?? [];
  ok('kitchen: kitchen and dispatch, never the receipt', r.status === 200 && kinds.includes('kitchen') && kinds.includes('dispatch') && !kinds.includes('receipt'), JSON.stringify(kinds));
  ok('kitchen: routed by the SERVER\'s stations (the food on the kitchen, the line note with it)', /WINGS/i.test(text(queued[0], 'kitchen')) && /no salt/i.test(text(queued[0], 'kitchen')) && !/SODA/i.test(text(queued[0], 'kitchen')), text(queued[0], 'kitchen'));
  ok('kitchen: a void sent with a fire is not printed as a VOID', !/V ?O ?I ?D/.test(text(queued[0], 'kitchen')), text(queued[0], 'kitchen'));
}
{
  licence(false);
  const refused = relay({ job: 'proforma', order });
  ok('proforma: refused without the online licence, nothing queued', refused.status === 403 && /online licence/.test(refused.body.problem) && queued.length === 0, JSON.stringify(refused));
  licence(true);
  const r = relay({ job: 'proforma', order });
  const t = text(queued[0], 'receipt');
  ok('proforma: "BILL - NOT A RECEIPT" on the receipt station only', r.status === 200 && t.includes('BILL - NOT A RECEIPT') && queued[0].stations.every((s) => s.kind === 'receipt'), t);
  ok('proforma: no bill number', !/Bill No\./.test(t), t);
  ok('proforma: no payments', !/\bCASH\b|\bCHANGE\b/.test(t), t);
}
{
  const missing = relay({ job: 'void', order });
  ok('void: refused without the void itself', missing.status === 400 && queued.length === 0, JSON.stringify(missing));
  const r = relay({ job: 'void', order: { ...order, items: [items[0]], kitchen_void: { by: 'Mgr Otieno', reason: 'Customer changed mind' } } });
  ok('void: the VOID banner on the kitchen ticket', r.status === 200 && /V ?O ?I ?D/.test(text(queued[0], 'kitchen')), text(queued[0], 'kitchen'));
}

console.log('\nW. the answer, in words\n');
{
  for (const [name, body] of [['an unknown job', { job: 'drawer', order }], ['no order', { job: 'receipt' }], ['no lines', { job: 'receipt', order: { ...order, items: [] } }],
    ['too many lines', { job: 'receipt', order: { ...order, items: Array.from({ length: R.MAX_RELAY_LINES + 1 }, () => items[1]) } }], ['not an object', 'x']]) {
    const r = relay(body);
    ok(`${name}: 400, nothing queued`, r.status === 400 && queued.length === 0 && !!r.body.problem, JSON.stringify(r));
  }
  assigned = assigned.filter((a) => a.stationId !== 'st-d');   // the dispatch station has no printer on the server
  PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.filter((s) => s.id !== 'st-d').map((s) => s.id), skipped: ['Dispatch'], failed: [] }; };
  const r = relay({ job: 'kitchen', order });
  ok('the station with no printer is named, and the sale is said to be saved', r.status === 200 && r.body.ok === false && /Dispatch/.test(r.body.problem ?? '') && /sale is saved/.test(r.body.problem ?? ''), JSON.stringify(r));
  PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.map((s) => s.id), skipped: [], failed: [] }; };
  assigned = [...assigned, { stationId: 'st-d', target: 'usb://EPSON', paperWidthMm: 80 }];
  B.setEscposEnabled(false);
  const off = relay({ job: 'receipt', order });
  ok('printing off on the server: said so, nothing queued', off.status === 409 && /Printing is off on the branch server/.test(off.body.problem) && queued.length === 0, JSON.stringify(off));
  B.setEscposEnabled(true);
  ok('relayProblem names skipped and failed stations', /Kitchen/.test(R.relayProblem(['Kitchen'], [])) && /Bar/.test(R.relayProblem([], ['Bar'])) && R.relayProblem([], []) === null);
}

console.log('\nD. the desktop\'s own sales are unchanged\n');
{
  // The desktop's own Send to kitchen, through its own handler, and the same order from a tablet: the same tickets.
  queued.length = 0;
  handlers['escpos:printProduction'](null, order);
  const own = queued[0];
  const viaTablet = (relay({ job: 'kitchen', order }), queued[0]);
  for (const kind of ['kitchen', 'dispatch']) {
    const a = render(own, kind), b = render(viaTablet, kind);
    ok(`the tablet's ${kind} ticket is byte-for-byte the desktop's own`, a && b && Buffer.compare(Buffer.from(P.toEscPos(a)), Buffer.from(P.toEscPos(b))) === 0);
  }
  queued.length = 0;
  ctx.queueThermal(order, ['receipt']);
  const ownReceipt = queued[0];
  const tabletReceipt = (relay({ job: 'receipt', order }), queued[0]);
  ok('the tablet\'s receipt is byte-for-byte the desktop\'s own', Buffer.compare(Buffer.from(P.toEscPos(render(ownReceipt, 'receipt'))), Buffer.from(P.toEscPos(render(tabletReceipt, 'receipt')))) === 0);
  ok('a sale\'s receipt still carries no proforma key', !('proforma' in ownReceipt.contexts[0]));

  const NS = src('main/nodeServer.ts');
  const route = NS.indexOf("url === '/node/print'");
  const authGate = NS.indexOf('if (!authorised(req))');
  const block = NS.slice(route, NS.indexOf('return json(res, out.status, out.body);', route));
  ok('the route is behind the branch access code (after the central check)', route > authGate && authGate > 0);
  ok('…and behind a proven device key, like /node/verify-pin', /const who = whoIsAsking\(req\);\s*if \(!proven\(who\.verdict\)\)/.test(block), block.slice(0, 400));
  ok('it prints only through the desktop\'s own path (relayPrint → queueThermal), registered once', /setRelayPrinter\(\{ queueThermal: ctx\.queueThermal/.test(src('main/ipcHandlers.ts')));
  ok('queueThermal itself is not touched by the relay (no relay names in ipc/shared.ts)', !/relay|nodePrint/i.test(src('main/ipc/shared.ts')));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* the SQLite file is still open on Windows */ }
process.exit(fail ? 1 : 0);
