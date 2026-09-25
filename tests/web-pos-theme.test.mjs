/**
 * web-pos-theme.test.mjs — A328 (client branding Phase 2, slice 4b-1): the web POS + shared components follow the
 * business's action theme, only when its themes are on, and every existing button label stays readable in dark AND
 * light mode.
 *
 *   node tests/web-pos-theme.test.mjs
 *
 * On the bench (Chromium, the dashboard's REAL compiled CSS, transitions off in the test page): themes OFF → all 9
 * action utilities identical to their green originals in dark AND light; all 7 themes × both modes → labels and links
 * ≥ 4.5:1 (worst 4.75). CI has no browser: this RUNS the same contrast proof from the dashboard's own themes.ts and pins
 * what produces the rest.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - white-label fills mapped to the theme's 600 instead of 700   → "white labels on 600 fills" fails (5 of 7 themes)
 *   - links use 400 in light mode too                              → "links in light mode" fails
 *   - vars applied when themes are off                             → "themes OFF sets nothing" fails
 *   - a default in index.css changed                               → "defaults are Tailwind's exact greens" fails
 *   - drop the aliases' teal default                               → "aliases default to SwiftPOS teal" fails
 *   - Charge back to raw '#22c55e'                                 → "Charge … theme's 500" + the 94 count fail
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A328_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A328_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const D = (p) => fs.readFileSync(path.join(ROOT, 'apps/dashboard', p), 'utf8');
  let pass = 0, fail = 0;
  const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

  const T = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/themes.ts')).href);
  const vars = D('src/lib/themeVars.ts');

  // ── The shade per job, as the dashboard maps it (read from themeVars.ts, then proven for every theme) ──
  const map = Object.fromEntries([...vars.matchAll(/'(action-[tdl]-\d{3})': channels\(k\.(\w+)\)/g)].map((m) => [m[1], m[2]]));
  ok('500 fills (dark labels) take the theme\'s fillDark; 600 fills (white labels) its pressedLight; links textDark / textLight',
    map['action-t-500'] === 'fillDark' && map['action-t-600'] === 'pressedLight' && map['action-d-400'] === 'textDark' && map['action-l-400'] === 'textLight',
    JSON.stringify(map));
  const worst = { dark500: 99, white600: 99, linkDark: 99, linkLight: 99 };
  for (const t of T.THEMES) {
    const k = T.themeTokens(t);
    const at = (name) => k[map[name]];
    worst.dark500 = Math.min(worst.dark500, T.contrast('#000000', at('action-t-500')), T.contrast('#030712', at('action-t-500')));
    worst.white600 = Math.min(worst.white600, T.contrast('#ffffff', at('action-t-600')));
    worst.linkDark = Math.min(worst.linkDark, T.contrast(at('action-d-400'), '#030712'), T.contrast(at('action-d-400'), '#111827'));
    worst.linkLight = Math.min(worst.linkLight, T.contrast(at('action-l-400'), '#ffffff'), T.contrast(at('action-l-400'), '#f9fafb'));
  }
  ok(`dark labels (black / gray-950) on 500 fills ≥ 4.5 for all seven themes (worst ${worst.dark500.toFixed(2)})`, worst.dark500 >= 4.5);
  ok(`white labels on 600 fills ≥ 4.5 for all seven themes (worst ${worst.white600.toFixed(2)})`, worst.white600 >= 4.5);
  ok(`links in dark mode ≥ 4.5 on the dark panels (worst ${worst.linkDark.toFixed(2)})`, worst.linkDark >= 4.5);
  ok(`links in light mode ≥ 4.5 on white (worst ${worst.linkLight.toFixed(2)})`, worst.linkLight >= 4.5);

  // ── Only with themes on ──
  ok('themes OFF sets no variables (the index.css defaults — SwiftPOS teal since A329 — apply)', /if \(!b \|\| b\.themes_enabled !== true\) return null;/.test(vars));
  ok('an unknown or unchosen theme resolves to the default', /themeTokens\(resolveTheme\(b\.theme_id \?\? null\)\)/.test(vars));

  // ── The stylesheet: defaults = Tailwind green, links switch shade with the mode ──
  const css = D('src/index.css');
  ok('defaults are SwiftPOS teal (A329): 400 #2dd4bf dark / #0f766e light, 500 #14b8a6, 600 #0f766e',
    /--action-400: var\(--action-d-400, 45 212 191\);/.test(css) && /--action-500: var\(--action-t-500, 20 184 166\);/.test(css)
    && /--action-600: var\(--action-t-600, 15 118 110\);/.test(css) && /:root:not\(\.dark\) \{\s*--action-400: var\(--action-l-400, 15 118 110\);/.test(css));
  ok('light mode keeps the themed focus border (as it does for the green one)', /:root:not\(\.dark\) \.focus\\:border-action-500:focus \{ border-color: rgb\(var\(--action-500\)\) !important; \}/.test(css));
  ok('Tailwind\'s action colours read the variables', /400: 'rgb\(var\(--action-400\) \/ <alpha-value>\)'/.test(D('tailwind.config.js')));

  // ── Wiring ──
  const layer = D('src/components/ThemeLayer.tsx');
  ok('the theme layer reads the business\'s branding, re-reads on business change and after a Branding save',
    /api\.get<BrandingForTheme \| null>\('\/api\/business\/branding'\)/.test(layer) && /\}, \[businessId\]\);/.test(layer)
    && /window\.addEventListener\(BRANDING_SAVED_EVENT, load\);/.test(layer));
  ok('…and is mounted once, inside BusinessProvider', /<BusinessProvider>\s*<ThemeLayer \/>/.test(D('src/App.tsx')));
  ok('Branding fires the saved event after Save and after Reset', (D('src/pages/settings/BrandingTab.tsx').match(/window\.dispatchEvent\(new Event\(BRANDING_SAVED_EVENT\)\)/g) || []).length === 2);

  // ── Part 2: the web POS's INLINE colours (docs/A328-web-pos-inline-colours.md) ──
  // Bench: Chromium, 94 rewritten uses × 4 contexts (dashboard dark/light, POS toggle dark/light): themes OFF identical to
  // each use's original; 7 themes: white labels ≥ 5.36, dark labels ≥ 4.96, text ≥ 5.36.
  ok('the inline aliases default to SwiftPOS teal (A329) — green and blue primaries alike are teal with themes OFF',
    /:root \{ --act-fill: var\(--action-t-500, 20 184 166\); --act-strong: var\(--action-t-600, 15 118 110\); --act-text: var\(--action-d-400, 45 212 191\); \}/.test(css));
  ok('the web POS\'s own light/dark toggle drives the text shade (aliases AND the part-1 link token)',
    /\[data-pos-theme="light"\] \{ --act-text: var\(--action-l-400, 15 118 110\); --action-400: var\(--action-l-400, 15 118 110\); \}/.test(css)
    && /\[data-pos-theme="dark"\]  \{ --act-text: var\(--action-d-400, 45 212 191\);/.test(css));
  const posDir = path.join(ROOT, 'apps/dashboard/src/pages/pos');
  const posSrc = fs.readdirSync(posDir).filter((f) => /\.tsx?$/.test(f)).map((f) => fs.readFileSync(path.join(posDir, f), 'utf8')).join('\n');
  const themedUses = (posSrc.match(/var\(--act-(?:fill|strong|text),/g) || []).length;
  ok(`94 inline uses take the theme (found ${themedUses})`, themedUses === 94);
  const cs = fs.readFileSync(path.join(posDir, 'CashierScreen.tsx'), 'utf8');
  ok('Charge (dark label) is the theme\'s 500 (the per-use fallback is its original green; the alias default is teal)', /chargeBtn: \{[\s\S]{0,120}background: 'rgb\(var\(--act-fill, 34 197 94\)\)'/.test(cs));
  ok('Open Table / modal confirm (white label) is the theme\'s 700 (per-use fallback its original blue; alias default teal)', /modalConfirm: \{[\s\S]{0,120}background: 'rgb\(var\(--act-strong, 59 130 246\)\)'/.test(cs));
  const mm = fs.readFileSync(path.join(posDir, 'MinimartPOS.tsx'), 'utf8');
  ok('Minimart Charge keeps its gradient, in the theme\'s strong shade', /linear-gradient\(135deg, rgb\(var\(--act-strong, 29 78 216\)\) 0%, rgb\(var\(--act-strong, 37 99 235\)\) 100%\)/.test(mm));
  ok('prices stay their own green (money is never themed)', /productPrice: \{ fontSize: 11, color: '#22c55e'/.test(cs));
  ok('M-Pesa keeps its own green', /#(?:22c55e|16a34a|4ade80)/i.test(fs.readFileSync(path.join(posDir, 'MpesaStkPanel.tsx'), 'utf8')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
