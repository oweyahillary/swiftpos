/**
 * theme-access.test.mjs — A325 (Phase 2 slice 2): what the cloud tells tills about themes, and what it accepts.
 *
 *   node tests/theme-access.test.mjs      (needs the server built: run-all builds it first; CI builds before tests)
 *
 * Runs the REAL rules from the built server (apps/server/dist/lib/themeRules.js — pure, no database), then pins the
 * three routes that use them, and the catalogue-version list (a flag flip must reach tills in ~20 s, not 10 min).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - effectiveThemeId ignores the flag                          → "themes OFF → null" fails
 *   - themeWriteError lets a theme be chosen with the flag off    → "choosing needs the flag" fails
 *   - drop latest('feature_flags', …) from catalogue-version      → "a flag flip moves the catalogue version" fails
 *   - serve themeId inside `branding` instead of top-level        → "served top-level" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

const dist = path.join(ROOT, 'apps/server/dist/lib/themeRules.js');
if (!existsSync(dist)) {
  if (process.env.CI) { console.log('FAIL  server dist missing in CI — this test would silently not run'); process.exit(1); }
  console.log('SKIP  build the server first (cd apps/server && npm run build)'); process.exit(0);
}
const R = await import(pathToFileURL(dist).href);

// ── What tills are told ──
ok('themes OFF → null, whatever is stored (the till keeps today\'s look)', R.effectiveThemeId(false, 'violet') === null && R.effectiveThemeId(false, null) === null);
ok('themes ON + a chosen theme → that theme', R.effectiveThemeId(true, 'violet') === 'violet');
ok('themes ON + nothing chosen → Ocean (the default)', R.effectiveThemeId(true, null) === 'ocean' && R.effectiveThemeId(true, undefined) === 'ocean');
ok('themes ON + an unknown or retired id → Ocean, never nothing', R.effectiveThemeId(true, 'emerald') === 'ocean' && R.effectiveThemeId(true, 42) === 'ocean');
ok('the flag key is "themes"', R.THEMES_FLAG === 'themes');

// ── What a branding write may set ──
ok('null clears the theme — always allowed, flag or not', R.themeWriteError(null, false) === null && R.themeWriteError(null, true) === null);
ok('choosing a theme needs the business\'s flag', /not enabled/.test(R.themeWriteError('violet', false) ?? ''));
ok('with the flag, a curated theme is accepted', R.themeWriteError('violet', true) === null && R.themeWriteError('blossom', true) === null);
ok('a non-curated id is refused — even with the flag (Emerald was rejected for looking like "paid")',
  /curated/.test(R.themeWriteError('emerald', true) ?? '') && /curated/.test(R.themeWriteError('Ocean', true) ?? '') && /curated/.test(R.themeWriteError(7, true) ?? ''));

// ── The routes use exactly these rules ──
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pos = src('apps/server/src/routes/pos.ts');
ok('/pos/init computes themeId with effectiveThemeId + the flag',
  /const themeId = effectiveThemeId\(await themesEnabled\(req\.businessId\), branding\?\.theme_id\);/.test(pos));
ok('…served top-level, NOT inside `branding` (a business may have themes without a branding row)',
  /\n    themeId,\n    receiptHeader:/.test(pos) && !/branding: branding \? \{[^}]*themeId/.test(pos));
ok('…and theme_id is selected with the branding row', /select\('accent_hex, logo_png, logo_receipt, receipt_logo_enabled, theme_id'\)/.test(pos));
ok('a flag flip moves the catalogue version (tills see it within the 20-s check)',
  /latest\('business_branding', 'business_id', biz\),[\s\S]{0,300}latest\('feature_flags', 'business_id', biz\),/.test(pos));
const biz = src('apps/server/src/routes/business.ts');
ok('PUT /branding validates theme_id through themeWriteError and the flag',
  /if \(has\('theme_id'\)\) \{[\s\S]{0,300}themeWriteError\(req\.body\.theme_id, await themesEnabled\(req\.businessId\)\)/.test(biz));
ok('GET /branding returns theme_id and themes_enabled (the web shows the picker only with the flag)',
  /theme_id, updated_at'\)/.test(biz) && /themes_enabled: enabled/.test(biz));
ok('the cloud\'s themes.ts copy is under the shared-sync gate', /'apps\/server\/src\/lib\/themes\.ts'/.test(src('scripts/check-shared-sync.mjs')));
ok('the till is required to be on schema 54', /export const REQUIRED_DESKTOP_SCHEMA = 54;/.test(src('apps/server/src/lib/desktopSchema.ts')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
