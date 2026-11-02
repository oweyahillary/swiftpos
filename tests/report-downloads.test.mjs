/**
 * report-downloads.test.mjs — A467: download each report on its own, for a day, a week or a month.
 *
 * Owner, 2026-10-13: "can we download individual report — some I might want daily, some monthly, some weekly".
 *
 *   node tests/report-downloads.test.mjs
 *
 * RUNS, not pins, where it can:
 *   - lib/reportDownload.ts (pure, no imports) is imported as TypeScript; its workbook is built with the dashboard's
 *     own `xlsx` and READ BACK: the About sheet, the header rows, numbers as numbers, money to 2 dp, the file name.
 *   - lib/reportPeriods.ts is bundled with esbuild (it imports lib/localDate) and run for fixed "today"s in Kenya's
 *     time zone: a Sunday, a Monday, the 1st of a month, New Year, a leap February, and a UTC-evening instant that is
 *     already tomorrow in Nairobi.
 * Pins: every data tab on the owner's Reports page renders the Download Excel button (not Monthly pack, not Exports),
 * and the presets row scrolls on a phone (A608: the manager portal's Reports page is retired).
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - weekStart's `(d.getDay() + 6) % 7` → `d.getDay()` (Sunday weeks)   → "a Sunday: This week is Mon 5 → Sun 11" fails
 *   - cellValue's `col.money ? 2 : col.dp` → `col.dp` (money unrounded)   → "money is a number rounded to 2 dp" fails
 */
process.env.TZ = 'Africa/Nairobi';   // the presets are local (EAT) days — set before any Date is made

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A467_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A467_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const read = (p) => fs.readFileSync(path.join(DASH, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assert = (c, msg) => { if (!c) throw new Error(msg); };

// ── load the code under test ──
const RD = await import(pathToFileURL(path.join(DASH, 'src/lib/reportDownload.ts')).href);

function requireFrom(pkgDirs, name) {
  for (const d of pkgDirs) {
    try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ }
  }
  throw new Error(`${name} not installed (npm ci in apps/dashboard)`);
}
const esbuild = requireFrom(['apps/server', 'apps/dashboard'], 'esbuild');
const XLSX = requireFrom(['apps/dashboard'], 'xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a467-'));
const outFile = path.join(tmp, 'reportPeriods.mjs');
esbuild.buildSync({ entryPoints: [path.join(DASH, 'src/lib/reportPeriods.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
const RP = await import(pathToFileURL(outFile).href);

// ── file name ──
await ok('file name: zaptill-<report>-<branch>-<from>_to_<to>.xlsx', () => {
  eq(RD.reportFileName({ report: 'Voids & Exceptions', branchName: 'Westlands Branch', from: '2026-10-05', to: '2026-10-11' }),
    'zaptill-voids-exceptions-westlands-branch-2026-10-05_to_2026-10-11.xlsx');
});
await ok('file name: a single day is just the date; no branch is "all"', () => {
  eq(RD.reportFileName({ report: 'Item Mix', branchName: '', from: '2026-10-13', to: '2026-10-13' }), 'zaptill-item-mix-all-2026-10-13.xlsx');
  eq(RD.reportFileName({ report: 'SPLH & Labour', branchName: null, from: '2026-10-01', to: '2026-10-31' }), 'zaptill-splh-labour-all-2026-10-01_to_2026-10-31.xlsx');
});

// ── sheet names ──
await ok('sheet names are Excel-safe: ≤ 31 chars, no : \\ / ? * [ ], unique', () => {
  const used = new Set();
  const a = RD.safeSheetName('Tank Reconciliation — Current · Sold · Delivered · Opening', used);
  const b = RD.safeSheetName('Tank Reconciliation — Current · Sold · Delivered · Opening', used);
  const c = RD.safeSheetName('By [branch]: a/b?*', used);
  const d = RD.safeSheetName('', used);
  for (const n of [a, b, c, d]) assert(n.length > 0 && n.length <= 31 && !/[:\\/?*[\]]/.test(n), `bad sheet name ${JSON.stringify(n)}`);
  assert(a.toLowerCase() !== b.toLowerCase(), 'duplicate names must be made unique');
});

// ── the workbook, built with xlsx and read back ──
const input = {
  report: 'Voids & Exceptions', branchName: 'Westlands', businessName: 'Mama Oliech', from: '2026-10-05', to: '2026-10-11',
  sheets: [
    { name: 'Voids by Cashier', columns: [{ key: 'name', label: 'Cashier' }, { key: 'count', label: 'Count', dp: 0 }, { key: 'value', label: 'Value', money: true }],
      rows: [{ name: 'Achieng', count: 2, value: 1234.5678 }, { name: 'Otieno', count: 1, value: '99.999' }] },
    { name: 'Void Log', columns: [{ key: 'order_number', label: 'Order' }, { key: 'void_reason', label: 'Reason' }, { key: 'total', label: 'Amount', money: true }],
      rows: [{ order_number: 'A-101', void_reason: null, total: 500 }] },
  ],
};
const generatedAt = new Date('2026-10-13T15:05:00Z');   // 18:05 in Nairobi
const shaped = RD.shapeReport(input, generatedAt);
const wb = XLSX.read(XLSX.write(RD.buildWorkbook(XLSX, shaped), { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
const rowsOf = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });

await ok('the workbook: About first, then one sheet per section, in order', () => {
  eq(wb.SheetNames, ['About', 'Voids by Cashier', 'Void Log']);
  eq(shaped.fileName, 'zaptill-voids-exceptions-westlands-2026-10-05_to_2026-10-11.xlsx');
});
await ok('About: business, branch, report, period, generated at (local time)', () => {
  eq(rowsOf('About'), [['Field', 'Value'], ['Business', 'Mama Oliech'], ['Branch', 'Westlands'], ['Report', 'Voids & Exceptions'],
    ['Period from', '2026-10-05'], ['Period to', '2026-10-11'], ['Generated at', '2026-10-13 18:05']]);
  const all = RD.shapeReport({ ...input, branchName: '' }, generatedAt).sheets[0].aoa;
  eq(all[2], ['Branch', 'All branches'], 'no branch picked:');
});
await ok('each sheet\'s header row is the tab\'s column headings', () => {
  eq(rowsOf('Voids by Cashier')[0], ['Cashier', 'Count', 'Value']);
  eq(rowsOf('Void Log')[0], ['Order', 'Reason', 'Amount']);
});
await ok('money is a number rounded to 2 dp (a numeric string too), counts stay numbers', () => {
  const r = rowsOf('Voids by Cashier');
  eq(r[1], ['Achieng', 2, 1234.57]);
  eq(r[2], ['Otieno', 1, 100]);
  const cell = wb.Sheets['Voids by Cashier'].C2;
  assert(cell.t === 'n', `money cell type ${cell.t}, want n`);
});
await ok('one row per data row — nothing doubled, a missing value is a blank cell', () => {
  eq(rowsOf('Void Log').length, 2);
  eq(rowsOf('Voids by Cashier').length, 3);
  eq(rowsOf('Void Log')[1], ['A-101', null, 500]);
});
await ok('a tab with no rows anywhere is "empty" (the button is disabled)', () => {
  assert(RD.reportIsEmpty([{ name: 'x', columns: [], rows: [] }]) === true, 'empty');
  assert(RD.reportIsEmpty(input.sheets) === false, 'not empty');
});
await ok('a timestamp in a sheet is the Nairobi day and time', () => {
  eq(RD.localStamp('2026-10-11T21:30:00Z'), '2026-10-12 00:30');
  eq(RD.localStamp(null), '');
});

// ── presets: fixed "today"s, Kenya time ──
const P = (now) => Object.fromEntries(RP.reportPresets(now).map((p) => [p.label, [p.from, p.to]]));
await ok('presets: Today · Yesterday · This week · Last week · This month · Last month', () => {
  eq(RP.reportPresets(new Date(2026, 9, 13)).map((p) => p.label), ['Today', 'Yesterday', 'This week', 'Last week', 'This month', 'Last month']);
});
await ok('a Sunday: This week is Mon 5 → Sun 11; Last week is Mon 28 Sep → Sun 4 Oct', () => {
  const p = P(new Date(2026, 9, 11, 20, 0));
  eq(p['This week'], ['2026-10-05', '2026-10-11']);
  eq(p['Last week'], ['2026-09-28', '2026-10-04']);
  eq(p.Yesterday, ['2026-10-10', '2026-10-10']);
});
await ok('a Monday: This week is just today; Last week is the Monday–Sunday before', () => {
  const p = P(new Date(2026, 9, 12, 8, 0));
  eq(p['This week'], ['2026-10-12', '2026-10-12']);
  eq(p['Last week'], ['2026-10-05', '2026-10-11']);
});
await ok('the 1st of a month: This month is today; Last month is the whole month before', () => {
  const p = P(new Date(2026, 10, 1, 9, 0));
  eq(p['This month'], ['2026-11-01', '2026-11-01']);
  eq(p['Last month'], ['2026-10-01', '2026-10-31']);
  eq(p['This week'], ['2026-10-26', '2026-11-01']);
});
await ok('New Year: Last month and Last week reach back into the year before', () => {
  const p = P(new Date(2027, 0, 1, 12, 0));   // a Friday
  eq(p['Last month'], ['2026-12-01', '2026-12-31']);
  eq(p['This week'], ['2026-12-28', '2027-01-01']);
  eq(p['Last week'], ['2026-12-21', '2026-12-27']);
});
await ok('a leap year: Last month in March ends on 29 February', () => {
  eq(P(new Date(2028, 2, 10))['Last month'], ['2028-02-01', '2028-02-29']);
});
await ok('22:30 UTC on Sunday is already Monday in Nairobi — the presets follow Nairobi, not UTC', () => {
  const p = P(new Date('2026-10-11T22:30:00Z'));
  eq(p.Today, ['2026-10-12', '2026-10-12']);
  eq(p['This week'], ['2026-10-12', '2026-10-12']);
  eq(p['Last week'], ['2026-10-05', '2026-10-11']);
});

// ── pins: the button on every data tab ──
const page = read('src/pages/ReportsPage.tsx');
const body = (name) => {
  const i = page.indexOf(`function ${name}(`);
  assert(i >= 0, `${name} not found`);
  const j = page.indexOf('\nfunction ', i + 10);
  const k = page.indexOf('\nexport default function', i + 10);
  return page.slice(i, Math.min(j < 0 ? Infinity : j, k < 0 ? Infinity : k));
};
const DATA_TABS = ['MasterTab', 'HourlyTab', 'ItemMixTab', 'MatrixTab', 'FoodCostTab', 'VoidsTab', 'RefundsTab', 'InventoryTab',
  'TaxTab', 'StaffTab', 'SplhTab', 'FuelSalesTab', 'WetStockTab'];
await ok('owner Reports: every data tab renders Download Excel with its own sheets', () => {
  const missing = DATA_TABS.filter((t) => !/<ExcelButton report="[^"]+" range=\{range\} meta=\{meta\} sheets=\{sheets\} \/>/.test(body(t))
    || !/const sheets: ReportSheet\[\] =/.test(body(t)));
  assert(missing.length === 0, `no Download Excel on: ${missing.join(', ')}`);
});
await ok('…but not Monthly pack (its own server Excel) nor Exports', () => {
  assert(!/ExcelButton/.test(body('ExportsTab')), 'Exports has a Download Excel');
  assert(!/DownloadExcelButton|reportDownload/.test(read('src/pages/reports/MonthlyPackTab.tsx')), 'Monthly pack has a Download Excel');
});
await ok('each tab is wired: the About sheet gets the business and the picked branch', () => {
  assert(/function ExcelButton\([\s\S]*?<DownloadExcelButton input=\{\{ report, from: range\.from, to: range\.to, businessName: meta\.businessName, branchName: meta\.branchName, sheets \}\} \/>/.test(page), 'ExcelButton');
  // A582: blank = All branches — or, for a partner's "All my branches", those words
  assert(/branchName: branchId \? \(\(branches \?\? \[\]\)\.find\(b => b\.id === branchId\)\?\.name \?\? ''\) : \(allMine \? allLabel : ''\)/.test(page), 'meta.branchName');
  assert(/const tabProps: TabProps = \{ range, branchId, currency, meta(?:, staffId)? \}/.test(page), 'tabProps carry meta');   // A576: and the person a watch-list link names
});
await ok('sheets come from the data, never the page (no DOM scraping)', () => {
  const src = page + read('src/lib/reportDownload.ts') + read('src/components/DownloadExcelButton.tsx');
  assert(!/table_to_sheet|table_to_book|querySelector|innerText/.test(src), 'a sheet is built from the DOM');
});
await ok('xlsx loads only when the button is pressed (not in the main bundle)', () => {
  const rd = read('src/lib/reportDownload.ts');
  assert(/await import\('xlsx'\)/.test(rd), 'dynamic import');
  assert(!/^import .* from 'xlsx'/m.test(rd), 'static import of xlsx');
});
await ok('the button: teal, disabled while loading / busy / empty', () => {
  const b = read('src/components/DownloadExcelButton.tsx');
  assert(/disabled=\{loading \|\| busy \|\| empty\}/.test(b), 'disabled rule');
  assert(/bg-swift-strong hover:bg-swift-deep/.test(b), 'teal');
  assert(/↓ Download Excel/.test(b), 'label');
});
await ok('presets: the owner bar uses reportPresets and scrolls sideways on a phone', () => {
  assert(/const presets = reportPresets\(\);/.test(page), 'reportPresets');
  assert(/data-testid="report-presets" className="[^"]*max-w-full overflow-x-auto/.test(page), 'scrolling row');
});

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; the manager Reports page
// (ManagerReportsPage.tsx) is gone; a manager downloads from the owner's Reports page, pinned above.

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
