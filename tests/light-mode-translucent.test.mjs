/**
 * light-mode-translucent.test.mjs — A330: every translucent grey panel the dashboard uses has a light-mode rule.
 *
 *   node tests/light-mode-translucent.test.mjs
 *
 * The dashboard is dark-first; light mode is a set of overrides in apps/dashboard/src/index.css. Translucent grey PANELS
 * (`bg-gray-800/40`, …) had none, so in light mode they stayed dark translucent grey (the web POS "Add tip" panel, found
 * 2026-09-25). This fails if a new translucent grey appears in the source without a light rule, or if a rule's colour
 * drifts from the solid light mapping (same light colour, same opacity). Verified in Chromium: light → the light colour at
 * rest AND hovered; dark → unchanged.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - delete one of the rules                      → "every translucent grey used has a light rule" fails
 *   - use bg-gray-800/20 somewhere new             → the same check fails, naming it
 *   - change a rule's opacity or colour            → "…the solid's light colour at the same opacity" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/dashboard/src');
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

// Translucent grey BACKGROUNDS used as a base class (not the hover: variant) anywhere in the dashboard.
const used = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.tsx?$/.test(e.name)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/(^|[\s"'`{])bg-gray-(700|800|900|950)\/(\d+)\b/g)) {
      const k = `bg-gray-${m[2]}/${m[3]}`;
      if (!used.has(k)) used.set(k, path.relative(ROOT, p));
    }
  }
})(SRC);

// The solid light mapping the translucent rules must follow.
const solid = {};
for (const m of css.matchAll(/:root:not\(\.dark\) \.bg-gray-(700|800|900|950)\s+\{ background-color: (#[0-9a-f]{6}) !important; \}/g)) solid[m[1]] = m[2];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');

const missing = [], drift = [];
for (const [cls, file] of used) {
  const [, shade, alpha] = cls.match(/bg-gray-(\d+)\/(\d+)/);
  const re = new RegExp(`:root:not\\(\\.dark\\) \\.bg-gray-${shade}\\\\/${alpha}\\s+\\{ background-color: rgba\\(([\\d,]+),(0\\.\\d+)\\) !important; \\}`);
  const m = css.match(re);
  if (!m) { missing.push(`${cls} (e.g. ${file})`); continue; }
  const wantAlpha = (Number(alpha) / 100).toString();
  if (m[1] !== rgb(solid[shade] ?? '#000000') || Number(m[2]).toString() !== wantAlpha) drift.push(`${cls}: rgba(${m[1]},${m[2]}) — want rgba(${rgb(solid[shade] ?? '#000000')},${wantAlpha})`);
}
ok(`found the solid light mapping (700/800/900/950)`, ['700', '800', '900', '950'].every((s) => solid[s]), JSON.stringify(solid));
ok(`every translucent grey used (${used.size}) has a light-mode rule`, missing.length === 0, missing.join(' · '));
ok('…each the solid\'s light colour at the same opacity', drift.length === 0, drift.join(' · '));
ok('the rules are light-mode only (dark mode keeps the original)', !/^\s*\.bg-gray-\d+\\\/\d+\s+\{/m.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
