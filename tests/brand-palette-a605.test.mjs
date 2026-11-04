// A605 — the brand palette engine, professional and clean (owner, 2026-10-28: "on branding can we do it in a better way
// professional and clean not just branding for the sake? match colors perfectly give them a feel of their brand. also the
// save button on branding move it at the bottom").
//
//   node --no-warnings tests/brand-palette-a605.test.mjs
//
// RUNS the shared engine (shared/themes.ts brandPalette / brandScale / brandNotes, bundled with esbuild) and the web's and
// the POS's copies of it, the dashboard's lib/logoColours.ts on synthetic images, the dashboard's and the desktop's
// lib/themeVars.ts, and reads index.css (both apps) and the Branding page for the colour map and the save bar.
//
//   E  the engine: the base step IS the hex (a sweep of 500+ colours); the scale is even and keeps the hue; every
//      text-on-colour pair ≥ 4.5 and every ring / chart mark ≥ 3 in light AND dark; status colours never taken.
//   F  the four sample colours: yellow #FACC15, navy #0B1F3A, rose #E11D48, a green near "paid" #16A34A; plain-words notes.
//   C  the copies agree: the dashboard's and the desktop's themes.ts give the same palette, byte for byte.
//   L  logo colours: dominant colours out of synthetic pixels, background white / black / transparent ignored, the chip.
//   M  the colour map: the dashboard's variables and index.css (data-brand), the web POS's labels, the desktop's.
//   P  the Branding page: the save bar at the bottom (no mid-page save), Discard changes, the live preview, "Use colours
//      from my logo", the branch panel's save at its bottom.
//
// MUTATIONS TO CONFIRM BITE (each made by hand 2026-10-28, seen to fail, reverted):
//   - brandScale: the base step snapped to the step's usual lightness (not the hex)       → E "the base step IS the hex"
//   - modeTokens: the primary's label always white (no ink / black choice)                 → E "every label ≥ 4.5"
//   - modeTokens: the status guard dropped (plain nearestTone)                             → E "status shades never taken", F green
//   - modeTokens: text checked on the page surfaces only, not on the subtle shade          → E "text on subtle ≥ 4.5"
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a605-'));
const load = async (entry, name) => {
  await esbuild.build({ entryPoints: [path.join(ROOT, entry)], bundle: true, format: 'cjs', platform: 'node',
    outfile: path.join(tmp, `${name}.cjs`), logLevel: 'silent' });
  return createRequire(import.meta.url)(path.join(tmp, `${name}.cjs`));
};
const T = await load('packages/core/src/themes.ts', 'themes');   // shared-components: the one themes.ts, no app copies
const LC = await load('apps/dashboard/src/lib/logoColours.ts', 'logo');
const TV = await load('apps/dashboard/src/lib/themeVars.ts', 'tv-dash');
const DV = await load('apps/desktop/src/renderer/lib/themeVars.ts', 'tv-pos');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const minC = (fg, bgs) => Math.min(...bgs.map((b) => T.contrast(fg, b)));
const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');

// The sweep: OKLCH hue every 15° × 6 lightness × 3 chroma (432), the extremes, and 120 seeded random colours.
const SWEEP = new Set();
for (let H = 0; H < 360; H += 15) for (const L of [0.22, 0.4, 0.55, 0.7, 0.85, 0.96]) for (const C of [0.03, 0.12, 0.26]) SWEEP.add(T.oklchHex(L, C, H));
for (const h of ['#ffffff', '#000000', '#808080', '#ffff00', '#000080', '#ff0000', '#00ff00', '#0000ff', '#facc15', '#0b1f3a', '#e11d48', '#16a34a', '#22c55e', '#f59e0b', '#ef4444', '#fdf6e3', '#fecdd3']) SWEEP.add(h);
let seed = 605;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let i = 0; i < 120; i++) SWEEP.add('#' + [0, 1, 2].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join(''));
const ALL = [...SWEEP];
const MODES = { light: T.BRAND_SURFACES.lightText, dark: T.BRAND_SURFACES.darkText };
const CARD = { light: '#ffffff', dark: '#111827' };
const SIDE = { light: '#4f5d73', dark: '#9ca3af' };   // A609 (2026-10-29): light gray-400 moved #64748b → #4f5d73 (index.css), pin updated on purpose

console.log(`\nE. the engine (${ALL.length} colours)\n`);
ok('nothing refused; junk → null', () => {
  assert.ok(ALL.length >= 300, `the sweep has ${ALL.length} colours`);
  for (const h of ALL) assert.ok(T.brandPalette(h), h);
  for (const bad of [null, '', 'red', '#fff', '#12345g', 7]) { assert.equal(T.brandPalette(bad), null); assert.equal(T.brandScale(bad), null); }
  assert.equal(T.brandPalette('#FACC15').base, '#facc15', 'upper case is the same colour');
});
ok('the base step IS the hex, exactly — the owner\'s colour is used as chosen', () => {
  for (const h of ALL) { const s = T.brandScale(h); assert.equal(s.steps[s.baseStep], h, h); assert.equal(T.brandPalette(h).scale[s.baseStep], h); }
});
ok('the scale: 11 steps, lighter to darker in order, evenly (no step jumps more than 0.2 in OKLCH lightness)', () => {
  for (const h of ALL) {
    const s = T.brandScale(h).steps, Ls = T.BRAND_STEPS.map((k) => T.oklch(s[k]).L);
    for (let i = 1; i < Ls.length; i++) {
      assert.ok(Ls[i] <= Ls[i - 1] + 0.004, `${h} ${T.BRAND_STEPS[i]} not darker`);
      assert.ok(Ls[i - 1] - Ls[i] <= 0.2, `${h} ${T.BRAND_STEPS[i]} jumps ${(Ls[i - 1] - Ls[i]).toFixed(2)}`);
    }
  }
});
ok('the scale keeps the hue (within 12°; yellows warm toward amber as they darken, within 40°)', () => {
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  for (const h of ALL) {
    const b = T.oklch(h); if (b.C < 0.06) continue;
    const s = T.brandScale(h).steps;
    for (const k of [200, 300, 400, 500, 600, 700, 800]) {
      const o = T.oklch(s[k]); if (o.C < 0.03) continue;
      const yellow = b.H >= 75 && b.H <= 118;
      assert.ok(gap(o.H, b.H) <= (yellow ? 40 : 12), `${h} step ${k}: hue ${o.H.toFixed(0)} vs ${b.H.toFixed(0)}`);
    }
  }
});
ok('every label ≥ 4.5: on the primary, its hover and pressed shades, the colour itself, the POS layer', () => {
  for (const h of ALL) {
    const p = T.brandPalette(h);
    for (const m of ['light', 'dark']) {
      const k = p[m];
      for (const f of [k.primary, k.primaryHover, k.primaryPressed]) assert.ok(T.contrast(k.onPrimary, f) >= 4.5, `${h} ${m} ${k.onPrimary} on ${f}`);
    }
    assert.ok(T.contrast(p.on, p.base) >= 4.5, `${h} on base`);
    assert.ok(T.contrast(p.onLayer, p.layer) >= 4.5, `${h} on layer`);
  }
});
ok('text ≥ 4.5 on every surface of its mode AND on the subtle (selected) shade; its hover too', () => {
  for (const h of ALL) {
    const p = T.brandPalette(h);
    for (const [m, S] of Object.entries(MODES)) {
      const k = p[m];
      assert.ok(minC(k.text, [...S, k.subtle]) >= 4.5, `${h} ${m} text ${k.text}`);
      assert.ok(minC(k.textHover, S) >= 4.5, `${h} ${m} text hover ${k.textHover}`);
    }
  }
});
ok('rings and borders ≥ 3 on the page, chart marks ≥ 3 on the card; a button stands out from the page (≥ 1.4)', () => {
  for (const h of ALL) {
    const p = T.brandPalette(h);
    for (const [m, S] of Object.entries(MODES)) {
      const k = p[m];
      assert.ok(minC(k.ring, S) >= 3, `${h} ${m} ring`);
      assert.ok(T.contrast(k.chart, CARD[m]) >= 3, `${h} ${m} chart`);
      assert.ok(minC(k.primary, m === 'light' ? ['#ffffff', '#f8fafc'] : ['#111827', '#030712']) >= T.BRAND_EDGE, `${h} ${m} edge`);
    }
  }
});
ok('the menu stays readable on the sidebar tint (its grey text ≥ 4.5); the POS sidebar tint ≥ 7; the POS layer seen (3:1)', () => {
  for (const h of ALL) {
    const p = T.brandPalette(h);
    for (const m of ['light', 'dark']) assert.ok(T.contrast(SIDE[m], p[m].tint) >= 4.5, `${h} ${m} tint`);
    assert.ok(T.contrast(T.SURFACES.sidebarText, p.tint) >= 7, `${h} POS tint`);
    assert.ok(minC(p.layer, T.SURFACES.darkPanels) >= 3, `${h} layer`);
  }
});
ok('status shades never taken: buttons and links keep STATUS_GUARD (ΔE2000) from paid / warning / void', () => {
  const all = Object.values(T.STATUS_SHADES).flat();
  let checked = 0;
  for (const h of ALL) {
    const p = T.brandPalette(h);
    for (const m of ['light', 'dark']) for (const x of [p[m].primary, p[m].text]) {
      assert.ok(!all.includes(x), `${h} ${m} ${x} IS a status shade`);
      assert.ok(Math.min(...all.map((s) => T.deltaE(x, s))) >= T.STATUS_GUARD, `${h} ${m} ${x} too close to a status shade`);
      checked++;
    }
  }
  assert.equal(checked, ALL.length * 4);
});
ok('the colour itself is kept wherever it reads (no needless change)', () => {
  for (const h of ['#e11d48', '#3b82f6', '#0d9488', '#7c3aed']) {
    const p = T.brandPalette(h);
    assert.equal(p.light.primary, h, `${h} light`); assert.equal(p.dark.primary, h, `${h} dark`);
  }
  assert.equal(T.brandPalette('#0b1f3a').light.text, '#0b1f3a', 'navy text on white is the navy');
  assert.equal(T.brandPalette('#facc15').dark.text, '#facc15', 'yellow text on the dark screens is the yellow');
});
ok('brandTokens (kept for callers) is built on the same scale: its jobs still read', () => {
  for (const h of ALL.slice(0, 200)) {
    const k = T.brandTokens(h);
    assert.ok(minC(k.fill, T.BRAND_SURFACES.darkLabels) >= 4.5 && T.contrast('#ffffff', k.strong) >= 4.5, h);
    assert.ok(minC(k.textDark, T.BRAND_SURFACES.darkText) >= 4.5 && minC(k.textLight, T.BRAND_SURFACES.lightText) >= 4.5, h);
  }
});

console.log('\nF. the four sample colours\n');
ok('a light brand, yellow #FACC15: the yellow on buttons with dark-brown text; links on white a deep yellow; the note says so', () => {
  const p = T.brandPalette('#FACC15');
  assert.equal(p.light.primary, '#facc15'); assert.equal(p.dark.primary, '#facc15');
  assert.notEqual(p.light.onPrimary, '#ffffff'); assert.equal(T.colourName(p.light.onPrimary), 'brown');
  assert.ok(T.contrast(p.light.text, '#ffffff') >= 4.5 && T.colourName(p.light.text) !== 'grey', p.light.text);
  const n = T.brandNotes('#FACC15');
  assert.match(n[0], /^Your yellow is very light, so text on it is shown in dark brown, and links on white pages use a deeper yellow to stay readable\.$/);
});
ok('a dark brand, navy #0B1F3A: exact in light mode; lifted in dark mode so a button stands out; links a lighter navy', () => {
  const p = T.brandPalette('#0B1F3A');
  assert.equal(p.light.primary, '#0b1f3a'); assert.equal(p.light.onPrimary, '#ffffff');
  assert.notEqual(p.dark.primary, '#0b1f3a');
  assert.ok(T.contrast(p.dark.primary, '#111827') >= T.BRAND_EDGE && T.contrast('#ffffff', p.dark.primary) >= 4.5);
  assert.ok(T.oklch(p.dark.primary).H > 230 && T.oklch(p.dark.primary).H < 280, 'still navy');
  assert.match(T.brandNotes('#0B1F3A').join(' '), /Your navy is very dark, so in dark mode buttons use a lighter navy to stand out from the background\./);
});
ok('a mid brand, rose #E11D48: exact everywhere it is a fill, white label; close to void red → advice only', () => {
  const p = T.brandPalette('#E11D48');
  assert.deepEqual([p.light.primary, p.dark.primary, p.light.onPrimary], ['#e11d48', '#e11d48', '#ffffff']);
  assert.equal(p.nearStatus, 'void');
  assert.match(T.brandNotes('#E11D48').join(' '), /close to the red of voids/);
});
ok('a green near "paid", #16A34A: buttons and links move to a different green, so "Paid" stays its own; the note says so', () => {
  const p = T.brandPalette('#16A34A');
  assert.equal(p.base, '#16a34a'); assert.equal(p.scale[p.baseStep], '#16a34a', 'the scale still holds the exact colour');
  for (const m of ['light', 'dark']) {
    assert.notEqual(p[m].primary, '#16a34a');
    for (const s of T.STATUS_SHADES.paid) assert.ok(T.deltaE(p[m].primary, s) >= T.STATUS_GUARD, `${m} ${p[m].primary} vs ${s}`);
    assert.ok(T.oklch(p[m].primary).H > 130 && T.oklch(p[m].primary).H < 160, 'still green');
  }
  assert.match(T.brandNotes('#16A34A').join(' '), /Your green is close to the green that means paid, so buttons and links use a slightly different shade of it to keep “Paid” easy to tell apart\./);
});
ok('a colour that just works says nothing (#3B82F6, #0D9488)', () => {
  assert.deepEqual(T.brandNotes('#3B82F6'), []); assert.deepEqual(T.brandNotes('#0D9488'), []); assert.deepEqual(T.brandNotes(null), []);
});
ok('no "till" in the notes', () => { for (const h of ALL.slice(0, 100)) for (const n of T.brandNotes(h)) assert.ok(!/\btill/i.test(n), n); });

console.log('\nC. one engine, the same in every app\n');
ok('one themes.ts for every app (packages/core): the old copies are gone, the apps import @zaptill/core/themes', () => {
  for (const f of ['shared/themes.ts', 'apps/dashboard/src/lib/themes.ts', 'apps/desktop/src/shared/themes.ts', 'apps/desktop/src/main/themes.ts', 'apps/server/src/lib/themes.ts']) assert.ok(!fs.existsSync(path.join(ROOT, f)), f);
  assert.match(read('apps/dashboard/src/lib/themeVars.ts'), /from '@zaptill\/core\/themes'/);
  assert.match(read('apps/desktop/src/renderer/lib/themeVars.ts'), /from '@zaptill\/core\/themes'/);
});

console.log('\nL. colours from the logo\n');
const img = (w, h, paint) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = paint(x, y); d.set([r, g, b, a], (y * w + x) * 4); } return d; };
ok('two flat colours on white → exactly those two, the larger first; the white background ignored', () => {
  const d = img(100, 60, (x, y) => (y < 10 || y > 50 ? [255, 255, 255] : x < 60 ? [225, 29, 72] : [11, 31, 58]));
  const r = LC.logoColoursFromPixels(d, 100, 60);
  assert.deepEqual(r.colours, ['#e11d48', '#0b1f3a']); assert.equal(r.chip, 'light');
});
ok('transparent and near-black outline ignored; at most 5; similar shades merged into one', () => {
  const d = img(120, 40, (x, y) => (y < 4 ? [0, 0, 0, 0] : y < 6 ? [10, 10, 10] : x < 20 ? [250, 204, 21] : x < 24 ? [248, 202, 24] : x < 40 ? [22, 163, 74]
    : x < 60 ? [59, 130, 246] : x < 80 ? [124, 58, 237] : x < 100 ? [236, 72, 153] : [20, 184, 166]));
  const r = LC.logoColoursFromPixels(d, 120, 40);
  assert.equal(r.colours.length, 5);
  assert.ok(!r.colours.some((c) => ['#000000', '#0a0a0a'].includes(c)));
  assert.equal(r.colours.filter((c) => T.deltaE(c, '#facc15') < 5).length <= 1, true, 'the two yellows are one');
});
ok('a white logo on a transparent background → the dark chip; nothing but white → no colours', () => {
  const d = img(50, 50, (x, y) => (x > 10 && x < 40 && y > 10 && y < 40 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  assert.deepEqual(LC.logoColoursFromPixels(d, 50, 50), { colours: [], chip: 'dark' });
  assert.deepEqual(LC.logoColoursFromPixels(new Uint8ClampedArray(0), 0, 0), { colours: [], chip: 'light' });
});
ok('a big image is sampled, not read pixel by pixel (still finds its colour)', () => {
  const d = img(800, 600, (x) => (x < 400 ? [255, 255, 255] : [13, 148, 136]));
  assert.deepEqual(LC.logoColoursFromPixels(d, 800, 600).colours, ['#0d9488']);
});

console.log('\nM. the colour map\n');
ok('dashboard: a primary → its palette light and dark, the band, the secondary only when chosen; data-brand set', () => {
  const v = TV.computeDashboardThemeVars({ themes_enabled: true, theme_id: 'violet', primary_hex: '#facc15' });
  const p = T.brandPalette('#facc15');
  assert.equal(v['bp-primary-l'], ch(p.light.primary)); assert.equal(v['bp-on-primary-d'], ch(p.dark.onPrimary));
  assert.equal(v['bp-text-l'], ch(p.light.text)); assert.equal(v['bp-ring-d'], ch(p.dark.ring)); assert.equal(v['bp-band'], ch('#facc15'));
  assert.equal(v['bs-primary-l'], undefined);
  const both = TV.computeDashboardThemeVars({ themes_enabled: true, primary_hex: '#facc15', secondary_hex: '#0b1f3a' });
  assert.equal(both['bs-chart-l'], ch(T.brandPalette('#0b1f3a').light.chart));
  for (const k of Object.keys(both)) assert.ok(TV.DASHBOARD_THEME_VARS.includes(k), `${k} is cleared on switch-off`);
});
ok('dashboard index.css: under data-brand the back office, the web POS and their labels take the palette', () => {
  const css = read('apps/dashboard/src/index.css');
  const at = css.indexOf('A597 / A605');
  assert.ok(at > css.indexOf('END light-colours'), 'after the generated light colours, so it wins');
  const b = css.slice(at);
  for (const re of [/--swift: var\(--bp-primary\);/, /--swift-strong: var\(--bp-primary\);/, /--act-strong: var\(--bp-primary\);/, /--act-on: var\(--bp-on\);/,
    /--action-400: var\(--bp-text\);/, /:root\[data-brand\]:not\(\.dark\), :root\[data-brand\] \[data-pos-theme="light"\] \{\s*--bp-primary: var\(--bp-primary-l\);/,
    /:is\(\.bg-swift, \.bg-swift-strong, \.bg-action-500, \.bg-action-600\):is\(\.text-white, \.text-black, \.text-gray-950, \.text-gray-900\)/,
    /color: rgb\(var\(--bp-on\)\) !important;/, /\.nav-active \{ background-color: rgb\(var\(--bp-subtle\)\)/, /:focus-visible \{ outline-color: rgb\(var\(--bp-ring\)\)/]) assert.match(b, re);
  assert.ok(!/swift-logo/.test(b), 'the ZapTill wordmark stays');
});
ok('the web POS: the labels on the brand fills follow the brand (act-on), the pay button among them', () => {
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /chargeBtn: \{\s*width: '100%', padding: '13px 0', background: 'rgb\(var\(--act-fill, 34 197 94\)\)', border: 'none',\s*borderRadius: 10, color: 'rgb\(var\(--act-on, 15 23 42\)\)'/);
  assert.match(read('apps/dashboard/src/pages/pos/MinimartPOS.tsx'), /color: 'rgb\(var\(--act-on, 255 255 255\)\)'/);
  assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /isActive \? 'nav-active bg-action-500\/10 text-action-400'/);
});
ok('the desktop POS: the dark palette on the action variables, one label (on-action), data-brand; one-colour strip', () => {
  const t = DV.computeThemeVars({ themeId: 'violet', primaryHex: '#0b1f3a', secondaryHex: '#facc15' });
  const p = T.brandPalette('#0b1f3a');
  assert.equal(t.vars['action-500'], ch(p.dark.primary)); assert.equal(t.vars['on-action'], ch(p.dark.onPrimary));
  assert.equal(t.vars['action-400'], ch(p.dark.text)); assert.equal(t.vars['action-ring'], ch(p.dark.ring));
  assert.equal(t.strip, p.layer); assert.equal(DV.stripBackground(t), p.layer); assert.equal(t.brand, true);
  const attrs = new Map(), props = new Map();
  const root = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
  DV.applyThemeVars(t, root); assert.ok(attrs.has('data-brand') && props.get('--on-action'));
  DV.applyThemeVars(DV.computeThemeVars({ themeId: 'violet' }), root); assert.ok(!attrs.has('data-brand') && !props.has('--on-action'));
  DV.applyThemeVars(null, root); assert.equal(props.size + attrs.size, 0);
  const css = read('apps/desktop/src/renderer/index.css');
  assert.match(css, /:root\[data-brand\] :is\(\.bg-action-500, \.bg-action-600, \.bg-action-700\):is\(\.text-white, \.text-black, \.text-gray-950, \.text-gray-900\)/);
  assert.match(css, /color: rgb\(var\(--on-action\)\) !important;/);
});
ok('the desktop lock screen keeps A544\'s order: the branch / business lock-screen accent first, then the primary', () => {
  assert.match(read('apps/desktop/src/renderer/pages/PinPage.tsx'), /setAccentHex\(accent \?\? \(primary \? primary\.layer : theme \? resolveTheme\(theme\)\.shades\[500\] : null\)\);/);
  const acc = DV.computeThemeVars({ themeId: 'violet', accentHex: '#F5B800', primaryHex: '#0b1f3a' });
  assert.equal(acc.strip, '#F5B800');
});

console.log('\nP. the Branding page\n');
const tab = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
const main = tab.slice(tab.indexOf('export default function BrandingTab()'), tab.indexOf('function Section('));
ok('one Save, at the bottom: the sticky save bar is the page\'s last element; no Save button in the middle', () => {
  assert.ok(!/Save branding/.test(tab), 'the old mid-page "Save branding" is gone');
  assert.match(main, /<SaveBar show=\{dirty \|\| !!msg\} dirty=\{dirty\}/);
  assert.ok(main.lastIndexOf('<SaveBar') > main.lastIndexOf('<BranchBrandingSection'), 'after every section');
  assert.equal((main.match(/onClick=\{save\}/g) || []).length, 0, 'the page\'s save is only in the bar');
  assert.match(tab, /className=\{`\$\{sticky \? 'sticky bottom-0 z-20/);
  assert.match(tab, /Discard changes/);
});
ok('the bar shows only when something changed (or briefly with the saved message); Discard restores what was saved', () => {
  assert.match(main, /const dirty = !!saved && JSON\.stringify\(draft\) !== JSON\.stringify\(saved\);/);
  assert.match(main, /setSaved\(draft\);/);
  assert.match(main, /const discard = \(\) => \{\s*if \(!saved\) return;\s*setAccentHex\(saved\.accentHex\);/);
  assert.match(tab, /if \(!show\) return null;/);
});
ok('the live preview: the dashboard and the POS, light and dark, from brandPalette; the logo\'s colours; the notes', () => {
  assert.match(tab, /function BrandLivePreview/); assert.match(tab, /data-testid="preview-dashboard"/); assert.match(tab, /data-testid="preview-pos"/);
  assert.match(tab, /const p = brandPalette\(primaryHex\), s = brandPalette\(secondaryHex\);/);
  assert.match(tab, /Use colours from my logo/); assert.match(tab, /logoColoursFromDataUri\(logoPng, 5\)/);
  assert.match(tab, /const notes = \[\.\.\.brandNotes\(primaryHex\)/);
});
ok('each branch\'s save sits at the bottom of its own panel, with Discard changes', () => {
  const ed = tab.slice(tab.indexOf('function BranchBrandingEditor'), tab.indexOf("// ── A597 / A605: the owner's brand colours"));
  assert.ok(ed.indexOf('data-testid="branch-save-bar"') > ed.indexOf('POS preview'), 'after the preview');
  assert.match(ed, /onClick=\{discard\}/);
});
ok('owner-only and premium unchanged: colours sent only by the owner with themes; read-only note for others', () => {
  assert.match(tab, /const sendColours = themesEnabled && coloursEditable;/);
  assert.match(tab, /\.\.\.\(sendColours \? \{ primary_hex: primaryHex, secondary_hex: secondaryHex \} : \{\}\)/);
  assert.match(tab, /\{themesEnabled && \(\s*<BrandColoursField editable=\{coloursEditable\}/);
  assert.match(tab, /Only the owner can change the brand colours\./);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
