// A326 (client branding Phase 2, slice 3) — the till's colours follow the business's theme, and ONLY when themes are on.
//
//   node test/theme-vars.test.mjs
//
// Runs the REAL src/renderer/lib/themeVars.ts (bundled with the repo's esbuild) and compiles the REAL stylesheet
// (index.css + tailwind.config.js, with the repo's tailwindcss) — no browser needed. The pixel comparison (every
// action/brand utility renders exactly its green original with themes off) was made in Chromium on the bench and is
// recorded in the manifest; this file pins what makes it true.
//
// MUTATIONS TO CONFIRM BITE:
//   - computeThemeVars returns vars with themes OFF          → "themes OFF → nothing overridden" fails
//   - change a default in index.css (e.g. --action-500)      → "defaults are Tailwind's exact greens" fails
//   - point the action scale at a fixed colour in the config  → "the compiled CSS reads the variables" fails
//   - drop the brand fallback to the theme                    → "no brand colour → the lock curtain uses the theme" fails
//   - App stops re-reading on catalogue:changed               → "re-applied on every landed pull" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a326-'));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

// ── the real themeVars.ts ──
const esbuild = require('esbuild');
esbuild.buildSync({ entryPoints: [path.join(desktop, 'src/renderer/lib/themeVars.ts')], bundle: true, format: 'esm',
  outfile: path.join(tmp, 'themeVars.mjs'), logLevel: 'silent' });
const T = await import(pathToFileURL(path.join(tmp, 'themeVars.mjs')).href);

console.log('A326 — till theme variables\n');
ok('themes OFF (no theme id) → nothing overridden: today\'s look', T.computeThemeVars({ themeId: null, accentHex: '#F5B800' }) === null
  && T.computeThemeVars(null) === null);

const oy = T.computeThemeVars({ themeId: 'ocean', accentHex: '#F5B800' });
ok('Ocean → the action colours are Ocean\'s fixed shades', oy.vars['action-500'] === '59 130 246' && oy.vars['action-400'] === '96 165 250'
  && oy.vars['action-600'] === '37 99 235' && oy.vars['action-700'] === '29 78 216', JSON.stringify(oy.vars));
ok('a yellow brand colour → the lock curtain is yellow, with BLACK text on it', oy.vars['brand-600'] === '245 184 0' && oy.vars['on-brand'] === '0 0 0');
ok('…a brand strip in that yellow, and a yellow-tinted sidebar that keeps its text readable', oy.strip === '#F5B800' && /^#[0-9a-f]{6}$/i.test(oy.vars['sidebar-tint']));

const redb = T.computeThemeVars({ themeId: 'lagoon', accentHex: '#DC2626' });
ok('a red brand colour → WHITE text on the lock curtain (black would not read)', redb.vars['on-brand'] === '255 255 255');

const nob = T.computeThemeVars({ themeId: 'violet', accentHex: null });
ok('no brand colour → the lock curtain uses the theme (Violet 500), and no strip', nob.vars['brand-600'] === '139 92 246' && nob.strip === null);
ok('…and the sidebar takes the theme\'s tint', nob.vars['sidebar-tint'] === '#2e1065');
const navy = T.computeThemeVars({ themeId: 'sky', accentHex: '#1E3A8A' });
ok('a brand colour too dark to see → falls back to the theme, no strip', navy.vars['brand-600'] === '14 165 233' && navy.strip === null);
ok('an unknown theme id → the default (Ocean), never nothing', T.computeThemeVars({ themeId: 'crimson' }).vars['action-500'] === '59 130 246');

// applyThemeVars on a stand-in root: set when ON, and EVERY variable removed when OFF.
const store = new Map();
const root = { style: { setProperty: (k, v) => store.set(k, v), removeProperty: (k) => store.delete(k) } };
T.applyThemeVars(oy, root);
ok('applying a theme sets every variable on <html>', store.size === T.THEME_VAR_NAMES.length && store.get('--action-500') === '59 130 246');
T.applyThemeVars(null, root);
ok('switching themes OFF removes them all (the defaults take over again)', store.size === 0);

// ── the real stylesheet ──
const css = fs.readFileSync(path.join(desktop, 'src/renderer/index.css'), 'utf8');
const want = { 'action-300': '134 239 172', 'action-400': '74 222 128', 'action-500': '34 197 94', 'action-600': '22 163 74',
  'action-700': '21 128 61', 'action-900': '20 83 45', 'brand-400': '74 222 128', 'brand-500': '34 197 94',
  'brand-600': '22 163 74', 'brand-700': '21 128 61', 'on-brand': '255 255 255' };
const wrong = Object.entries(want).filter(([k, v]) => !new RegExp(`--${k}:\\s*${v};`).test(css)).map(([k]) => k);
ok('defaults are Tailwind\'s exact greens (and white text on the curtain) — so OFF is unchanged', wrong.length === 0, wrong.join(','));

const out = path.join(tmp, 'till.css');
// Run Tailwind's own JS entry point with THIS node — not node_modules/.bin/tailwindcss, which on Windows is a .cmd
// that Node cannot spawn without a shell (the owner's run of delivery -f: "spawnSync …\\.bin\\tailwindcss ENOENT").
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(desktop, 'tailwind.config.js'),
  '-i', path.join(desktop, 'src/renderer/index.css'), '-o', out], { stdio: 'ignore' });
const built = fs.readFileSync(out, 'utf8');
ok('the compiled CSS reads the variables (bg-action-500, text-action-400, bg-brand-600, text-on-brand)',
  /\.bg-action-500\s*\{[^}]*var\(--action-500\)/.test(built) && /\.text-action-400\s*\{[^}]*var\(--action-400\)/.test(built)
  && /\.bg-brand-600\s*\{[^}]*var\(--brand-600\)/.test(built) && /\.text-on-brand\s*\{[^}]*var\(--on-brand\)/.test(built));
ok('opacity modifiers still work on the themed colours (bg-action-500/10)', /\.bg-action-500\\\/10\s*\{[^}]*var\(--action-500\)\s*\/\s*0\.1/.test(built));

// ── the wiring ──
const src = (p) => fs.readFileSync(path.join(desktop, 'src/renderer', p), 'utf8');
const app = src('App.tsx');
ok('App applies the theme on every screen, re-applied on every landed pull',
  /applyThemeVars\(t\);/.test(app) && /posApi\.pos\.onCatalogueChanged\(load\)/.test(app) && /computeThemeVars\(b \? \{ themeId: b\.themeId \?\? null, accentHex: b\.accentHex \} : null\)/.test(app));
ok('…and shows the brand strip on the POS and Manager screens', (app.match(/\{strip\}/g) || []).length === 2);
ok('the Manager sidebar tint falls back to its own gray-900 (OFF unchanged)', /backgroundColor: 'var\(--sidebar-tint, #111827\)'/.test(src('pages/ManagerPage.tsx')));
ok('the lock curtain\'s Enter text follows the brand colour', /bg-brand-600 text-on-brand/.test(src('components/LockCurtain.tsx')));
ok('the PIN screen uses the theme when there is no brand colour (and nothing changes when themes are off)',
  /b\?\.accentHex \?\? \(b\?\.themeId \? resolveTheme\(b\.themeId\)\.shades\[500\] : null\)/.test(src('pages/PinPage.tsx')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
