/**
 * catalogue-refresh.test.mjs — A278: a web edit reaches a running till without a restart.
 *
 *   node tests/catalogue-refresh.test.mjs
 *
 * The A291 fast-poll already pulls web edits into the local DB every ~20s; the missing link was
 * that the running POS never re-read them. This guards the new notify→reload path end to end.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop the webContents.send('catalogue:changed') in index.ts → "main notifies on pull" fails
 *   - remove pos.onCatalogueChanged from preload                 → "preload bridges the push" fails
 *   - remove the POSPage subscription                            → "POS subscribes + reloads" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const idx  = r('apps/desktop/src/main/index.ts');
const pre  = r('apps/desktop/src/main/preload.ts');
const api  = r('apps/desktop/src/renderer/lib/posApi.ts');
const page = r('apps/desktop/src/renderer/pages/POSPage.tsx');

ok('main notifies the renderer only when a pull actually landed',
   /if \(r\.pulled\)[^\n]*webContents\.send\('catalogue:changed'\)/.test(idx) && /pullIfCatalogueChanged\(\)/.test(idx));
ok('preload bridges the push (on + unsubscribe)',
   /onCatalogueChanged:/.test(pre) && /ipcRenderer\.on\('catalogue:changed'/.test(pre) && /removeListener\('catalogue:changed'/.test(pre));
ok('posApi types onCatalogueChanged', /onCatalogueChanged:\s*\(cb:\s*\(\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void/.test(api));
ok('POS extracts a reusable catalogue loader', /const loadCatalogue = useCallback\(/.test(page));
ok('POS subscribes + reloads on catalogue:changed',
   /posApi\.pos\.onCatalogueChanged\(loadCatalogue\)/.test(page));
ok('POS still loads on mount', /loadCatalogue\(\);/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
