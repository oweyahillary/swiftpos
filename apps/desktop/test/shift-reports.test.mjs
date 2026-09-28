// 0.6.11 (2026-09-27) — previous shift reports, expenses in the shift report, and a colour-coded Daily Sales Report.
// Owner: "1. I should be able to print previous shift reports 2. I should be able to see expenses, and it should also be
// part of the shift report 3. formatting of the daily sales report can we color code maybe headers, total, important figures".
//
// Drives the REAL compiled dist/main (shiftService, dailySalesReport, localDb) on a REAL SQLite file, electron shimmed as in
// shared-drawer.test.mjs; the REAL shared/printing renderer (the bytes' text); and reads the REAL workbook back with ExcelJS.
// The React screens are pinned by source (not run here) — the live screens are a target check (rule 16).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/shift-reports.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - computeZReport drops totals.expenses                → "the reconciliation adds up on paper" fails
//   - listShifts loses its device filter                  → "only this till's shifts" fails
//   - listExpenses loses its device filter                → "only this till's expenses" fails
//   - the printed report drops the "- Expenses" line      → "the printed reconciliation shows expenses" fails
//   - 'key' rows lose their fill                          → "Total Gross is highlighted" fails
//   - a long expense description cut to one line          → "a long description is kept whole" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0611-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const R = require(path.join(dist, 'dailySalesReport.js'));
const P = require(path.join(here, '..', '..', '..', 'shared', 'printing', 'dist', 'index.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-27T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-27T08:00:00Z')`).run();
db.prepare(`INSERT INTO users (id, name) VALUES ('u-tom', 'Tom')`).run();

const now = new Date().toISOString();
const sale = (id, shiftId, amount) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'pending', 'dev-T1')`).run(id, id, amount, amount, shiftId, now);
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, 'cash', ?, ?, ?)`).run(`p-${id}`, id, amount, amount, now);
};
const expense = (id, shiftId, amount, desc, device = 'dev-T1') =>
  db.prepare(`INSERT INTO expenses (id, business_id, branch_id, description, amount, paid_by, expense_date, shift_id, created_at, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, ?, 'u-tom', ?, ?, ?, ?)`).run(id, desc, amount, now.slice(0, 10), shiftId, now, device);

console.log('0.6.11 — expenses in the shift report\n');
const s1 = S.openShift(1000);
sale('o-1', s1.id, 400);
expense('e-1', s1.id, 150, 'Gas refill');
const z = S.computeZReport(s1.id);
ok('the report carries the expenses total (150)', z.totals.expenses === 150, JSON.stringify(z.totals));
ok('the reconciliation adds up on paper: 1000 + 400 + 0 − 0 − 150 = expected 1250',
  z.shift.opening_float + z.totals.cashSales + z.totals.floatIn - z.totals.floatOut - z.totals.expenses === z.totals.expectedCash
  && z.totals.expectedCash === 1250, String(z.totals.expectedCash));
ok('…with its lines: description, amount, who paid', JSON.stringify(z.expenseLines) === JSON.stringify([{ description: 'Gas refill', amount: 150, created_at: now, paid_by_name: 'Tom' }]),
  JSON.stringify(z.expenseLines));

// The printed report — the real shared renderer, as the till's print worker calls it.
const payload = (r, withExpenses = true) => ({
  businessName: 'Your Business', currencyCode: 'KES', cashierName: r.shift.cashier_name, shiftRef: r.shift.id.slice(0, 8),
  openedAt: new Date(r.shift.opened_at), closedAt: r.shift.closed_at ? new Date(r.shift.closed_at) : null, status: r.shift.status,
  byMethod: r.byMethod.map((m) => ({ ...m, amount: Math.round(m.amount * 100) })), orderCount: r.totals.orderCount,
  grossSales: Math.round(r.totals.grossSales * 100), voidCount: r.totals.voidCount, openingFloat: Math.round(r.shift.opening_float * 100),
  cashSales: Math.round(r.totals.cashSales * 100), floatIn: 0, floatOut: 0, expectedCash: Math.round(r.shift.expected_cash * 100),
  ...(withExpenses ? { expenses: Math.round(r.totals.expenses * 100), expenseLines: r.expenseLines.map((e) => ({ description: e.description, amount: Math.round(e.amount * 100) })) } : {}),
  printedAt: new Date(),
});
const text = (doc) => doc.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n');
const paper = text(P.renderShiftReport(payload(z), 80));
ok('the printed reconciliation shows expenses: "- Expenses … 150.00" between float out and expected',
  /- Float out[^\n]*\n- Expenses\s+KES 150\.00\n= Expected cash\s+KES 1,250\.00/.test(paper), paper);
ok('…and an EXPENSES section with the line', /EXPENSES \(1\)\nGas refill\s+KES 150\.00/.test(paper));
ok('a caller that sends no expenses (the web POS today) prints exactly as before — no expense lines',
  !/Expenses|EXPENSES/.test(text(P.renderShiftReport(payload(z, false), 80))));
const long = text(P.renderShiftReport({ ...payload(z), expenseLines: [{ description: 'Emergency plumber for the kitchen sink leak', amount: 250000 }] }, 58));
ok('a long description is kept whole on 58 mm (wrapped, the amount beneath it — never cut off)',
  /Emergency plumber for the\nkitchen sink leak\n\s+KES 2,500\.00/.test(long), long);

// Close it, open the next — the previous shift's report is still there to open and print.
S.closeShift(1250, undefined, null);
const s2 = S.openShift(500);
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, device_id)
            VALUES ('sh-T2', 'biz-1', 'br-1', 'u-sam', '2026-09-27T12:00:00Z', 'closed', 0, '2026-09-27T12:00:00Z', 'dev-T2')`).run();
expense('e-T2', 'sh-T2', 999, 'Another till', 'dev-T2');

console.log('\n0.6.11 — previous shift reports');
const list = S.listShifts(60);
ok('only this till\'s shifts, newest first (open, then the closed one)', JSON.stringify(list.map((x) => x.id)) === JSON.stringify([s2.id, s1.id]), JSON.stringify(list.map((x) => x.id)));
ok('…each with its cashier, times and outcome', list[1].cashier_name === 'Tom' && list[1].status === 'closed' && !!list[1].closed_at
  && list[1].expected_cash === 1250 && list[1].cash_variance === 0, JSON.stringify(list[1]));
const old = S.computeZReport(s1.id);
ok('a previous shift reopens as its Z-report: closed, expected 1250, variance 0, expense lines intact',
  old.shift.status === 'closed' && old.shift.expected_cash === 1250 && old.shift.cash_variance === 0 && old.expenseLines.length === 1);

console.log('\n0.6.11 — the Expenses screen');
const ex = S.listExpenses('2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
ok('only this till\'s expenses, with who paid, and the total', ex.rows.length === 1 && ex.rows[0].paid_by_name === 'Tom' && ex.total === 150, JSON.stringify(ex));
ok('the date range applies', S.listExpenses('2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z').rows.length === 0);

console.log('\n0.6.11 — the Daily Sales Report, colour-coded');
const { wb } = await R.buildDailySalesWorkbook({ preset: 'today' });
const ws = wb.worksheets[0];
const find = (label) => { let hit = null; ws.eachRow((r) => { if (!hit && r.getCell(1).value === label) hit = r; }); return hit; };
const fillOf = (r, col = 1) => r?.getCell(col).fill?.fgColor?.argb ?? null;
const fontOf = (r, col = 1) => r?.getCell(col).font?.color?.argb ?? null;
const gross = find('Total Gross');
ok('the figures are unchanged: Total Gross 400 (the day\'s one sale)', gross?.getCell(2).value === 400, String(gross?.getCell(2).value));
ok('Total Gross is highlighted (key figure: pale amber, across the row)', fillOf(gross) === 'FFFEF3C7' && fillOf(gross, 5) === 'FFFEF3C7', fillOf(gross));
ok('the collections Total is a key figure too', fillOf(find('Total')) === 'FFFEF3C7');
ok('the business name is the title band (white on SwiftPOS teal)', fillOf(ws.getRow(1)) === 'FF0F766E' && fontOf(ws.getRow(1)) === 'FFFFFFFF');
ok('section names are banded (Grand Total, Collection Breakup, Tax Breakup)',
  ['Grand Total', 'Collection Breakup', 'Tax Breakup'].every((t) => fillOf(find(t)) === 'FF134E4A'));
ok('column headings are pale teal (Mode, Tax Name, Hour)', ['Mode', 'Tax Name', 'Hour'].every((t) => fillOf(find(t)) === 'FFCCFBF1'));
ok('section totals are gray (Tax Total, Charge Total)', ['Tax Total', 'Charge Total'].every((t) => fillOf(find(t)) === 'FFF3F4F6'));
ok('ordinary rows stay plain (Cash, Total Sale)', fillOf(find('Cash')) === null && fillOf(find('Total Sale')) === null);

const lum = (argb) => { const c = [1, 3, 5].map((i) => parseInt(argb.slice(2).slice(i - 1, i + 1), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const weak = Object.entries(R.ROW_STYLES).map(([k, v]) => [k, cr(v.font, v.fill ?? 'FFFFFFFF')]).filter(([, r]) => r < 4.5);
ok('every style reads: text ≥ 4.5:1 on its fill (most ≥ 7)', weak.length === 0, JSON.stringify(weak));

console.log('\n0.6.11 — the screens (source; React not run here)');
const mp = read('src/renderer/pages/ManagerPage.tsx');
ok('Shift report: a picker of this till\'s previous shifts, each opened via shift:zreport and printable',
  /posApi\.shift\.history\(\)/.test(mp) && /selected \? posApi\.shift\.zreport\(selected\)/.test(mp) && /Print report/.test(mp));
// A351: the sidebar is built in lib/managerNav.ts now; Expenses stays its own sidebar item there.
ok('Expenses: its own manager tab, by date range', /\{ key: 'expenses', label: 'Expenses', tabs: \[\{ key: 'expenses', label: 'Expenses' \}\] \}/.test(read('src/renderer/lib/managerNav.ts')) && /posApi\.expense\.range\(range\)/.test(mp));
const zv = read('src/renderer/components/ZReportView.tsx');
ok('the on-screen report shows "− Expenses" and the EXPENSES lines', /row\('− Expenses', money\(totals\.expenses\)\)/.test(zv) && /EXPENSES \(\{report\.expenseLines!\.length\}\)/.test(zv));
ok('the print payload sends them', /expenses:\s+totals\.expenses == null \? null : toCents\(totals\.expenses\)/.test(read('src/renderer/lib/printShiftReport.ts')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
