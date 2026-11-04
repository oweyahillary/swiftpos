// One design for both POS — screens 2 and 3, the cart line and the product tile (owner decision 2026-11-04,
// docs/POS-SCREEN-COMPARISON.html; docs/SHARED-COMPONENTS-PLAN.md section 8j).
//
//   1  the cart line: sizes and add-ons as chips on both POS (@zaptill/ui LineChips — the web showed the sizes as text and
//      no add-ons); the desktop's Split bill for a restaurant opens the payment screen on "Split the bill"
//   2  the tile: "Later", "Sold out", "Options" — sentence case, the same words on both POS (@zaptill/ui TileBadges; the
//      desktop's ⚙ and capitals, the web's "LATER", "SOLD OUT", "options" gone)
//
// Mutations it catches (each tried): LineChips dropping the add-ons → section 1 fails; the desktop's Split bill shown to
// every business → section 1 fails; TileBadges showing Sold out with Later → section 2 fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split('\n')[0]}`); }
};

const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.cart-'));
let U;
try {
  const entry = path.join(bundleDir, 'entry.tsx');
  fs.writeFileSync(entry, "export { default as LineChips } from '@zaptill/ui/LineChips';\nexport { default as TileBadges, TILE_WORDS } from '@zaptill/ui/TileBadges';\n");
  await require('esbuild').build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(bundleDir, 'out.mjs'),
    logLevel: 'silent', jsx: 'automatic', preserveSymlinks: true, nodePaths: [path.join(DASH, 'node_modules')],
    external: ['react', 'react-dom', 'react/jsx-runtime'] });
  U = await import(pathToFileURL(path.join(bundleDir, 'out.mjs')).href);
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
const h = require('react').createElement;
const { renderToStaticMarkup: html } = require('react-dom/server');
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const desk = read('apps/desktop/src/renderer/pages/POSPage.tsx');
const web = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');

console.log('\n1. the cart line\n');
const LOOK = { row: 'r', variant: 'v', addOn: 'a' };
await ok('LineChips: the sizes, then the add-ons with +; nothing at all without either', () => {
  const out = html(h(U.LineChips, { variants: [{ optionId: '1', groupName: 'Size', optionName: 'Large' }], addOns: [{ optionId: '2', optionName: 'Extra cheese' }], look: LOOK }));
  assert.equal(text(out), 'Size: Large +Extra cheese');
  assert.match(out, /class="v"[^>]*>Size: Large</);
  assert.match(out, /class="a"[^>]*>\+Extra cheese</);
  assert.equal(html(h(U.LineChips, { variants: [], addOns: [], look: LOOK })), '');
});
await ok('both POS draw a line\'s chips with it (the web\'s one line of sizes is gone)', () => {
  assert.match(desk, /<LineChips variants=\{item\.selectedVariants\} addOns=\{item\.selectedModifiers\} look=\{LINE_CHIPS_LOOK\} \/>/);
  assert.match(web, /<LineChips variants=\{item\.selectedVariants\} addOns=\{item\.selectedModifiers\} look=\{LINE_CHIPS_LOOK\} \/>/);
  assert.doesNotMatch(web, /selectedVariants\.map\(\(v\) => `\$\{v\.groupName\}: \$\{v\.optionName\}`\)\.join/);
});
await ok('the desktop\'s Split bill: a restaurant only, the payment screen opened on "Split the bill"', () => {
  // 2026-11-04: in one row with Print bill and Transfer (the online licence's; apps/desktop/test/print-bill-transfer).
  assert.match(desk, /\{flags\.isRestaurant && cart\.length > 0 && \(\s*<div className="flex gap-2">\s*<button type="button" onClick=\{\(\) => openPayment\(true\)\}/);
  assert.match(desk, /startSplit=\{payStartsSplit\}/);
  assert.match(read('apps/desktop/src/renderer/components/PaymentModal.tsx'), /const \[showSplit, setShowSplit\] = useState\(startSplit\);/);
});

console.log('\n2. the tile\n');
const BADGE = { later: 'l', soldOut: 's', options: 'o' };
await ok('the words: Later, Sold out, Options — sentence case', () => {
  assert.deepEqual({ ...U.TILE_WORDS }, { later: 'Later', soldOut: 'Sold out', options: 'Options' });
  assert.equal(text(html(h(U.TileBadges, { later: false, soldOut: true, options: true, look: BADGE }))), 'Sold out Options');
  assert.equal(text(html(h(U.TileBadges, { later: true, soldOut: true, options: false, look: BADGE }))), 'Later', 'Later wins over Sold out');
  assert.equal(html(h(U.TileBadges, { later: false, soldOut: false, options: false, look: BADGE })), '');
});
await ok('both POS draw them with it; no capitals, no ⚙ left', () => {
  assert.match(desk, /<TileBadges later=\{later\} soldOut=\{soldOut\} options=\{!!\(product\.has_variants \|\| product\.has_modifiers\)\} look=\{TILE_BADGES_LOOK\} \/>/);
  assert.match(web, /<TileBadges later=\{later\} soldOut=\{soldOut\} options=\{hasVariants\} look=\{TILE_BADGES_LOOK\} \/>/);
  assert.doesNotMatch(desk, />⚙</);
  const deskLook = desk.slice(desk.indexOf('const TILE_BADGES_LOOK'), desk.indexOf('};', desk.indexOf('const TILE_BADGES_LOOK')));
  assert.doesNotMatch(deskLook, /uppercase/);
  assert.doesNotMatch(web, />(LATER|SOLD OUT|options)</);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
