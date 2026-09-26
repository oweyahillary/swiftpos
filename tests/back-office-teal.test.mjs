/**
 * back-office-teal.test.mjs — A329 step 3: the back office's actions are a FIXED SwiftPOS teal (`swift-*`), never the
 * client's theme, and every label on them stays readable in dark AND light mode.
 *
 *   node tests/back-office-teal.test.mjs
 *
 * RUNS, not pins, wherever it can: the contrast proofs read the token values from the dashboard's own index.css and
 * the light-mode surfaces it paints, and use the dashboard's contrast() (lib/themes.ts); the label check walks every
 * back-office source file and pairs each teal fill with the label in the same class string. On the bench (not in CI —
 * no browser there) the same classes were checked in Chromium on the real compiled CSS, dark and light.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - --swift-strong set to teal 500 (20 184 166)                      → "white labels on swift-strong" fails (2.49)
 *   - the :root:not(.dark) switch for --swift-text removed            → "text on the light-mode surfaces" fails (2.0)
 *   - a white-label button's bg-swift-strong changed to bg-swift       → "every bg-swift carries a dark label" fails, names it
 *   - the focus rule moved back inside @layer base                     → "focus rule outside @layer base" fails
 *   - the Branding palette gets a second #0d9488                       → "palette: 8 distinct colours" fails
 *   - the light-mode "white stays white on swift-strong" rule removed  → "light mode keeps white labels white" fails
 *     (in Chromium: slate on teal 700 = 3.26:1, 2.35 on hover — measured on the bench)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A329_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A329_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const DASH = path.join(ROOT, 'apps/dashboard');
  const read = (p) => fs.readFileSync(path.join(DASH, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

  const { contrast } = await import(pathToFileURL(path.join(DASH, 'src/lib/themes.ts')).href);
  const css = read('src/index.css');
  const hex = (ch) => '#' + ch.trim().split(/\s+/).map((n) => (+n).toString(16).padStart(2, '0')).join('');

  // ── Token values, from index.css (the one place they live) ──
  const block = (sel) => { const m = css.match(new RegExp(sel.replace(/[().:]/g, '\\$&') + '\\s*\\{([^}]*--swift[^}]*)\\}')); return m ? m[1] : ''; };
  const vars = (text) => Object.fromEntries([...text.matchAll(/--(swift[\w-]*):\s*([\d ]+);/g)].map((m) => [m[1], hex(m[2])]));
  const D = vars(block(':root'));
  const Lm = { ...D, ...vars(block(':root:not(.dark)')) };
  ok('index.css defines all seven swift tokens', ['swift', 'swift-light', 'swift-strong', 'swift-deep', 'swift-logo', 'swift-text', 'swift-text-hover'].every((k) => D[k]), JSON.stringify(D));
  ok('fills are the same in both modes; only the text tokens switch',
    ['swift', 'swift-light', 'swift-strong', 'swift-deep', 'swift-logo'].every((k) => Lm[k] === D[k]) && Lm['swift-text'] !== D['swift-text'] && Lm['swift-text-hover'] !== D['swift-text-hover']);
  ok('SwiftPOS teal, by job (teal 500 / 400 / 700 / 800, the logo #0d9488)',
    D.swift === '#14b8a6' && D['swift-light'] === '#2dd4bf' && D['swift-strong'] === '#0f766e' && D['swift-deep'] === '#115e59' && D['swift-logo'] === '#0d9488', JSON.stringify(D));

  const cfg = read('tailwind.config.js');
  ok('tailwind: every swift-* class reads its variable',
    [['DEFAULT', 'swift'], ['light', 'swift-light'], ['strong', 'swift-strong'], ['deep', 'swift-deep'], ['logo', 'swift-logo'], ['text', 'swift-text'], ["'text-hover'", 'swift-text-hover']]
      .every(([k, v]) => new RegExp(`${k.replace(/'/g, "'")}:\\s*'rgb\\(var\\(--${v}\\) / <alpha-value>\\)'`).test(cfg)));

  // ── Contrast, per job ──
  const DARK_LABELS = ['#000000', '#030712'];                                 // text-black, text-gray-950
  const DARK_SURF = ['#030712', '#111827', '#1f2937'];                        // gray-950 / 900 / 800
  const LIGHT_SURF = [...css.matchAll(/:root:not\(\.dark\) \.bg-gray-(?:950|900|800)\s*\{\s*background-color:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
  const min = (fg, bgs) => Math.min(...bgs.map((b) => contrast(fg, b)));
  const minL = (fgs, bg) => Math.min(...fgs.map((f) => contrast(f, bg)));
  ok(`light-mode surfaces read from index.css (${LIGHT_SURF.join(', ')})`, LIGHT_SURF.length === 3);
  const r = {
    dark500: minL(DARK_LABELS, D.swift), dark400: minL(DARK_LABELS, D['swift-light']),
    white700: contrast('#ffffff', D['swift-strong']), white800: contrast('#ffffff', D['swift-deep']),
    textDark: min(D['swift-text'], DARK_SURF), hoverDark: min(D['swift-text-hover'], DARK_SURF),
    textLight: min(Lm['swift-text'], LIGHT_SURF), hoverLight: min(Lm['swift-text-hover'], LIGHT_SURF),
    logo: contrast('#0f172a', D['swift-logo']), label100: contrast('#ccfbf1', D['swift-strong']),
    alwaysDark: contrast(D['swift-light'], '#080c14'),
  };
  ok(`dark labels on bg-swift ≥ 4.5 (${r.dark500.toFixed(2)}) and on its hover bg-swift-light (${r.dark400.toFixed(2)})`, r.dark500 >= 4.5 && r.dark400 >= 4.5);
  ok(`white labels on swift-strong ≥ 4.5 (${r.white700.toFixed(2)}) and on its hover swift-deep (${r.white800.toFixed(2)})`, r.white700 >= 4.5 && r.white800 >= 4.5);
  ok(`text on the dark surfaces ≥ 4.5 (text ${r.textDark.toFixed(2)}, hover ${r.hoverDark.toFixed(2)})`, r.textDark >= 4.5 && r.hoverDark >= 4.5);
  ok(`text on the light-mode surfaces ≥ 4.5 (text ${r.textLight.toFixed(2)}, hover ${r.hoverLight.toFixed(2)})`, r.textLight >= 4.5 && r.hoverLight >= 4.5);
  ok(`the wordmark's dark "S" on the logo teal ≥ 4.5 (${r.logo.toFixed(2)}); teal-100 labels on swift-strong ≥ 4.5 (${r.label100.toFixed(2)})`, r.logo >= 4.5 && r.label100 >= 4.5);
  ok(`swift-light text on the always-dark sign-in screens ≥ 4.5 (${r.alwaysDark.toFixed(2)})`, r.alwaysDark >= 4.5);

  // ── Every teal fill in the real back-office source carries the label its shade was chosen for ──
  const EXCL = ['pages/pos/', 'components/', 'layouts/'];
  const ALWAYS_DARK = ['pages/LoginPage.tsx', 'pages/OnboardingPage.tsx', 'pages/ForcePasswordChangePage.tsx'];
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } })(path.join(DASH, 'src'));
  const WHITE = /(^|[\s:])text-white\b/, DARKL = /(^|[\s:])text-(black|gray-950|gray-900|slate-900)\b|text-\[#0f172a\]/;
  const bad = [], themed = []; let fills = 0, swiftUses = 0;
  for (const f of files) {
    const rel = path.relative(path.join(DASH, 'src'), f).split(path.sep).join('/');
    if (EXCL.some((x) => rel.startsWith(x))) continue;
    const src = fs.readFileSync(f, 'utf8');
    swiftUses += (src.match(/-swift(?:-[a-z-]+)?(?:\/\d+)?\b/g) || []).length;
    if (/\b(?:bg|text|border|ring)-action-\d{3}/.test(src)) themed.push(rel);
    src.split('\n').forEach((line, i) => {
      for (const seg of line.split(/['"`]/)) {
        const at = `${rel}:${i + 1}`;
        if (/(^|\s)bg-swift(?![\w/-])/.test(seg)) { fills++; if (WHITE.test(seg)) bad.push(`${at} white label on bg-swift: ${seg.trim().slice(0, 70)}`); }
        if (/(^|\s)bg-swift-strong(?![\w/-])/.test(seg)) { fills++; if (DARKL.test(seg)) bad.push(`${at} dark label on bg-swift-strong: ${seg.trim().slice(0, 70)}`); }
        if (/hover:bg-swift-light\b/.test(seg) && WHITE.test(seg)) bad.push(`${at} white label on the light hover`);
        if (/hover:bg-swift-deep\b/.test(seg) && DARKL.test(seg)) bad.push(`${at} dark label on the deep hover`);
        if (ALWAYS_DARK.includes(rel) && /text-swift-text/.test(seg)) bad.push(`${at} mode-switching text on an always-dark screen`);
      }
    });
  }
  ok(`every bg-swift carries a dark label and every bg-swift-strong a white one or none (${fills} fills checked)`, bad.length === 0, '\n      ' + bad.join('\n      '));
  ok(`the back office uses swift-* (${swiftUses} uses) and never the client theme's action-*`, swiftUses >= 600 && themed.length === 0, themed.join(', '));

  // ── Light mode: the focus ring survives the build ──
  const layer = css.slice(css.indexOf('@layer base {'));
  const layerBody = layer.slice(0, layer.indexOf('\n}\n'));
  ok('focus rule for focus:border-swift is OUTSIDE @layer base (inside it, Tailwind drops it from the build)',
    /:root:not\(\.dark\) \.focus\\:border-swift:focus \{ border-color: rgb\(var\(--swift\)\) !important; \}/.test(css) && !layerBody.includes('focus\\:border-swift'));

  ok('light mode keeps white labels white on swift-strong (the light theme turns .text-white slate: 3.26:1 on teal 700)',
    /:root:not\(\.dark\) \.bg-swift-strong\.text-white,\s*\n:root:not\(\.dark\) \.bg-swift-strong \.text-white \{ color: #ffffff !important; \}/.test(css)
      && !layerBody.includes('bg-swift-strong'));

  // ── The owner's decisions ──
  const tab = read('src/pages/settings/BrandingTab.tsx');
  const pal = [...tab.slice(tab.indexOf('const PALETTE'), tab.indexOf('];', tab.indexOf('const PALETTE'))).matchAll(/name: '([^']+)',\s*hex: '(#[0-9a-f]{6})'/gi)].map((m) => [m[1], m[2].toLowerCase()]);
  ok('palette: "SwiftPOS Teal" #0d9488 first; no "SwiftPOS Blue"', pal[0]?.[0] === 'SwiftPOS Teal' && pal[0]?.[1] === '#0d9488' && !pal.some((p) => p[0] === 'SwiftPOS Blue'));
  ok(`palette: 8 distinct colours (keys are the hex) — ${pal.length} listed`, pal.length === 8 && new Set(pal.map((p) => p[1])).size === 8);
  ok('the prod favicon is the logo teal', /prod: \{ label: 'S', title: 'SwiftPOS', color: '#0d9488'/.test(read('src/lib/appFlavor.ts')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
