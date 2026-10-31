/**
 * no-global-buffer.test.mjs — the dashboard never puts a `Buffer` on the page's global object.
 *
 * 2026-10-31 (owner's screenshot: /dashboard/analytics · "Vc.Buffer.isBuffer is not a function"): the receipt renderer's
 * Buffer shim set globalThis.Buffer = { from } for the whole page; recharts' es-toolkit trusts a global Buffer
 * (`typeof globalThis.Buffer !== "undefined" && globalThis.Buffer.isBuffer(x)`) and the Analytics page crashed once a
 * receipt had been loaded. The shim is now a module export esbuild injects into the renderer alone.
 *
 *   node tests/no-global-buffer.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const SETS_GLOBAL = /(globalThis|window|self)\.Buffer\s*=(?!=)/;

console.log('No global Buffer on the page\n');
ok('the receipt renderer\'s shim is an injected export, never a global', () => {
  const shim = read('scripts/escpos-renderer/buffer-shim.js');
  assert.doesNotMatch(shim, SETS_GLOBAL);
  assert.match(shim, /export \{ PrinterBuffer as Buffer \};/);
});
ok('the generated renderer sets no global Buffer and uses its own', () => {
  const r = read('apps/dashboard/src/lib/escposRenderer.js');
  assert.doesNotMatch(r, SETS_GLOBAL);
  assert.match(r, /return PrinterBuffer\.from\(out\);/);
});
ok('no dashboard source file sets a global Buffer', () => {
  const bad = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(t|j)sx?$/.test(e.name) && SETS_GLOBAL.test(read(p))) bad.push(p);
  } };
  walk('apps/dashboard/src');
  assert.deepEqual(bad, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
