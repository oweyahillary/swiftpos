/**
 * tiny-bridge-printing.test.mjs — the small-installer architecture (A239).
 * Browser renders ESC/POS → base64 → POST /print to the tiny Go bridge; no
 * server-side render, no Vercel env, open CORS + token.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const lps = r('apps/dashboard/src/lib/localPrintServer.ts');
const pm  = r('apps/dashboard/src/pages/pos/PaymentModal.tsx');
const go  = r('apps/print-server/go/main.go');
const rend = r('apps/dashboard/src/lib/escposRenderer.js');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('bridge URL is hard-coded (no Vercel env required)', () => {
  assert.match(lps, /\|\| 'http:\/\/127\.0\.0\.1:9911'/);
});
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
ok('Go bridge: /printers + /print/test + open CORS + v4', () => {
  assert.match(go, /version = "4\.0\.0"/);
  assert.match(go, /HandleFunc\("\/printers"/);
  assert.match(go, /HandleFunc\("\/print\/test"/);
  assert.match(go, /Access-Control-Allow-Origin", origin/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
