/**
 * font-global.test.mjs — one body font, set once (owner, 2026-11-03: Source Sans 3 for the screens, the ZapTill name and
 * logo keep their brand font; "cant we set a global variable rather than having it everywhere").
 *
 *   node tests/font-global.test.mjs
 *
 * Each app sets `--font-body` once in its index.css; Tailwind's font-sans reads it; the font's files are bundled (each
 * app's main.tsx imports @fontsource-variable/source-sans-3), so the desktop POS shows it offline too. A screen never
 * names a font of its own: allowed are `inherit`, the variable, a monospace stack (codes, receipts, printouts), Courier
 * New (printed receipts) and Space Grotesk (the brand).
 *
 * MUTATION CHECK: put `fontFamily: "'DM Sans', sans-serif"` back on any web POS screen → "no screen names a font of its
 * own" fails; drop the import from a main.tsx → "the font's files are bundled" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

const APPS = [
  { name: 'dashboard', css: 'apps/dashboard/src/index.css', main: 'apps/dashboard/src/main.tsx', tailwind: 'apps/dashboard/tailwind.config.js' },
  { name: 'desktop',   css: 'apps/desktop/src/renderer/index.css', main: 'apps/desktop/src/renderer/main.tsx', tailwind: 'apps/desktop/tailwind.config.js' },
  { name: 'admin',     css: 'apps/admin/src/index.css', main: 'apps/admin/src/main.tsx', tailwind: null },
];
const SCREEN_DIRS = ['apps/dashboard/src', 'apps/desktop/src/renderer', 'apps/desktop/src/shared', 'apps/admin/src'];

/** Printouts open in their own window, where the app's variable does not exist — they keep the system font. */
const OWN_WINDOW = new Set([
  'apps/dashboard/src/pages/HelpPage.tsx', 'apps/desktop/src/renderer/components/HelpScreen.tsx',   // the printed Help
  'apps/dashboard/src/lib/printDocument.ts',                                                          // A4 documents
]);

/** Is this font-family value one a screen may name? */
function allowed(value) {
  const v = value.replace(/["'`]/g, '').trim();
  return /^(inherit|var\(--font-body)/.test(v) || /monospace/.test(v) || /Courier/.test(v) || /Space Grotesk/.test(v);
}

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(rel);
  }
  return out;
}

console.log('\nOne body font, set once (Source Sans 3)\n');

ok('each app sets --font-body once, to Source Sans 3', () => {
  for (const a of APPS) {
    const defs = read(a.css).match(/--font-body:\s*'Source Sans 3 Variable'/g) ?? [];
    assert.equal(defs.length, 1, `${a.css}: ${defs.length} definitions`);
  }
});
ok('Tailwind\'s font-sans is the variable (every screen, button and input follows)', () => {
  for (const a of APPS.filter((x) => x.tailwind)) assert.match(read(a.tailwind), /sans: \['var\(--font-body\)'\]/, a.tailwind);
  assert.match(read('apps/admin/src/index.css'), /font-family: var\(--font-body\);/);
});
ok('the font\'s files are bundled by each app (offline too) — never fetched from Google', () => {
  for (const a of APPS) assert.match(read(a.main), /import '@fontsource-variable\/source-sans-3';/, a.main);
  assert.doesNotMatch(read('apps/admin/index.html'), /DM\+Sans/);
  assert.doesNotMatch(read('apps/admin/src/index.css'), /family=Inter/);
});
ok('no screen names a font of its own (inherit, the variable, monospace, Courier New or the brand\'s Space Grotesk)', () => {
  const bad = [];
  for (const dir of SCREEN_DIRS) {
    for (const file of sources(dir)) {
      if (OWN_WINDOW.has(file) || APPS.some((a) => a.css === file)) continue;
      for (const m of read(file).matchAll(/font-?[Ff]amily\s*:\s*([^;}\n]+)/g)) {
        if (!allowed(m[1])) bad.push(`${file}: ${m[1].trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
