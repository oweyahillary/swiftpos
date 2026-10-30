/**
 * brand-polish-a609.test.mjs — A609 (owner, 2026-10-29: "It looks better and solid, we just need a few things"):
 *   S  the secondary colour takes effect — restrained accents only, in its ring shade, and only with a secondary chosen;
 *   L  light mode readable — every grey text ≥ 4.5 on every light surface, card and field edges a step deeper;
 *   N  the notification panels readable on a phone (the admin portal's bell, the dashboard's);
 *   B  no flash of the default theme — the last look cached and put back before the first render (index.html, themeBoot).
 *
 *   node --no-warnings tests/brand-polish-a609.test.mjs
 *
 * RUNS the dashboard's lib/themeVars.ts and lib/themeBoot.ts (bundled with esbuild, a fake localStorage / <html>), the
 * desktop's renderer/lib/themeVars.ts, and index.html's inline script (node:vm); reads index.css (both apps), the layout,
 * the web POS drawer and the admin bell.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - light gray-500 back to #94a3b8                       → "every light grey text ≥ 4.5" fails
 *   - data-brand-2 set without a secondary                 → "no secondary → no data-brand-2" fails
 *   - themeBoot without the sign-in gate                   → "nothing is put back without a sign-in" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a609-'));
const load = async (entry, name) => {
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, `${name}.cjs`), logLevel: 'silent' });
  return createRequire(import.meta.url)(path.join(tmp, `${name}.cjs`));
};
const boot = path.join(tmp, 'boot-entry.ts');
fs.writeFileSync(boot, `export * from ${JSON.stringify(path.join(ROOT, 'apps/dashboard/src/lib/themeBoot.ts'))};\n`
  + `export { brandLook, brandColourVars, computeDashboardThemeVars, applyDashboardThemeVars } from ${JSON.stringify(path.join(ROOT, 'apps/dashboard/src/lib/themeVars.ts'))};\n`
  + `export { brandPalette, contrast } from ${JSON.stringify(path.join(ROOT, 'shared/themes.ts'))};\n`);
const W = await load(boot, 'boot');
const DV = await load(path.join(ROOT, 'apps/desktop/src/renderer/lib/themeVars.ts'), 'tv-pos');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const css = read('apps/dashboard/src/index.css');
const dcss = read('apps/desktop/src/renderer/index.css');
const COLOURS = ['#facc15', '#0b1f3a', '#e11d48', '#16a34a'];
const LIGHT = ['#ffffff', '#f8fafc', '#f1f5f9'];          // the light pages, cards and fields
const fakeRoot = () => {
  const style = new Map(), attrs = new Set();
  return { style: { setProperty: (k, v) => style.set(k, v), removeProperty: (k) => style.delete(k) }, setAttribute: (a) => attrs.add(a),
    removeAttribute: (a) => attrs.delete(a), classList: { add: (c) => attrs.add(`class:${c}`) }, _style: style, _attrs: attrs };
};
const fakeStorage = (limit = Infinity) => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (String(v).length > limit) throw new Error('QuotaExceeded'); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
};

// ── L: light mode ────────────────────────────────────────────────────────────────────────────────────────────────
const lightText = (cls) => { const m = css.match(new RegExp(`:root:not\\(\\.dark\\) \\.${cls} \\{ color: (#[0-9a-f]{6}) !important; \\}`)); return m && m[1]; };
ok('L every light grey text ≥ 4.5 on white, slate-50 and slate-100 (gray-300 / 400 / 500 / 600)', () => {
  for (const c of ['text-gray-300', 'text-gray-400', 'text-gray-500', 'text-gray-600']) {
    const hex = lightText(c); assert.ok(hex, c);
    for (const s of LIGHT) assert.ok(W.contrast(hex, s) >= 4.5, `${c} ${hex} on ${s}: ${W.contrast(hex, s).toFixed(2)}`);
  }
});
ok('L secondary labels (400) stay darker than hints (500) — the hierarchy kept', () => {
  assert.ok(W.contrast(lightText('text-gray-400'), '#ffffff') > W.contrast(lightText('text-gray-500'), '#ffffff'));
});
ok('L placeholders ≥ 4.5 on white (was #94a3b8, 2.56)', () => {
  const m = css.match(/textarea::placeholder \{\s*color: (#[0-9a-f]{6})/); assert.ok(m);
  assert.ok(W.contrast(m[1], '#ffffff') >= 4.5, m[1]);
});
ok('L card edges a step deeper than before on the slate-50 page; field edges deeper again; cards get a hairline shadow', () => {
  const edge = (c) => css.match(new RegExp(`:root:not\\(\\.dark\\) \\.${c} \\{ border-color: (#[0-9a-f]{6})`))[1];
  assert.ok(W.contrast(edge('border-gray-800'), '#f8fafc') > W.contrast('#e2e8f0', '#f8fafc'), 'card edge');
  assert.ok(W.contrast(edge('border-gray-700'), '#f1f5f9') > W.contrast(edge('border-gray-800'), '#f1f5f9'), 'field edge');
  assert.match(css, /:is\(\.rounded-lg, \.rounded-xl, \.rounded-2xl\)\.bg-gray-900\.border:not\(\[class\*="shadow"\]\) \{\s*box-shadow:/);
});
ok('L the menu text the brand tint is checked against is the new gray-400 (shared themes.ts SIDEBAR_TEXT)', () => {
  assert.match(read('shared/themes.ts'), new RegExp(`SIDEBAR_TEXT = \\{ light: '${lightText('text-gray-400')}'`));
});

// ── S: the secondary colour ──────────────────────────────────────────────────────────────────────────────────────
ok('S no secondary → no bs-* variables, no data-brand-2 (today\'s look exactly)', () => {
  for (const h of COLOURS) {
    const v = W.computeDashboardThemeVars({ themes_enabled: true, primary_hex: h });
    assert.ok(!Object.keys(v).some((k) => k.startsWith('bs-')), h);
    const r = fakeRoot(); W.applyDashboardThemeVars(v, r);
    assert.ok(r._attrs.has('data-brand') && !r._attrs.has('data-brand-2'), h);
  }
});
ok('S with a secondary → data-brand-2 and its ring shade ≥ 3:1 on every surface of each mode', () => {
  for (const p of COLOURS) for (const s of COLOURS) {
    if (p === s) continue;
    const v = W.computeDashboardThemeVars({ themes_enabled: true, primary_hex: p, secondary_hex: s });
    const r = fakeRoot(); W.applyDashboardThemeVars(v, r);
    assert.ok(r._attrs.has('data-brand-2'), `${p}+${s}`);
    const k = W.brandPalette(s);
    for (const bg of LIGHT) assert.ok(W.contrast(k.light.ring, bg) >= 3, `${s} light ring on ${bg}`);
    for (const bg of ['#030712', '#111827', '#1f2937']) assert.ok(W.contrast(k.dark.ring, bg) >= 3, `${s} dark ring on ${bg}`);
  }
  const r = fakeRoot(); W.applyDashboardThemeVars(null, r); assert.ok(!r._attrs.has('data-brand-2'), 'themes off clears it');
});
ok('S the accents are keyed on [data-brand-2] only, in the ring shade: divider, menu marker, tab underline, POS rail', () => {
  assert.match(css, /:root\[data-brand-2\] \.brand-divider \{ border-bottom-color: rgb\(var\(--bs-ring\)\) !important; \}/);
  assert.match(css, /:root\[data-brand-2\] \.nav-active \{ box-shadow: inset 3px 0 0 rgb\(var\(--bs-ring\)\); \}/);
  assert.match(css, /:root\[data-brand-2\] \.border-b-2:is\(\.border-swift, \.border-swift-strong, \.border-action-500\) \{ border-color: rgb\(var\(--bs-ring\)\) !important; \}/);
  for (const m of css.matchAll(/--act-accent:/g)) assert.ok(css.lastIndexOf('[data-brand-2]', m.index) > css.lastIndexOf('}', m.index), 'act-accent declared outside data-brand-2');
  assert.match(read('apps/dashboard/src/pages/pos/POSDrawer.tsx'), /borderLeftColor: 'rgb\(var\(--act-accent, var\(--act-fill, 59 130 246\)\)\)'/);
  const lay = read('apps/dashboard/src/components/DashboardLayout.tsx');
  assert.equal((lay.match(/brand-divider/g) || []).length, 2, 'the menu header and the phone bar');
  assert.match(css, /:root\[data-brand-2\]:not\(\.dark\), :root\[data-brand-2\] \[data-pos-theme="light"\] \{\s*--bs-ring: var\(--bs-ring-l\)/);
});
ok('S buttons, links and focus stay the primary (no bs-* outside the accent rules)', () => {
  const uses = [...css.matchAll(/rgb\(var\(--bs-[a-z-]+\)\)/g)].length;
  assert.equal(uses, 3, 'divider, marker, tab');
});
ok('S a very light primary gets a hairline edge on the light pages (yellow → its ring), a strong one none (navy → itself)', () => {
  const y = W.brandPalette('#facc15'), n = W.brandPalette('#0b1f3a');
  const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
  assert.equal(W.brandColourVars(y)['bp-edge-l'], ch(y.light.ring));
  assert.equal(W.brandColourVars(n)['bp-edge-l'], ch(n.light.primary));
  assert.ok(W.contrast(y.light.ring, '#ffffff') >= 3);
});
ok('S desktop: the secondary\'s ring on action-accent only with a secondary; the tab underline falls back to the primary\'s ring', () => {
  const a = DV.computeThemeVars({ themeId: 'teal', primaryHex: '#0b1f3a', secondaryHex: '#facc15' });
  const b = DV.computeThemeVars({ themeId: 'teal', primaryHex: '#0b1f3a' });
  assert.ok(a.vars['action-accent'] && !('action-accent' in b.vars));
  assert.ok(DV.THEME_VAR_NAMES.includes('action-accent'));
  assert.match(dcss, /:root\[data-brand\] \.border-b-2:is\(\.border-action-500, \.border-action-600\) \{ border-color: rgb\(var\(--action-accent, var\(--action-ring\)\)\) !important; \}/);
});
ok('S the Branding preview draws the same accents (divider, marker, tab) from the secondary\'s ring', () => {
  const t = read('apps/dashboard/src/pages/settings/BrandingTab.tsx');
  assert.match(t, /const accent = s2 \? s2\.ring : null;/);
  assert.match(t, /inset 2px 0 0 \$\{accent \?\? k\.primary\}/);
  assert.match(t, /data-testid="preview-tabs"/);
});

// ── B: no flash ──────────────────────────────────────────────────────────────────────────────────────────────────
const VARS = W.computeDashboardThemeVars({ themes_enabled: true, primary_hex: '#e11d48', secondary_hex: '#0b1f3a' });
const LOOK = { logo: 'data:image/png;base64,iVBORw0KGgo=', primary: '#e11d48', secondary: '#0b1f3a', logoChip: 'dark' };
const withEnv = (ls, f) => {
  const root = fakeRoot();
  globalThis.localStorage = ls; globalThis.document = { documentElement: root };
  try { return f(root); } finally { delete globalThis.localStorage; delete globalThis.document; }
};
ok('B save → read back by business and as "last"; one business kept', () => withEnv(fakeStorage(), () => {
  W.saveBrandCache('biz-1', VARS, LOOK);
  W.saveBrandCache('biz-2', VARS, LOOK);
  assert.equal(W.readBrandCache('biz-1'), null, 'the other business dropped');
  assert.deepEqual(W.readBrandCache().look, LOOK);
  assert.deepEqual(W.readBrandCache('biz-2').vars, VARS);
}));
ok('B boot puts back the vars, the data-brand marks and the menu\'s logo before the first render', () => withEnv(fakeStorage(), (root) => {
  W.saveBrandCache('biz-1', VARS, LOOK);
  localStorage.setItem('swiftpos_access_token', 'x');
  W.bootBrandTheme();
  assert.equal(root._style.get('--bp-primary-l'), VARS['bp-primary-l']);
  assert.ok(root._attrs.has('data-brand') && root._attrs.has('data-brand-2'));
  assert.deepEqual(W.brandLook(), LOOK);
}));
ok('B nothing is put back without a sign-in token on this browser', () => withEnv(fakeStorage(), (root) => {
  W.saveBrandCache('biz-1', VARS, LOOK);
  W.bootBrandTheme();
  assert.equal(root._style.size, 0);
}));
ok('B a cache is only what ThemeLayer could write: unknown names, non-"r g b" values, another business, a bad logo dropped', () => {
  const c = W.cleanBrandCache({ bid: 'b', vars: { 'bp-primary-l': '1 2 3', 'evil': '1 2 3', 'bp-text-l': 'red;}' },
    look: { logo: 'javascript:x', primary: '#E11D48', logoChip: 'pink' } }, 'b');
  assert.deepEqual(c.vars, { 'bp-primary-l': '1 2 3' });
  assert.deepEqual(c.look, { logo: null, primary: '#e11d48', secondary: null });
  assert.equal(W.cleanBrandCache({ bid: 'a', vars: { 'bp-primary-l': '1 2 3' } }, 'b'), null);
});
ok('B a logo too big for storage is left out, the colours kept; clear removes everything; blocked storage never throws', () => {
  withEnv(fakeStorage(4000), () => {
    W.saveBrandCache('biz-1', VARS, { ...LOOK, logo: 'data:image/png;base64,' + 'A'.repeat(5000) });
    const c = W.readBrandCache(); assert.ok(c && c.look.logo === null && c.vars['bp-primary-l']);
    W.clearBrandCache(); assert.equal(localStorage.length, 0);
  });
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, get length() { throw new Error('blocked'); } };
  withEnv(blocked, () => { W.saveBrandCache('b', VARS, LOOK); W.clearBrandCache(); assert.equal(W.readBrandCache(), null); W.bootBrandTheme(); });
});
const html = read('apps/dashboard/index.html');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const runInline = (ls) => { const root = fakeRoot(); vm.runInNewContext(inline, { window: { localStorage: ls }, document: { documentElement: root } }); return root; };
ok('B index.html\'s inline script puts back the dark class and the cached look before the bundle (no external script)', () => {
  const ls = fakeStorage();
  withEnv(ls, () => W.saveBrandCache('biz-1', VARS, LOOK));
  ls.setItem('sb-abc-auth-token', '{}');
  const root = runInline(ls);
  assert.ok(root._attrs.has('class:dark') && root._attrs.has('data-brand') && root._attrs.has('data-brand-2'));
  assert.equal(root._style.get('--bp-ring-l'), VARS['bp-ring-l']);
  assert.ok(!/<script[^>]+src="http/.test(html));
  ls.setItem('swiftpos-theme', 'light'); assert.ok(!runInline(ls)._attrs.has('class:dark'));
});
ok('B the inline script takes only r g b values of brand names, and nothing without a sign-in', () => {
  const ls = fakeStorage();
  ls.setItem('swiftpos_pos_token', 'x'); ls.setItem('zaptill-brand:last', 'b');
  ls.setItem('zaptill-brand:b', JSON.stringify({ bid: 'b', vars: { 'bp-primary-l': 'red;}', 'color': '1 2 3', 'bp-text-l': '1 2 3' } }));
  const r = runInline(ls);
  assert.deepEqual([...r._style.entries()], [['--bp-text-l', '1 2 3']]);
  ls.removeItem('swiftpos_pos_token');
  assert.equal(runInline(ls)._style.size, 0);
});
ok('B ThemeLayer keeps the cached look while signing in, refreshes it on every apply, clears it on sign-out / themes off / another business', () => {
  const t = read('apps/dashboard/src/components/ThemeLayer.tsx');
  assert.match(t, /if \(signedOut\) \{ applyDashboardThemeVars\(null\); setBrandLook\(null\); clearBrandCache\(\); \}\n\s*return;/);
  assert.match(t, /const cached = readBrandCache\(businessId\);/);
  assert.match(t, /else if \(readBrandCache\(\)\) \{ applyDashboardThemeVars\(null\); setBrandLook\(null\); clearBrandCache\(\); \}/);
  assert.match(t, /if \(own\) saveBrandCache\(businessId, own, look\); else clearBrandCache\(\);/);
});

// ── N: the notification panels on a phone ────────────────────────────────────────────────────────────────────────
ok('N the admin bell: a portal on a solid surface, a phone sheet with a 12-px gutter, its list scrolling inside', () => {
  const b = read('apps/admin/src/NotificationBell.tsx');
  assert.match(b, /\{open && createPortal\(/);
  assert.match(b, /const PANEL_BG = "#0d1526";/);
  assert.match(b, /\? \{ left: 12, right: 12, top: 12, maxHeight: "calc\(100dvh - 24px\)" \}/);
  assert.match(b, /overflowY: "auto", overscrollBehavior: "contain", flex: 1, minHeight: 0/);
  assert.ok(!/\.\.\.S\.card, position: "absolute"/.test(b), 'no longer the see-through glass card');
  assert.ok(W.contrast('#8ea0bd', '#0d1526') >= 4.5 && W.contrast('#e8eef7', '#0d1526') >= 4.5, 'muted and text on the panel');
  assert.match(b, /!panel\.current\?\.contains\(t\)/);
});
ok('N the dashboard bell: out of the drawer on a phone (portal), outside clicks see the panel', () => {
  const l = read('apps/dashboard/src/components/DashboardLayout.tsx');
  assert.match(l, /isPhone \? createPortal\(bellPanel, document\.body\) : bellPanel/);
  assert.match(l, /!bellPanelRef\.current\?\.contains\(e\.target as Node\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
