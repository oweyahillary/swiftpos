// A454 — the cashier's Z-report at shift close: their own count, no reconciliation; and the Z-report prints on the till's
// receipt printer even when that printer is a Windows printer (no thermal Till station bound).
//
// Owner, 2026-10-12: "remove reconciliation from Zreport printed by the cashier during shift closing, it should only show
// payment method and any other details needed they should not know the variance and make the till printer be the default
// printer to print the zreport right now its not printing".
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/zreport-cashier-copy.test.mjs
//
// The layout itself is tested in shared/printing (test/shift-report-cashier-copy.test.ts). Here: the REAL compiled
// printWorker's Windows page, and the wiring from the shift screen to the printer.
//
// MUTATIONS TO CONFIRM BITE:
//   - printWorker answering "No receipt printer is set up" again when nothing is bound  → "falls back to the Windows…" fails
//   - the blind close signing out without printing                                       → "a cashier's close prints…" fails
//   - shiftReportHtml not escaping                                                        → "the page is the paper's text" fails
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a454-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const W = require(path.join(dist, 'print', 'printWorker.js'));
const P = require('@swiftpos/printing');

console.log('\nThe cashier\'s copy on a Windows receipt printer\n');
{
  const report = {
    businessName: 'Your <Business>', currencyCode: 'KES', cashierName: 'Amina', shiftRef: '6425f8ed',
    openedAt: new Date('2026-10-12T06:55:40Z'), closedAt: new Date('2026-10-12T15:00:00Z'), status: 'closed',
    byMethod: [{ method: 'cash', orders: 9, amount: 1239000 }], orderCount: 9, grossSales: 1239000, voidCount: 0,
    openingFloat: 300000, cashSales: 1239000, floatIn: 0, floatOut: 0, expectedCash: 1539000, countedCash: 1530000, variance: -9000,
    cashierCopy: { declared: [{ method: 'cash', amount: 1530000 }, { method: 'mpesa', amount: 455000 }] },
    printedAt: new Date('2026-10-12T15:00:05Z'),
  };
  const text = P.toPreview(P.renderShiftReport(report, 80));
  const html = W.shiftReportHtml(text, 80);
  ok('the page is the paper\'s own text, monospace, escaped', html.includes('<pre>') && html.includes('YOUR &lt;BUSINESS&gt;') && !html.includes('YOUR <BUSINESS>')
    && /font-family: 'Courier New'/.test(html));
  ok('…the cashier\'s count is on it, the reconciliation is not', /YOUR COUNT/.test(html) && /Total declared/.test(html)
    && !/Expected|Variance|RECONCILIATION/i.test(html));
  ok('58mm gets the narrower font', /font-size: 10px/.test(W.shiftReportHtml(text, 58)) && /font-size: 12px/.test(html));
}

console.log('\nThe wiring\n');
{
  const pw = src('main/print/printWorker.ts');
  ok('no thermal Till station bound → the Windows receipt printer (else the Windows default), not a refusal',
    /if \(!assignment\) return await printShiftReportViaWindows\(data\);/.test(pw) && !/No receipt printer is set up on this terminal/.test(pw)
    && /printHtmlSilent\(\{ html, deviceName: device, paperWidthMm: width, copies: 1 \}\)/.test(pw));
  const lib = src('renderer/lib/printShiftReport.ts');
  ok('the till sends its receipt printer and paper width with every Z-report',
    /const ps = readPrinterSettings\(\);/.test(lib) && /fallbackPrinter: ps\.receiptPrinterName \?\? '',/.test(lib)
    && /fallbackPaperWidthMm: ps\.paperWidth === 58 \? 58 : 80,/.test(lib) && /^\s+cashierCopy,$/m.test(lib));
  const panel = src('renderer/pages/ShiftPanel.tsx');
  const blind = panel.slice(panel.indexOf('if ((r as any)?.blind && onSignOut) {'), panel.indexOf('setFinalReport(r);', panel.indexOf('if ((r as any)?.blind && onSignOut) {')));
  ok('a cashier\'s (blind) close prints their copy before the PIN screen — cash as counted, the others as declared',
    /const declared = \{ \.\.\.\(declaredRead\.ok \? declaredRead\.map : \{\}\), cash: counted \};/.test(blind)
    && blind.indexOf('printShiftReport(r, { cashierCopy: { declared } })') > 0
    && blind.indexOf('printShiftReport(r, { cashierCopy') < blind.indexOf('onSignOut('));
  ok('…and says if the slip did not print', /Your slip did not print: \$\{p\.error/.test(blind));
  ok('a manager\'s close still prints the full Z-report (with the reconciliation)', /printShiftReport\(r\)\.then\(\(p\) => \{ if \(!p\.ok\) setPrintMsg/.test(panel));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
