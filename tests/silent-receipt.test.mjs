/**
 * silent-receipt.test.mjs — A235 source guards (rule 24), mutation-checkable.
 * Finishes the web silent-print path: token is sent (X-Print-Token), the receipt
 * goes to /print/receipt (order JSON → bridge renders ESC/POS), PaymentModal uses
 * it when paired and falls back to the browser dialog otherwise, and the Printers
 * page lets the till pair (token + receipt printer).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lps = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/localPrintServer.ts'), 'utf8');
const ups = fs.readFileSync(path.join(root, 'apps/dashboard/src/hooks/usePrinterSettings.ts'), 'utf8');
const pm  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
const pp  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/settings/PrintersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── token ────────────────────────────────────────────────────────────────
ok('token is stored per-device and sent as X-Print-Token', () => {
  assert.match(lps, /export function getPrintToken\(\)/);
  assert.match(lps, /export function setPrintToken\(/);
  assert.match(lps, /'X-Print-Token': t/);
});
ok('every print call includes the token headers', () => {
  assert.strictEqual((lps.match(/\.\.\.tokenHeaders\(\)/g) || []).length >= 3, true); // printToQZ, testPrint, printReceiptViaServer
});

// ── correct endpoint ─────────────────────────────────────────────────────
ok('printReceiptViaServer posts the Order to /print/receipt', () => {
  assert.match(lps, /const RECEIPT_PATH = `\$\{SERVER_URL\}\/print\/receipt`/);
  assert.match(lps, /export async function printReceiptViaServer\(/);
  assert.match(lps, /JSON\.stringify\(\{ target, order, business, paperWidth \}\)/);
});

// ── settings ─────────────────────────────────────────────────────────────
ok('a device-local receipt printer setting exists', () => {
  assert.match(ups, /receiptPrinterName\?: string/);
});

// ── PaymentModal: server when paired, browser fallback otherwise ───────────
ok('PaymentModal prints via the bridge when connected + paired', () => {
  assert.match(pm, /printReceiptViaServer\(printerName, order, biz, printerSettings\.paperWidth\)/);
  assert.match(pm, /getPrintToken\(\) && getQZStatus\(\) === 'connected'/);
  assert.match(pm, /buildReceiptOrder\(\{/);
});
ok('PaymentModal falls back to the browser dialog', () => {
  assert.match(pm, /if \(content\) printReceipt\(content\.innerHTML, printerSettings, business\.name\);/);
});

// ── PrintersPage pairing ──────────────────────────────────────────────────
ok('Printers page pairs the till (token + receipt printer)', () => {
  assert.match(pp, /setPrintToken\(e\.target\.value\)/);
  assert.match(pp, /saveRxSettings\(\{ receiptPrinterName: e\.target\.value \}\)/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
