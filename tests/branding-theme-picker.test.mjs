/**
 * branding-theme-picker.test.mjs — A327 (client branding Phase 2, slice 4): the web Branding page lets a business
 * with themes pick its action theme, previews it exactly as the till draws it, and saves it — and changes nothing
 * for a business without themes.
 *
 *   node tests/branding-theme-picker.test.mjs
 *
 * Behaviour was driven in headless Chromium on the bench against the REAL BrandingTab with the cloud mocked (15/15,
 * recorded in the manifest): themes off → no picker, no till preview, no theme_id sent; on → Ocean shown selected,
 * previews follow the pick, Save sends theme_id, Reset sends null; a yellow brand keeps its yellow and suggests Sky.
 * CI has no browser, so this pins what produces that, and RUNS the pairing rule from the dashboard's own themes.ts.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - send theme_id even when themes are off               → "only sent when the business has themes" fails
 *   - show the picker unconditionally                      → "the picker appears only with themes" fails
 *   - lock preview ignores the theme when there's no brand  → "lock preview wears the theme without a brand colour" fails
 *   - Reset stops clearing the theme                       → "Reset clears the theme too" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node >= 23.6 runs .ts natively; older Node needs the flag. Re-run self rather than skip.
const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A327_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A327_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tab = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/settings/BrandingTab.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

// ── Loading ──
ok('reads theme_id and themes_enabled from GET /api/business/branding',
  /setThemesEnabled\(b\?\.themes_enabled === true\); setThemeId\(b\?\.theme_id \?\? null\);/.test(tab));
ok('the theme resolves through the registry only when the business has themes',
  /const theme: Theme \| null = themesEnabled \? resolveTheme\(themeId\) : null;/.test(tab));

// ── What the page shows ──
ok('the picker appears only with themes, listing the registry\'s themes',
  /\{themesEnabled && \(\s*<div className="mt-6">\s*<label[^>]*>App theme<\/label>/.test(tab) && /\{THEMES\.map\(\(t\) => \{/.test(tab));
ok('the till preview appears only with themes', /\{theme && \(<>\s*<label[^>]*>Till preview<\/label>\s*<TillPreview theme=\{theme\}/.test(tab));
ok('lock preview wears the theme without a brand colour (the till\'s PinPage rule); otherwise the Phase 1 accent',
  /const lockAccent = theme && accentHex\.trim\(\) === '' \? theme\.shades\[500\] : shownAccent;/.test(tab) && /<LockPreview accent=\{lockAccent\}/.test(tab));
ok('the till preview draws action from the theme tokens and the strip/sidebar from the brand layer',
  /const k = themeTokens\(theme\);/.test(tab) && /const brand = resolveBrandLayer\(brandHex\);/.test(tab)
  && /background: brand \? brand\.tint : k\.tint/.test(tab));
ok('…and keeps money and Paid green in the preview', /KES \{p\}/.test(tab) && /color: '#4ade80'/.test(tab) && />Paid</.test(tab));
ok('the suggestion comes from the shared pairing rule', /const suggested = themesEnabled \? suggestThemeFor\(accentHex\.trim\(\) \|\| null\) : null;/.test(tab));

// ── What the page sends ──
ok('Save sends theme_id only when the business has themes (the cloud refuses it otherwise — A325)',
  /\.\.\.\(themesEnabled \? \{ theme_id: theme\?\.id \?\? null \} : \{\}\),/.test(tab));
ok('Reset clears the theme too (only when the business has themes)',
  /receipt_logo_enabled: false, \.\.\.\(themesEnabled \? \{ theme_id: null \} : \{\}\) \}\);/.test(tab) && /setThemeId\(null\);/.test(tab));

// ── The rule the page relies on, run from the dashboard's own copy ──
const T = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/themes.ts')).href);
ok('the dashboard\'s themes.ts offers the seven approved themes', T.THEMES.map((t) => t.id).join() === 'ocean,violet,lagoon,orchid,sky,teal,blossom');
ok('a yellow brand is suggested Sky; red → Lagoon; no brand → no suggestion',
  T.suggestThemeFor('#F5B800') === 'sky' && T.suggestThemeFor('#DC2626') === 'lagoon' && T.suggestThemeFor(null) === null);
ok('nothing chosen resolves to Ocean — what the page shows selected and the cloud serves', T.resolveTheme(null).id === 'ocean');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
