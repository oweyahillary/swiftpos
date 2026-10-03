/**
 * tenant-signin-flash.test.mjs — 0.6.36: a client's sign-in address never flashes the ZapTill brand first.
 *
 * Owner, 2026-10-03 (pollofriedchicken.zaptill.co.ke): "there was a lag there before it switched from swift to pollo
 * fried chicken". The page showed the default brand while it asked the cloud whose address it is. Now: the client last
 * seen on this address is remembered in the browser and shown at once; on a first visit the brand area stays empty
 * until the cloud answers. The remembered client is refreshed every visit and forgotten when the address is removed.
 *
 * Runs the real lib/tenant.ts (initialTenantState) with a fake localStorage; source pins on both sign-in pages.
 *
 * MUTATIONS TO CONFIRM BITE: initialTenantState ignoring the cache → "a returning visitor sees the client at once"
 * fails; LoginPage without the loading branch → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

// lib/tenant.ts imports react, ./config (import.meta.env) and ./tenantHost — run it from a temp copy with stand-ins.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-'));
fs.writeFileSync(path.join(dir, 'tenant.ts'), read('apps/dashboard/src/lib/tenant.ts')
  .replace("from 'react'", "from './react-stub.ts'").replace("from './config'", "from './config-stub.ts'")
  .replace("from './tenantHost'", "from './tenantHost.ts'"));
fs.writeFileSync(path.join(dir, 'react-stub.ts'), 'export const useState = () => []; export const useEffect = () => {};\n');
fs.writeFileSync(path.join(dir, 'config-stub.ts'), "export const API_URL = 'http://x';\n");
fs.copyFileSync(path.join(ROOT, 'apps/dashboard/src/lib/tenantHost.ts'), path.join(dir, 'tenantHost.ts'));
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const T = await import(pathToFileURL(path.join(dir, 'tenant.ts')).href);

await ok('the main address: no client', () => assert.deepStrictEqual(T.initialTenantState(null), { status: 'none' }));
await ok('a first visit: loading (the page shows no brand until the cloud answers)', () => {
  assert.deepStrictEqual(T.initialTenantState('pollofriedchicken'), { status: 'loading', subdomain: 'pollofriedchicken' });
});
await ok('a returning visitor sees the client at once (remembered in this browser)', () => {
  store.set('zaptill_tenant_pollofriedchicken', JSON.stringify({ name: 'Pollo Fried Chicken', logo: null, accent: null }));
  const s = T.initialTenantState('pollofriedchicken');
  assert.strictEqual(s.status, 'found');
  assert.strictEqual(s.tenant.name, 'Pollo Fried Chicken');
});
await ok('a broken or empty memory is ignored (loading, as a first visit)', () => {
  store.set('zaptill_tenant_x1', '{not json'); store.set('zaptill_tenant_x2', JSON.stringify({ name: '' }));
  assert.strictEqual(T.initialTenantState('x1').status, 'loading');
  assert.strictEqual(T.initialTenantState('x2').status, 'loading');
});
await ok('no storage at all (private window): loading, never a crash', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  try { assert.strictEqual(T.initialTenantState('pollofriedchicken').status, 'loading'); } finally { globalThis.localStorage = saved; }
});
await ok('the hook remembers every answer, forgets a removed address, and keeps a remembered client when offline', () => {
  const src = read('apps/dashboard/src/lib/tenant.ts');
  assert.match(src, /rememberTenant\(sub, info\);/);
  assert.match(src, /res\.status === 404\) \{ rememberTenant\(sub, null\);/);
  assert.match(src, /s\.status === 'found' \? s : \{ status: 'error'/);
});
await ok('both sign-in pages show no brand while loading (no flash of ZapTill)', () => {
  assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /tenant\.status === 'loading' \? \(\s*\/\/[^\n]*\n\s*<div className="mb-3 h-\[60px\]" aria-hidden data-testid="tenant-loading" \/>/);
  assert.match(read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx'), /tenant\.status === 'loading'\s*\n\s*\? <div style=\{\{ height: 60 \}\} aria-hidden data-testid="tenant-loading" \/>/);
});
await ok('no version on the sign-in page', () => assert.doesNotMatch(read('apps/dashboard/src/pages/LoginPage.tsx'), /releaseLabel/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
