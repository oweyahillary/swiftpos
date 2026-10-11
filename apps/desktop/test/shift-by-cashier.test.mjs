// A442 — two cashiers selling on one shift: the shift's figures stay the drawer's, and the report says who sold what.
// Owner, 2026-10-11: "on the current shift report if two cashiers sell using the same shift we don't get the correct
// metrics, confirm the math clearly; add each cashier's section on the report: 1. total sales as it's doing right now,
// 2. sales breakdown per cashier".
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/shift-by-cashier.test.mjs
//
// Drives the REAL compiled dist/main (syncEngine.createLocalOrder, shiftService.computeZReport / blindReport) on a REAL
// SQLite file: Amy opens the shift (float 1,000) and sells; she signs out and Brian signs in on the same till and sells
// on her shift. Then RUNS the cloud's rule (server lib/shiftZReport.ts shiftByCashier) on the same sales — the same
// answer — and pins the screens and the paper.
//
// MUTATIONS TO CONFIRM BITE: a sale stamped with the shift's cashier → "Brian's sales are Brian's" fails; the per-person
// sales without refunds taken off → "each column adds up to the shift's" fails; the blind report keeping the method
// figures → "a blind close shows no method figure" fails; the cloud counting a failed payment → "the cloud agrees" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SBC_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SBC_TS: '1' } });
  process.exit(r.status ?? 1);
}
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a442-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const Z = await import(pathToFileURL(path.join(here, '..', '..', 'server', 'src', 'lib', 'shiftZReport.ts')).href);

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'B', '2026-10-11T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy'), ('u-brian', 'Brian')`).run();
const signIn = (id, name) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, 'cashier', '{}', 'br-1', 'tok', '2026-10-11T06:00:00Z')`).run(id, name);
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p', 'Item', 100, 'active')`).run();
const sale = (n, total, payments) => E.createLocalOrder({
  branch_id: 'br-1', order_number: n, order_type: 'takeaway', subtotal: total, vat_amount: 0, total,
  items: [{ product: { id: 'p', name: 'Item' }, unitPrice: total, quantity: 1, lineTotal: total }], payments,
});

signIn('u-amy', 'Amy');
const shift = S.openShift(1000);
sale('A1', 1000, [{ method: 'cash', amount: 1000 }]);
sale('A2', 500, [{ method: 'mpesa', amount: 500 }]);
signIn('u-brian', 'Brian');   // Amy signs out, Brian signs in on the same till — no new shift
sale('B1', 2000, [{ method: 'cash', amount: 2000 }]);
sale('B2', 700, [{ method: 'card', amount: 700 }]);
sale('B3', 500, [{ method: 'cash', amount: 300 }, { method: 'mpesa', amount: 200 }]);
// Brian refunds 200 of B1 in cash (the money leaves the drawer as a negative payment row — the till's refund rule).
db.prepare(`UPDATE orders SET refunded_amount = 200 WHERE order_number = 'B1'`).run();
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, status, created_at)
  SELECT 'r-B1', id, 'cash', -200, 0, 'refunded', created_at FROM orders WHERE order_number = 'B1'`).run();

console.log('\nWhere the sales land\n');
const rows = db.prepare(`SELECT order_number, cashier_id, shift_id FROM orders ORDER BY order_number`).all();
ok('every sale is on the one open shift (the till\'s drawer)', rows.every((r) => r.shift_id === shift.id), JSON.stringify(rows));
ok("Brian's sales are Brian's (who was signed in), Amy's are Amy's",
  rows.filter((r) => r.order_number.startsWith('A')).every((r) => r.cashier_id === 'u-amy')
  && rows.filter((r) => r.order_number.startsWith('B')).every((r) => r.cashier_id === 'u-brian'), JSON.stringify(rows));

console.log('\nThe shift — the drawer\'s figures, as before\n');
const z = S.computeZReport(shift.id);
ok('gross 4,700 = 1,000 + 500 + 2,000 + 700 + 500; refunds 200; net 4,500', near(z.totals.grossSales, 4700) && near(z.totals.refunds, 200) && near(z.totals.netSales, 4500), JSON.stringify(z.totals));
ok('cash 3,100 = 1,000 + 2,000 + 300 − 200 refunded; expected cash 4,100 = float 1,000 + 3,100', near(z.totals.cashSales, 3100) && near(z.totals.expectedCash, 4100), JSON.stringify(z.totals));
const zm = Object.fromEntries(z.byMethod.map((m) => [m.method, m.amount]));
ok('M-Pesa 700 = 500 + 200; card 700', near(zm.mpesa, 700) && near(zm.card, 700), JSON.stringify(z.byMethod));
ok('the shift is still the one Amy opened', z.shift.cashier_name === 'Amy');

console.log('\nWho sold what\n');
const by = Object.fromEntries((z.byCashier ?? []).map((c) => [c.name, c]));
ok('Brian: 3 orders, sales 3,000 (3,200 − 200 refunded); cash 2,100, card 700, M-Pesa 200',
  by.Brian?.orders === 3 && near(by.Brian.sales, 3000)
  && JSON.stringify(by.Brian.byMethod) === JSON.stringify([{ method: 'cash', amount: 2100 }, { method: 'card', amount: 700 }, { method: 'mpesa', amount: 200 }]), JSON.stringify(by.Brian));
ok('Amy: 2 orders, sales 1,500; cash 1,000, M-Pesa 500',
  by.Amy?.orders === 2 && near(by.Amy.sales, 1500)
  && JSON.stringify(by.Amy.byMethod) === JSON.stringify([{ method: 'cash', amount: 1000 }, { method: 'mpesa', amount: 500 }]), JSON.stringify(by.Amy));
ok('biggest seller first', z.byCashier[0].name === 'Brian');
const sum = (f) => z.byCashier.reduce((t, c) => t + f(c), 0);
const sumM = (m) => sum((c) => c.byMethod.find((x) => x.method === m)?.amount ?? 0);
ok('each column adds up to the shift\'s: orders 5, sales 4,500, cash 3,100, M-Pesa 700, card 700',
  sum((c) => c.orders) === z.totals.orderCount && near(sum((c) => c.sales), z.totals.netSales)
  && near(sumM('cash'), z.totals.cashSales) && near(sumM('mpesa'), zm.mpesa) && near(sumM('card'), zm.card));

console.log('\nA blind close (A416)\n');
const on = S.blindReport(z, true), off = S.blindReport(z, false);
ok('switch on: the shift\'s sales and each person\'s part — labelled as the shift\'s, not "yours"',
  near(on.cashierSales.total, 4500) && JSON.stringify(on.cashierSales.byCashier) === JSON.stringify([{ name: 'Brian', orders: 3, sales: 3000 }, { name: 'Amy', orders: 2, sales: 1500 }]),
  JSON.stringify(on.cashierSales));
ok('a blind close shows no method figure per person', on.byCashier.every((c) => c.byMethod.length === 0));
ok('switch off: nothing per person at all', off.byCashier.length === 0 && off.cashierSales === undefined);

console.log('\nThe cloud agrees\n');
const cloud = Z.shiftByCashier([
  { cashier_id: 'u-amy', net: 1000, payments: [{ method: 'cash', amount: 1000, status: 'completed' }] },
  { cashier_id: 'u-amy', net: 500, payments: [{ method: 'mpesa', amount: 500, status: 'completed' }] },
  { cashier_id: 'u-brian', net: 1800, payments: [{ method: 'cash', amount: 2000, status: 'completed' }, { method: 'cash', amount: -200, status: 'refunded' }] },
  { cashier_id: 'u-brian', net: 700, payments: [{ method: 'card', amount: 700, status: 'completed' }, { method: 'card', amount: 700, status: 'failed' }] },
  { cashier_id: 'u-brian', net: 500, payments: [{ method: 'cash', amount: 300, status: 'completed' }, { method: 'mpesa', amount: 200, status: 'completed' }] },
], new Map([['u-amy', 'Amy'], ['u-brian', 'Brian']]));
ok('the same people, orders, sales and methods as the till (a failed payment not counted)',
  JSON.stringify(cloud.map((c) => [c.name, c.orders, c.sales, c.byMethod])) === JSON.stringify(z.byCashier.map((c) => [c.name, c.orders, c.sales, c.byMethod])),
  JSON.stringify(cloud));
ok('a sale that recorded no one: "Not recorded"', Z.shiftByCashier([{ cashier_id: null, net: 10, payments: [] }], new Map())[0].name === 'Not recorded');

console.log('\nThe screens and the paper\n');
const panel = read('src/renderer/pages/ShiftPanel.tsx');
ok('the shift panel: "Opened by" with more than one seller, then SALES BY CASHIER with each person\'s methods',
  panel.includes("<Line l={people.length > 1 ? 'Opened by' : 'Cashier'} v={shift.cashier_name} />") && panel.includes('data-testid="zreport-by-cashier"'));
ok('a blind close says "Sales this shift" (the shift\'s, not "yours") and lists each person',
  panel.includes('Sales this shift: <span') && !panel.includes('Your sales this shift') && panel.includes('data-testid="cashier-sales-by-person"'));
ok('the Z-report sheet (closed shift, manager, remote) has SALES BY CASHIER', read('src/renderer/components/ZReportView.tsx').includes('SALES BY CASHIER'));
ok('the printed Z-report carries it to the printer', read('src/renderer/lib/printShiftReport.ts').includes('byCashier: (report.byCashier ?? []).map(c => ({')
  && fs.readFileSync(path.join(here, '..', '..', '..', 'shared', 'printing', 'src', 'shiftReport.ts'), 'utf8').includes("d.line('SALES BY CASHIER', { bold: true });"));
const web = fs.readFileSync(path.join(here, '..', '..', 'dashboard', 'src', 'pages', 'pos', 'ShiftModal.tsx'), 'utf8');
ok('the web POS close lists each person too', web.includes('data-testid="sales-by-cashier"') && !web.includes('Your sales this shift'));

try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* the database is still open on Windows */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
