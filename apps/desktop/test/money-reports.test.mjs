// A349 (2026-09-28) — the till's reports agree with each other and with the cloud, to the cent: refunds, VAT, CTL, tips.
// Owner, before 0.6.16: "make sure Catering levy(CTL) especially on the desktop app, does it appear on receipt? or
// reports? add it in overview … make sure everything especially money math and reporting they have to be spot on".
//
// RUNS the real compiled managerReports (Overview), shiftService (Z-report), dailySalesReport (the workbook) and
// reportExport on SQLite (electron shimmed), in Africa/Nairobi time so the hour checks mean something.
//
// A CTL business (VAT 16 %, CTL 2 %). Four sales on one shift:
//   A  1,180.00  VAT 160  CTL 20   cash 1,180 + a cash tip of 50        kept in full
//   B    590.00  VAT  80  CTL 10   fully refunded (590 back, cash)       kept 0
//   C  1,180.00  VAT 160  CTL 20   half refunded (590 back, cash)        kept ½ → VAT 80, CTL 10
//   D    500.00  voided — in nothing
//   gross 2,950 · refunds 1,180 · REVENUE 1,770 · VAT 240 · CTL 30 · tips 50 · NET OF TAX 1,500
// Before A349: revenue 2,950 (refunds ignored), VAT 400, CTL 50 — and the Daily report's net of tax 2,950−1,180−400−50
// = 1,320 instead of 1,500; with only B's full refund its tax still counted; and the Overview's hours were UTC.
//
// MUTATIONS TO CONFIRM BITE:
//   - vatKeptSql/ctlKeptSql without the kept fraction → "VAT 240 / CTL 30" fail everywhere
//   - the Overview's revenue without refunds          → "revenue 1,770" fails
//   - the Overview's hourly without 'localtime'        → "hour is the LOCAL hour" fails
//   - the Z-report without refunds/ctl                 → its checks fail
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.TZ !== 'Africa/Nairobi') {
  const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, TZ: 'Africa/Nairobi' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a349-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.6.16' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const M = require(path.join(dist, 'managerReports.js'));
const R = require(path.join(dist, 'dailySalesReport.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', 'KES', '2026-09-28T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front', vat_rate: 16, ctl_rate: 2 });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-28T05:00:00Z')`).run();

// Today, 10:15 local (07:15 UTC) — so a UTC hour and a local hour differ by 3.
const at = new Date(); at.setHours(10, 15, 0, 0);
const ts = at.toISOString();
const shift = S.openShift(1000);
const order = (id, total, vat, ctl, { status = 'completed', refunded = 0, tip = 0 } = {}) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, ctl_amount, discount_amount, tip_amount,
                total, refunded_amount, shift_id, created_at, sync_status, device_id, order_type)
              VALUES (?, 'biz-1', 'br-1', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'synced', 'dev-T1', 'takeaway')`)
    .run(id, id, status, total, vat, ctl, tip, total, refunded, shift.id, ts);
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, 'cash', ?, ?, ?)`)
    .run(`p-${id}`, id, total + tip, total + tip, ts);
  if (refunded) db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, status, created_at) VALUES (?, ?, 'cash', ?, 0, 'refunded', ?)`)
    .run(`r-${id}`, id, -refunded, ts);
};
order('A', 1180, 160, 20, { tip: 50 });
order('B', 590, 80, 10, { refunded: 590 });
order('C', 1180, 160, 20, { refunded: 590 });
order('D', 500, 67.8, 8.47, { status: 'voided' });

// ── Overview ──
const ov = M.getSalesSummary(M.resolveRange('today')).summary;
ok('Overview: revenue is what was KEPT — 2,950 − 1,180 refunded = 1,770', near(ov.totalRevenue, 1770), JSON.stringify(ov));
ok('Overview: VAT 240 and CTL 30 (reduced by the refunded share), CTL shown because it is levied',
  near(ov.totalVat, 240) && near(ov.totalCtl, 30) && ov.ctlLevied === true, JSON.stringify(ov));
ok('Overview: refunds 1,180, tips 50 (not revenue), avg order 1,770 / 3 = 590',
  near(ov.totalRefunded, 1180) && near(ov.totalTips, 50) && near(ov.avgOrderValue, 590), JSON.stringify(ov));
const hourly = M.getSalesSummary(M.resolveRange('today')).hourly;
ok('Overview: the hour is the LOCAL hour (10), not UTC (7); its revenue nets refunds (1,770)',
  hourly.length === 1 && hourly[0].hour === 10 && near(hourly[0].revenue, 1770), JSON.stringify(hourly));
const pm = M.getSalesSummary(M.resolveRange('today')).paymentMethods;
ok('Overview: cash paid = 1,180 + 50 + 590 + 1,180 − 590 − 590 = 1,820 (refunds out, tip in)', near(pm.cash, 1820), JSON.stringify(pm));

// ── Z-report ──
const z = S.computeZReport(shift.id).totals;
ok('Z-report: gross 2,950, refunds 1,180, net sales 1,770', near(z.grossSales, 2950) && near(z.refunds, 1180) && near(z.netSales, 1770), JSON.stringify(z));
ok('Z-report: VAT 240, CTL 30 (levied), tips 50', near(z.vat, 240) && near(z.ctl, 30) && z.ctlLevied === true && near(z.tips, 50), JSON.stringify(z));
ok('Z-report: expected cash unchanged in method — 1,000 float + 1,820 cash = 2,820', near(z.expectedCash, 2820), String(z.expectedCash));

// ── Daily Sales Report (the workbook) ──
const { wb } = await R.buildDailySalesWorkbook({ preset: 'today' });
const ws = wb.worksheets[0];
const find = (label) => { let hit = null; ws.eachRow((r) => { if (!hit && String(r.getCell(1).value) === label) hit = r; }); return hit; };
ok('Daily: Total Gross 1,770 (net of refunds)', near(find('Total Gross')?.getCell(2).value, 1770), String(find('Total Gross')?.getCell(2).value));
ok('Daily: Total Sale (net of tax) 1,770 − 240 − 30 = 1,500 — never below zero', near(find('Total Sale')?.getCell(2).value, 1500), String(find('Total Sale')?.getCell(2).value));
ok('Daily: CTL 2% line 30, VAT 16% line 240, Tax Total 270',
  near(find('CTL 2%')?.getCell(3).value, 30) && near(find('VAT 16%')?.getCell(3).value, 240) && near(find('Tax Total')?.getCell(3).value, 270));
let hourSum = 0; ws.eachRow((r) => { if (/^\d\d:00$/.test(String(r.getCell(1).value))) hourSum += Number(r.getCell(5).value); });
ok('Daily: the hourly lines add up to the day (1,770)', near(hourSum, 1770), String(hourSum));

// ── The Overview and the Daily report agree; so does the CSV summary ──
ok('the Overview revenue equals the Daily report\'s Total Gross', near(ov.totalRevenue, find('Total Gross')?.getCell(2).value));
const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'reportExport.ts'), 'utf8');
ok('the CSV carries CTL, refunds and tips, and a Refunded column per order', /row\(\['CTL', /.test(src) && /row\(\['Refunds', /.test(src)
  && /'Total', 'Refunded', 'Payment methods'/.test(src));

// ── The screens (source) ──
const mp = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'ManagerPage.tsx'), 'utf8');
ok('the Overview shows VAT, CTL (when levied), refunds, discounts and tips under the KPIs, on every layout',
  (mp.match(/<MoneyStrip s=/g) || []).length === 3 && /\{s\.ctlLevied && item\('CTL'/.test(mp));
const zv = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'ZReportView.tsx'), 'utf8');
ok('the Z-report screen shows refunds, net sales, VAT, CTL and tips', /row\('− Refunds'/.test(zv) && /row\('incl\. CTL'/.test(zv) && /row\('incl\. VAT'/.test(zv));
const rv = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'ReceiptView.tsx'), 'utf8');
ok('the on-screen receipt: round off never includes the tip; PAY = total + tip (+ delivery fee, 0.6.27)',
  /const roundOff = total - \(netSubtotal \+ ctlAmount \+ vatAmount\);/.test(rv) && /PAY: \{currency\} \{moneyBig\(total \+ tipAmount \+ deliveryFee\)\}/.test(rv));
// 0.6.27: the sale screen hands the receipt the BILL (it passed amountDue — bill + tip — so a tip showed as "Round
// Off" and was counted twice in PAY on the screen; the printed receipt was right).
const pp = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'POSPage.tsx'), 'utf8');
// 0.6.29 (owner): the on-screen receipt after payment became a success screen with no print button. Same money rule:
// the bill, then the tip and the delivery fee, and "Paid" = what the customer handed over (amountDue) — never the tip twice.
ok('0.6.29: the success screen shows the bill, tip and fee apart, and Paid = amountDue; no print button',
  /<Row l="Bill" v=\{fmtMoney\(p\.total\)\} \/>/.test(pp) && /<Row l="Paid" v=\{fmtMoney\(p\.amountDue\)\} strong \/>/.test(pp)
  && /p\.deliveryFee > 0 && <Row l=\{`Delivery fee/.test(pp) && !/Print receipt/.test(pp) && !/handlePrint/.test(pp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
