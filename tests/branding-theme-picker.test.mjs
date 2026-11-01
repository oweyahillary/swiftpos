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
 * A617 (owner, 2026-11-01: "basic themes for everyone, the rest premium"): the picker is shown to every business — ZapTill
 * default, Ocean, Teal and Sky free; the other themes locked "Premium" without themes.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - send theme_id even when themes are off and unchanged  → "Save sends theme_id with themes, or …" fails
 *   - unlock every tile (drop the locked rule)             → "the picker is shown to every business … locked" fails
 *   - lock preview ignores the theme when there's no brand  → "lock preview wears the theme without a brand colour" fails
 *   - Reset stops clearing the theme                       → "Reset clears the theme too" fails
 *   - selected tile back to ring-gray-900 (light-first)    → the two dark-mode selection checks fail
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
// A617 (owner, 2026-11-01: "basic themes for everyone, the rest premium"): without themes, a free theme or none.
ok('the theme resolves through the registry with themes, or (A617) a free theme without them',
  /const theme: Theme \| null = themesEnabled \|\| isFreeThemeId\(themeId\) \? resolveTheme\(themeId\) : null;/.test(tab));

// ── What the page shows ──
ok('A617: the picker is shown to every business, listing the registry themes; without themes the others are locked "Premium"',
  /\{\/\* ── App theme \(A327\)[\s\S]{0,300}?\*\/\}\s*<Section title="App theme"/.test(tab) && /\{THEMES\.map\(\(t\) => \{/.test(tab)
  && /const locked = !themesEnabled && !isFreeThemeId\(t\.id\);/.test(tab) && /disabled=\{locked\}/.test(tab) && /\{locked && <span[^>]*>Premium<\/span>\}/.test(tab));
ok('A617: without themes, a "ZapTill default" choice (null: the default look) and the note naming the free themes from the one list',
  /\{!themesEnabled && \(\s*\/\/[^\n]*\n\s*<button[^>]*onClick=\{\(\) => setThemeId\(null\)\} data-testid="theme-default"/.test(tab)
  && /const freeThemeNames = THEMES\.filter\(\(t\) => isFreeThemeId\(t\.id\)\)/.test(tab) && /ZapTill default and \{freeThemeNames\} are free/.test(tab));
ok('the till preview appears with a theme (A605: in the App theme section, while no primary colour — worn only with themes — replaces it)',
  /\{theme && !primaryWorn && \(<div>\s*<TillPreview theme=\{theme\}/.test(tab) && /const primaryWorn = themesEnabled \? primaryHex : null;/.test(tab));
ok('lock preview wears the theme without a brand colour (the PinPage rule of the POS); otherwise the Phase 1 accent',
  /const lockAccent = theme && accentHex\.trim\(\) === '' \? theme\.shades\[500\] : shownAccent;/.test(tab) && /<LockPreview accent=\{lockShown\}/.test(tab)
  // A597 / A605: with brand colours (only with themes, A617) and no accent, the primary's shade seen on the lock screen.
  && /const lockShown = theme && accentHex\.trim\(\) === '' && brandPalette\(primaryWorn\) \? brandPalette\(primaryWorn\)!\.layer : lockAccent;/.test(tab));
ok('the till preview draws action from the theme tokens and the strip/sidebar from the brand layer',
  // A597: a primary brand colour's shades replace the theme tokens; the accent still makes the brand layer.
  /const k = p \? \{[^}]*\} : themeTokens\(theme\);/.test(tab) && /const accent = resolveBrandLayer\(brandHex\);/.test(tab)
  && /background: brand \? brand\.tint : k\.tint/.test(tab));
ok('…and keeps money and Paid green in the preview', /\{money\(p\)\}/.test(tab) && /color: '#4ade80'/.test(tab) && />Paid</.test(tab));
ok('the suggestion comes from the shared pairing rule', /const suggested = themesEnabled \? suggestThemeFor\(accentHex\.trim\(\) \|\| null\) : null;/.test(tab));

// ── Selection must read in DARK mode (the dashboard's default) as well as light ──
// The first build marked the selected tile with ring-gray-900 — invisible on the dark-first dashboard, where the
// unselected tiles' gray-200 border rendered bright (owner's screenshots, 2026-09-24). Now: the theme's own colour.
ok('the selected tile is marked with the theme\'s OWN colour (border + ring) and a tick — mode-independent',
  /style=\{on \? \{ borderColor: t\.shades\[500\], boxShadow: `0 0 0 2px \$\{t\.shades\[500\]\}` \} : undefined\}/.test(tab)
  && /\{on && <span[^>]*style=\{\{ color: t\.shades\[500\] \}\}[^>]*>✓<\/span>\}/.test(tab));
ok('no light-first grey selection ring is left on the picker', !/ring-gray-900/.test(tab) && !/border-gray-900 ring-1/.test(tab));
ok('theme names use the dark-first readable text class (text-gray-300, remapped in light mode)', /<span className="font-medium text-gray-300">\{t\.name\}<\/span>/.test(tab));

// ── What the page sends ──
ok('Save sends theme_id with themes, or (A617) without them only when the owner changed it (a free theme or the default)',
  /\.\.\.\(sendTheme \? \{ theme_id: theme\?\.id \?\? null \} : \{\}\),/.test(tab) && /const sendTheme = themesEnabled \|\| themeId !== saved\?\.themeId;/.test(tab));
ok('Reset clears the theme too (A617: null is always allowed)',   // A597: + the colours, when the owner may set them
  /receipt_logo_enabled: false, theme_id: null,/.test(tab) && /setThemeId\(null\);/.test(tab));

// ── The rule the page relies on, run from the dashboard's own copy ──
const T = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/themes.ts')).href);
ok('the dashboard\'s themes.ts offers the seven approved themes', T.THEMES.map((t) => t.id).join() === 'ocean,violet,lagoon,orchid,sky,teal,blossom');
ok('a yellow brand is suggested Sky; red → Lagoon; no brand → no suggestion',
  T.suggestThemeFor('#F5B800') === 'sky' && T.suggestThemeFor('#DC2626') === 'lagoon' && T.suggestThemeFor(null) === null);
ok('nothing chosen resolves to Ocean — what the page shows selected and the cloud serves', T.resolveTheme(null).id === 'ocean');
ok('A617: the dashboard\'s copy names the free themes Ocean, Teal and Sky', T.FREE_THEME_IDS.join() === 'ocean,teal,sky'
  && T.THEMES.filter((t) => T.isFreeThemeId(t.id)).map((t) => t.name).join(', ') === 'Ocean, Sky, Teal');

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not process.exit(): on Windows, forcing an exit while stdout is still closing can crash Node's event loop
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", owner's run of delivery -j, after all checks passed).
process.exitCode = fail ? 1 : 0;
