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
  ok('themes OFF sets nothing (the defaults are today\'s green)', /if \(!b \|\| b\.themes_enabled !== true\) return null;/.test(vars));
  ok('an unknown or unchosen theme resolves to the default', /themeTokens\(resolveTheme\(b\.theme_id \?\? null\)\)/.test(vars));

  // ── The stylesheet: defaults = Tailwind green, links switch shade with the mode ──
  const css = D('src/index.css');
  ok('defaults are Tailwind\'s exact greens (400 / 500 / 600), in both modes',
    /--action-400: var\(--action-d-400, 74 222 128\);/.test(css) && /--action-500: var\(--action-t-500, 34 197 94\);/.test(css)
    && /--action-600: var\(--action-t-600, 22 163 74\);/.test(css) && /:root:not\(\.dark\) \{\s*--action-400: var\(--action-l-400, 74 222 128\);/.test(css));
  ok('light mode keeps the themed focus border (as it does for the green one)', /:root:not\(\.dark\) \.focus\\:border-action-500:focus \{ border-color: rgb\(var\(--action-500\)\) !important; \}/.test(css));
  ok('Tailwind\'s action colours read the variables', /400: 'rgb\(var\(--action-400\) \/ <alpha-value>\)'/.test(D('tailwind.config.js')));

  // ── Wiring ──
  const layer = D('src/components/ThemeLayer.tsx');
  ok('the theme layer reads the business\'s branding, re-reads on business change and after a Branding save',
    /api\.get<BrandingForTheme \| null>\('\/api\/business\/branding'\)/.test(layer) && /\}, \[businessId\]\);/.test(layer)
    && /window\.addEventListener\(BRANDING_SAVED_EVENT, load\);/.test(layer));
  ok('…and is mounted once, inside BusinessProvider', /<BusinessProvider>\s*<ThemeLayer \/>/.test(D('src/App.tsx')));
  ok('Branding fires the saved event after Save and after Reset', (D('src/pages/settings/BrandingTab.tsx').match(/window\.dispatchEvent\(new Event\(BRANDING_SAVED_EVENT\)\)/g) || []).length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
