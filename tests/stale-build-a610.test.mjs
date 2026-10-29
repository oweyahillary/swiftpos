/**
 * stale-build-a610.test.mjs — A610: "Something went wrong" on random pages after a deploy.
 *
 * Owner, 2026-10-29 (a screenshot of the ErrorBoundary screen): "the error on the screenshot it always appears what causes
 * it" — "random pages". Each page is a lazy chunk; a tab from before a deploy asks for the OLD chunk names, vercel.json
 * rewrites them to /index.html, the browser refuses HTML as a module and the page throws. The dashboard now loads the new
 * build once by itself (apps/dashboard/src/lib/staleBuild.ts), never in a loop, and the screen says what broke.
 *
 *   node tests/stale-build-a610.test.mjs
 *
 * RUNS lib/staleBuild.ts (type-stripped) with a fake window / sessionStorage; pins ErrorBoundary.tsx and main.tsx.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A610_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A610_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let reloads = 0;
const store = new Map();
let blocked = false;
globalThis.window = { location: { reload: () => { reloads++; } } };
globalThis.sessionStorage = {
  getItem: (k) => { if (blocked) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (blocked) throw new Error('blocked'); store.set(k, String(v)); },
};
const S = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/staleBuild.ts')).href);

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('A610 — a stale tab after a deploy loads the new build\n');

ok('the browsers\' words for a chunk that could not load are recognised', () => {
  for (const m of [
    'Failed to fetch dynamically imported module: https://x/assets/OrdersPage-abc.js',   // Chrome
    'error loading dynamically imported module',                                          // Firefox
    'Importing a module script failed.',                                                  // Safari
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\". 'text/html' is not a valid JavaScript MIME type.",
    'Unable to preload CSS for /assets/index-1.css',
  ]) assert.equal(S.isChunkLoadError(new Error(m)), true, m);
  assert.equal(S.isChunkLoadError({ name: 'ChunkLoadError', message: 'Loading chunk 3 failed' }), true);
});

ok('an ordinary error is not one (the screen still shows)', () => {
  for (const m of ["Cannot read properties of undefined (reading 'map')", 'Network request failed', '']) {
    assert.equal(S.isChunkLoadError(new Error(m)), false, m);
  }
  assert.equal(S.isChunkLoadError(null), false);
  assert.equal(S.isChunkLoadError(undefined), false);
});

ok('the first time: one reload', () => {
  reloads = 0; store.clear();
  assert.equal(S.reloadForNewBuild(1_000_000), true);
  assert.equal(reloads, 1);
});

ok('again within a minute: no reload (a real outage is shown, never a loop)', () => {
  reloads = 0;
  assert.equal(S.reloadForNewBuild(1_000_000 + 59_000), false);
  assert.equal(reloads, 0);
});

ok('a later deploy (over a minute on): reloads again', () => {
  reloads = 0; store.clear();
  S.reloadForNewBuild(2_000_000);
  reloads = 0;
  assert.equal(S.reloadForNewBuild(2_000_000 + 61_000), true);
  assert.equal(reloads, 1);
});

ok('storage blocked: never reloads by itself (it could not tell its own reload from the next)', () => {
  reloads = 0; blocked = true;
  assert.equal(S.reloadForNewBuild(3_000_000), false);
  assert.equal(S.reloadForNewBuild(3_000_001), false);
  assert.equal(reloads, 0);
  blocked = false;
});

ok('ErrorBoundary: a chunk error reloads; the screen shows the path and the error\'s own words', () => {
  const eb = read('apps/dashboard/src/components/ErrorBoundary.tsx');
  assert.match(eb, /import \{ isChunkLoadError, reloadForNewBuild \} from '\.\.\/lib\/staleBuild';/);
  assert.match(eb, /componentDidCatch\([\s\S]*?if \(isChunkLoadError\(error\) && reloadForNewBuild\(\)\) this\.setState\(\{ reloading: true \}\);/);
  assert.match(eb, /if \(this\.state\.reloading\) \{/);
  assert.match(eb, /data-testid="error-detail"[\s\S]*?window\.location\.pathname/);
});

ok('main.tsx: a failed preload (vite:preloadError) loads the new build', () => {
  const m = read('apps/dashboard/src/main.tsx');
  assert.match(m, /import \{ reloadForNewBuild \} from '\.\/lib\/staleBuild';/);
  assert.match(m, /window\.addEventListener\('vite:preloadError', \(event\) => \{\s*if \(reloadForNewBuild\(\)\) event\.preventDefault\(\);/);
});

ok('the cause is as described: vercel.json sends every missing path to /index.html', () => {
  const v = JSON.parse(read('apps/dashboard/vercel.json'));
  assert.ok(v.rewrites.some((r) => r.source === '/(.*)' && r.destination === '/index.html'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
