/**
 * branding-web-page.test.mjs — A308: the owner-facing web Branding settings page (SCOPE §6).
 *
 *   node tests/branding-web-page.test.mjs
 *
 * The page's look is target-only; this guards the wiring so the client-facing editor can't
 * silently regress: it reads/writes the A303 endpoint, offers the vetted palette + a
 * legibility-guarded custom colour, resizes the logo to the 250 KB cap, and is reachable.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop the api.put('/api/business/branding') call → "saves via the A303 endpoint" fails
 *   - remove the legibility guard                     → "custom accent is legibility-guarded" fails
 *   - unregister the tab/route                        → "reachable from Business settings" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const tab  = r('apps/dashboard/src/pages/settings/BrandingTab.tsx');
const app  = r('apps/dashboard/src/App.tsx');
const biz  = r('apps/dashboard/src/pages/settings/BusinessPage.tsx');

ok('reads current branding (A303 GET)', /api\.get<[^>]*>\('\/api\/business\/branding'\)/.test(tab) || /api\.get\([^)]*'\/api\/business\/branding'/.test(tab));
ok('saves via the A303 endpoint (PUT)', /api\.put\('\/api\/business\/branding'/.test(tab));
ok('offers the vetted palette (8 accents)', /const PALETTE/.test(tab) && (tab.match(/hex:\s*'#/g) || []).length >= 8);
ok('custom accent is legibility-guarded', /function isLegible/.test(tab) && /ratio\(/.test(tab) && /LOCK_SURFACE/.test(tab));
ok('logo resized to the 250 KB cap (shrink, PNG)', /MAX_LOGO_BYTES\s*=\s*250\s*\*\s*1024/.test(tab) && /toDataURL\('image\/png'\)/.test(tab) && /svg/i.test(tab));
ok('has a live lock-screen preview', /function LockPreview/.test(tab) && /<LockPreview/.test(tab));
ok('reachable from Business settings (route + tab)',
   /import\('\.\/pages\/settings\/BrandingTab'\)/.test(app) && /path="branding"\s+element=\{<BrandingTab/.test(app) && /to:\s*'branding'/.test(biz));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
