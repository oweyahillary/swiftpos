/**
 * tiny-bridge-printing.test.mjs — the small-installer architecture (A239) plus
 * the A240–A243 hardening: browser renders ESC/POS → base64 → POST /print to the
 * tiny Go bridge; the bridge is loopback + Host-locked + token-gated; the KOT
 * path was migrated off the old QZ contract; the dead A235 path is gone.
 *
 * These are SOURCE guards (rule 9). Runtime security behaviour (Host 403, token
 * 401, byte-forward) is proven separately by running the built Go bridge.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const lps  = r('apps/dashboard/src/lib/localPrintServer.ts');
const pm   = r('apps/dashboard/src/pages/pos/PaymentModal.tsx');
const go   = r('apps/print-server/go/main.go');
const rend = r('apps/dashboard/src/lib/escposRenderer.js');
const kot  = r('apps/dashboard/src/lib/printKOT.ts');
const rcpt = r('apps/dashboard/src/lib/printReceipt.ts');
const ups  = r('apps/dashboard/src/hooks/usePrinterSettings.ts');
const pp   = r('apps/dashboard/src/pages/settings/PrintersPage.tsx');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

// A241: URL is TRULY hard-coded (no Vite/Vercel env override)
ok('bridge URL is hard-coded to a literal (no env override)', () => {
  assert.match(lps, /const SERVER_URL\s*=\s*'http:\/\/127\.0\.0\.1:9911'/);
  assert.doesNotMatch(lps, /import\.meta\.env/);   // no build-env read = no trap
});

// A239 core: browser renders, dashboard forwards bytes
ok('dashboard sends rendered bytes to /print', () => {
  assert.match(lps, /export async function printBytesToServer/);
  assert.match(lps, /JSON\.stringify\(\{ target, data: bytesToBase64\(bytes\) \}\)/);
});
ok('PaymentModal renders in-browser then forwards bytes', () => {
  assert.match(pm, /const bytes = renderEscPos\(order, biz, printerSettings\.paperWidth\)/);
  assert.match(pm, /await printBytesToServer\(`printer:\$\{printerName\}`, bytes\)/);
});
ok('vendored renderer is self-contained (Buffer shimmed, no Node import)', () => {
  assert.match(rend, /Uint8Array\.from/);
  assert.doesNotMatch(rend, /require\(['"]fs['"]\)|require\(['"]net['"]\)/);
});

// A243: copies honoured on the byte path
ok('receipt honours the copies setting on the byte path', () => {
  assert.match(pm, /printerSettings\.copies/);
  assert.match(pm, /for \(let i = 0; i < copies; i\+\+\)/);
});

// A240: Go bridge security — loopback + Host-lock + token-gated
ok('Go bridge is v4.2 with /printers + /print/test + open CORS', () => {
  assert.match(go, /version = "4\.2\.0"/);
  assert.match(go, /HandleFunc\("\/printers"/);
  assert.match(go, /HandleFunc\("\/print\/test"/);
  assert.match(go, /Access-Control-Allow-Origin", origin/);
});
ok('Go bridge validates the Host header on every handler (DNS-rebinding defence)', () => {
  assert.match(go, /func hostOK\(r \*http\.Request\) bool/);
  assert.strictEqual((go.match(/if !hostOK\(r\)/g) || []).length, 4);
  assert.match(go, /case "127\.0\.0\.1", "localhost"/);
});
ok('Go bridge authorises by allowlisted Origin OR token (token optional)', () => {
  assert.match(go, /func originOK\(r \*http\.Request\) bool/);
  assert.match(go, /func authorized\(r \*http\.Request\) bool/);
  assert.match(go, /return originOK\(r\) \|\| tokenOK\(r\)/);
  // the three write/enumerate handlers now gate on authorized(), not raw tokenOK
  assert.strictEqual((go.match(/if !authorized\(r\)/g) || []).length, 3);
});
ok('origin allowlist is exact — never wildcards a shared hosting suffix', () => {
  assert.match(go, /"https:\/\/swiftpos-dashboard\.vercel\.app": true/);
  assert.match(go, /"https:\/\/swiftpos-three\.vercel\.app":\s+true/);
  // the safe subdomain match is host == d || suffix "."+d, never a loose endsWith
  assert.match(go, /host == d \|\| strings\.HasSuffix\(host, "\."\+d\)/);
  // and there must be NO allowlist entry that is a bare/duplicated vercel.app value
  assert.doesNotMatch(go, /allowedOrigins = map\[string\]bool\{[^}]*"https:\/\/vercel\.app"/s);
});
ok('bridge sends the Private Network Access header for trusted origins', () => {
  assert.match(go, /Access-Control-Request-Private-Network.*==.*"true"/);
  assert.match(go, /Set\("Access-Control-Allow-Private-Network", "true"\)/);
  // …and only inside the origin-gated CORS block (reflected only when originOK)
  assert.match(go, /origin != "" && originOK\(r\)/);
});
ok('token is optional in the dashboard print gates (origin authorises)', () => {
  assert.doesNotMatch(pm, /getPrintToken\(\) && getQZStatus/);
  assert.doesNotMatch(kot, /getPrintToken/);
});

// A240: dashboard sends the token when enumerating printers
ok('dashboard sends the pairing token to /printers', () => {
  const i = lps.indexOf('function getQZPrinters');
  const seg = lps.slice(i, i + 400);
  assert.match(seg, /\/printers/);
  assert.match(seg, /tokenHeaders\(\)/);
});

// A242: KOT migrated to the byte path; old QZ contract gone
ok('KOT renders ESC/POS in the browser and forwards bytes', () => {
  assert.match(kot, /function buildKotEscPos\(/);
  assert.match(kot, /await printBytesToServer\(`printer:\$\{printer\.printer_name\}`, bytes\)/);
  assert.match(kot, /0x1d, 0x56, 0x00/);
});
ok('KOT no longer uses the old printToQZ contract, and falls back to browser', () => {
  assert.doesNotMatch(kot, /printToQZ/);
  assert.match(kot, /browserFallback/);
});

// A243: dead legacy paths removed everywhere
ok('legacy printToQZ / printReceiptViaServer are fully retired', () => {
  assert.doesNotMatch(lps, /printToQZ|printReceiptViaServer|\/print\/receipt/);
  assert.doesNotMatch(rcpt, /printToQZ|getQZStatus/);
});

// Pairing + fallback (ported from the retired A235 silent-receipt guard)
ok('PaymentModal falls back to the browser dialog when unpaired', () => {
  assert.match(pm, /if \(content\) printReceipt\(content\.innerHTML, printerSettings, business\.name\);/);
});
ok('till pairs the bridge: device-local receipt printer + token/printer inputs', () => {
  assert.match(ups, /receiptPrinterName\?: string/);
  assert.match(pp, /setPrintToken\(e\.target\.value\)/);
  assert.match(pp, /saveRxSettings\(\{ receiptPrinterName: e\.target\.value \}\)/);
});

// A244: test print must target the Windows spooler, not the network
ok('testPrint sends a printer:-prefixed spooler target (not a bare name)', () => {
  assert.match(lps, /target: 'printer:' \+ printerName/);
  assert.doesNotMatch(lps, /target: printerName\b/);   // the bare-name bug must stay gone
});

// A246: Print Bill fans to the 3 full-order stations in the shared format
ok('bundle exports the 3 station renderers', () => {
  assert.match(rend, /renderReceiptEscPos/);
  assert.match(rend, /renderKitchenEscPos/);
  assert.match(rend, /renderDispatchEscPos/);
});
ok('printBill fans receipt/kot/expeditor via the bridge, silently', () => {
  const pb = r('apps/dashboard/src/lib/printBill.ts');
  assert.match(pb, /receipt:\s+renderReceiptEscPos/);
  assert.match(pb, /kot:\s+renderKitchenEscPos/);
  assert.match(pb, /expeditor: renderDispatchEscPos/);
  assert.match(pb, /printBytesToServer\(`printer:\$\{p\.printer_name\}`, bytes\)/);
});
ok('the old guest-check iframe/window.print dialog is gone', () => {
  const cs = r('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.doesNotMatch(cs, /This is not a receipt/);          // the ad-hoc bill HTML is gone
  assert.doesNotMatch(cs, /Please pay at the counter/);
  assert.match(cs, /printBillToStations/);                    // Print Bill routes through the bridge
});
ok('receipt business config sets currencyCode (no "PAY: undefined")', () => {
  const bo = r('apps/dashboard/src/lib/buildReceiptOrder.ts');
  assert.match(bo, /currencyCode:\s+b\.currency \|\| 'KES'/);
});
ok('bill prints kitchen -> customer -> dispatcher (A247)', () => {
  const pb = r('apps/dashboard/src/lib/printBill.ts');
  assert.match(pb, /STATION_ORDER[^\n]*kot: 0, receipt: 1, expeditor: 2/);
  assert.match(pb, /\.sort\(\(x, y\) => \(STATION_ORDER/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
