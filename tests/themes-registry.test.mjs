/**
 * themes-registry.test.mjs — A324 (Phase 2 slice 1): every curated action theme passes every check, and the checker
 * itself rejects what the proposal rejected. Runs shared/themes.ts directly (the canonical copy; check-shared-sync
 * keeps the till's and the web's copies byte-identical).
 *
 *   node tests/themes-registry.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - make a theme's 500 shade too dark (e.g. Ocean 500 → #1e40af)  → "every theme passes every check" fails
 *   - set Teal's tillCheck to false                                    → "tillCheck marks exactly …" fails
 *   - add an Emerald theme to THEMES                                   → "every theme passes" + "…status clash" fail
 *   - suggestThemeFor → "most different colour" instead of complement  → the pairing cases fail
 *   - drop the visibility rule from resolveBrandLayer                  → "a navy brand is too dark" fails
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node >= 23.6 runs .ts natively; older Node needs the flag. Re-run self rather than skip (as branding-web-contrast).
const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A324_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A324_TS: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(pathToFileURL(path.join(ROOT, 'shared', 'themes.ts')).href);
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

// ── The registry ──
const ids = T.THEMES.map((t) => t.id);
ok('seven themes, as approved', T.THEMES.length === 7 && ids.join() === 'ocean,violet,lagoon,orchid,sky,teal,blossom', ids.join());
ok('ids and names are unique', new Set(ids).size === ids.length && new Set(T.THEMES.map((t) => t.name)).size === ids.length);
ok('the default theme exists (Ocean)', T.DEFAULT_THEME_ID === 'ocean' && ids.includes(T.DEFAULT_THEME_ID));
ok('every theme has all six shades as #rrggbb', T.THEMES.every((t) => [400, 500, 600, 700, 800, 950].every((s) => /^#[0-9a-f]{6}$/.test(t.shades[s]))));

const checks = Object.fromEntries(T.THEMES.map((t) => [t.id, T.checkTheme(t.shades)]));
const failing = T.THEMES.filter((t) => !checks[t.id].ok).map((t) => `${t.id} ${JSON.stringify(checks[t.id], (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
ok('every theme passes every check (contrast on every role, status >= 15)', failing.length === 0, failing.join(' | '));
const mismatched = T.THEMES.filter((t) => t.tillCheck !== checks[t.id].needsTillCheck).map((t) => `${t.id} flag=${t.tillCheck} computed=${checks[t.id].needsTillCheck} status=${checks[t.id].status.toFixed(1)}`);
ok('tillCheck marks exactly the themes with status 15–20 (Teal, Blossom)', mismatched.length === 0
  && T.THEMES.filter((t) => t.tillCheck).map((t) => t.id).join() === 'teal,blossom', mismatched.join(' | '));
const near = [];
for (let i = 0; i < T.THEMES.length; i++) for (let j = i + 1; j < T.THEMES.length; j++) {
  const d = T.deltaE(T.THEMES[i].shades[500], T.THEMES[j].shades[500]);
  if (d < T.RULES.pairMin) near.push(`${T.THEMES[i].id}/${T.THEMES[j].id} ${d.toFixed(1)}`);
}
ok('any two themes differ by at least 10', near.length === 0, near.join(', '));

// ── The checker rejects what the proposal rejected (it would catch a bad theme being added) ──
const REJECTED = {
  emerald: { expect: 'paid',    shades: { 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 950: '#022c22' } },
  rose:    { expect: 'void',    shades: { 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 950: '#4c0519' } },
  amber:   { expect: 'warning', shades: { 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 950: '#451a03' } },
  yellow:  { expect: 'warning', shades: { 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 950: '#422006' } },
};
for (const [name, r] of Object.entries(REJECTED)) {
  const c = T.checkTheme(r.shades);
  ok(`${name} is refused as an action theme — status clash with ${r.expect}`, !c.ok && c.status < T.RULES.statusMin && c.statusName === r.expect,
    `ok=${c.ok} status=${c.status.toFixed(1)} ${c.statusName}`);
}
const iris = T.checkTheme({ 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 950: '#1e1b4b' });
const violet = T.THEMES.find((t) => t.id === 'violet').shades[500];
ok('Iris passes alone but is too close to Violet to ship beside it', iris.ok && T.deltaE('#6366f1', violet) < T.RULES.pairMin);

// ── Resolving a stored id ──
ok('an unknown id falls back to the default', T.resolveTheme('crimson').id === 'ocean');
ok('null / empty fall back to the default', T.resolveTheme(null).id === 'ocean' && T.resolveTheme('').id === 'ocean');
ok('a known id resolves to itself', T.resolveTheme('lagoon').id === 'lagoon');
ok('isThemeId accepts only registered ids', T.isThemeId('sky') && !T.isThemeId('emerald') && !T.isThemeId(42));
const tok = T.themeTokens(T.resolveTheme('ocean'));
ok('tokens use the fixed shade per job (500 / 400 / 600 / 700 / 950)',
  tok.fillDark === '#3b82f6' && tok.textDark === '#60a5fa' && tok.fillLight === '#2563eb' && tok.textLight === '#1d4ed8' && tok.tint === '#172554');
ok('each fill carries a readable label colour', T.THEMES.every((t) => { const k = T.themeTokens(t);
  return T.contrast(k.onFillDark, k.fillDark) >= 4.5 && T.contrast(k.onFillLight, k.fillLight) >= 4.5; }));

// ── Pairing: the complementary hue ──
ok('yellow brand → Sky', T.suggestThemeFor('#F5B800') === 'sky', String(T.suggestThemeFor('#F5B800')));
ok('red brand → Lagoon', T.suggestThemeFor('#DC2626') === 'lagoon', String(T.suggestThemeFor('#DC2626')));
ok('green brand → Orchid', T.suggestThemeFor('#16A34A') === 'orchid', String(T.suggestThemeFor('#16A34A')));
ok('no or invalid brand → no suggestion', T.suggestThemeFor(null) === null && T.suggestThemeFor('#abc') === null);

// ── Brand layer: any hue that can be seen ──
const y = T.resolveBrandLayer('#f5b800');
ok('a yellow brand is usable, with black text on it', !!y && y.brand === '#F5B800' && y.onBrand === '#000000' && y.visibility > 9);
ok('…and its sidebar tint keeps the sidebar text at 7:1 or better', !!y && T.contrast(T.SURFACES.sidebarText, y.tint) >= 7, y?.tint);
ok('red, green and amber brands are usable too (no status rule for the brand layer)',
  ['#DC2626', '#16A34A', '#F59E0B'].every((h) => T.resolveBrandLayer(h) !== null));
ok('a navy brand is too dark to be seen → null (everything follows the action theme)', T.resolveBrandLayer('#1E3A8A') === null);
ok('an invalid colour → null', T.resolveBrandLayer('yellow') === null && T.resolveBrandLayer('') === null && T.resolveBrandLayer(null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
