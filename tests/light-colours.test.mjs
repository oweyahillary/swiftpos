/**
 * light-colours.test.mjs — A333 (2026-09-27): the dashboard's light mode keeps coloured and pale text readable.
 *
 * Light mode is a list of per-class overrides in apps/dashboard/src/index.css that only ever covered grays: the owner's
 * Ingredients screenshot showed "active" (green-400, 1.74:1 on white), "OUT" (red-400/500), the amber stock pill, the blue
 * "All branches" tag and a near-invisible "Import CSV" button (gray-200 on a pale fill, 1.13), with dark row lines.
 * scripts/build-light-colours.mjs now generates a light rule for every such class the source uses.
 *
 *   node tests/light-colours.test.mjs
 *
 * RUNS the generator and proves contrast for every colour it maps (on the three light surfaces AND on the colour's own
 * tints — the badges sit on bg-<colour>-500/10..20). On the bench the same classes were also checked in Chromium on the
 * compiled CSS (before → after: active 1.60 → 4.60, low-stock pill 1.49 → 6.31, Import CSV 1.13 → 9.45, OUT 3.76 → 6.47,
 * All branches 2.17 → 5.73; the sign-in screen's white text 1.10 → 19.57).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - amber back to 700                              → "every mapped colour ≥ 4.5 on its own tint" fails (4.47)
 *   - the dark-POS exclusion dropped                 → "never inside a web POS set to dark" fails
 *   - pale labels (100–200) darkened too             → "teal-100 labels on the accent cards are left alone" fails
 *   - a sign-in screen loses data-theme-lock          → "the always-dark screens carry the marker" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const G = await import(pathToFileURL(path.join(ROOT, 'scripts/build-light-colours.mjs')).href);
const css = read('apps/dashboard/src/index.css');
const block = G.buildBlock(css);

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (c) => { const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
// Tailwind 500s — the badge tints are bg-<colour>-500/10..20.
const T500 = { red: '#ef4444', green: '#22c55e', amber: '#f59e0b', yellow: '#eab308', blue: '#3b82f6', purple: '#a855f7', orange: '#f97316',
  emerald: '#10b981', sky: '#0ea5e9', indigo: '#6366f1', pink: '#ec4899', teal: '#14b8a6', cyan: '#06b6d4', violet: '#8b5cf6', rose: '#f43f5e', lime: '#84cc16' };
const SURF = [...css.matchAll(/:root:not\(\.dark\) \.bg-gray-(?:950|900|800)\s*\{\s*background-color:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);

ok('the committed block is exactly what the generator builds from today\'s source (CI: --check)', () => {
  assert.ok(css.includes(block), 'index.css light-colours block is stale — run node scripts/build-light-colours.mjs');
});
ok(`light surfaces read from index.css (${SURF.join(', ')})`, () => assert.equal(SURF.length, 3));
ok('every mapped colour ≥ 4.5 on the light surfaces and on its own tint (/10, /15, /20)', () => {
  const bad = [];
  for (const [c, [base, hover]] of Object.entries(G.SHADE)) for (const hex of [base, hover]) {
    for (const s of SURF) { const r = cr(rgb(hex), rgb(s)); if (r < 4.5) bad.push(`${c} ${hex} on ${s} ${r.toFixed(2)}`); }
    for (const a of [0.1, 0.15, 0.2]) { const t = mix(rgb(T500[c]), [255, 255, 255], a); const r = cr(rgb(hex), t); if (r < 4.5) bad.push(`${c} ${hex} on its /${a * 100} tint ${r.toFixed(2)}`); }
  }
  assert.deepEqual(bad, []);
});
ok('pale gray text maps to slate ≥ 4.5 on every light surface', () => {
  for (const hex of Object.values(G.PALE_GRAY)) for (const s of SURF) assert.ok(cr(rgb(hex), rgb(s)) >= 4.5, `${hex} on ${s}`);
});
ok('the owner\'s screen: active / OUT / low-stock / All branches / Import CSV all have a light rule', () => {
  for (const c of ['text-green-400', 'text-red-400', 'text-red-500', 'text-amber-400', 'text-blue-400', 'text-gray-200'])
    assert.match(block, new RegExp(`\\.${c.replace(/-/g, '\\-')}:not\\(`), c);
  assert.match(block, /\.border-gray-800\\\/50:not\(/);                                  // the row lines
});
ok('never inside a web POS set to dark, nor a screen that is always dark', () => {
  const rules = block.split('\n').filter((l) => l.startsWith(':root:not(.dark) .'));
  assert.ok(rules.length > 30);
  for (const r of rules) assert.ok(r.includes(':not([data-pos-theme="dark"] *):not([data-theme-lock="dark"] *)'), r.slice(0, 80));
});
ok('teal-100 labels on the accent cards are left alone (pale labels on coloured fills)', () => {
  assert.doesNotMatch(block, /\.text-(?:teal|blue|green|red|amber)-(?:100|200):not/);
});
ok('the always-dark screens carry the marker, and keep their white text white', () => {
  for (const f of ['LoginPage', 'OnboardingPage', 'ForcePasswordChangePage']) {
    const t = read(`apps/dashboard/src/pages/${f}.tsx`);
    const roots = (t.match(/className="min-h-screen bg-\[#080c14\]/g) || []).length;
    const marked = (t.match(/data-theme-lock="dark" className="min-h-screen bg-\[#080c14\]/g) || []).length;
    assert.ok(roots > 0 && marked === roots, `${f}: ${marked} of ${roots} always-dark layouts marked`);   // EVERY layout, not one
  }
  assert.match(block, /:root:not\(\.dark\) \[data-theme-lock="dark"\] \.text-white \{ color: #ffffff !important; \}/);
});
ok('outside @layer base (inside it, Tailwind drops rules like these — A329)', () => {
  const layer = css.slice(css.indexOf('@layer base {'), css.indexOf('\n}\n', css.indexOf('@layer base {')));
  assert.ok(!layer.includes('BEGIN light-colours'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
