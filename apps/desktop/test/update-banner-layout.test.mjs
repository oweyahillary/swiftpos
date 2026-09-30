/**
 * update-banner-layout.test.mjs — 0.6.24: the update bar never covers the till's controls.
 *
 * Owner, 2026-09-30 (screenshot: "Update ready" sitting over the Close Day button): "can we make the update banner not
 * block user activity".
 *
 *   node test/update-banner-layout.test.mjs
 *
 * Pins the source (React is not run): the bar publishes its height as --update-banner-h and resets it to 0px when it
 * goes; the working screens use .app-screen (100vh less that height) instead of h-screen; the sync notice rides above
 * the bar; the bar sits below modals.
 *
 * MUTATIONS TO CONFIRM BITE: ManagerPage back on h-screen → its pin fails; the 0px reset dropped → "cleared" fails;
 * .app-screen without the variable → the CSS pin fails; the bar back on z-50 → "below modals" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const banner = read('src/renderer/pages/UpdateBanner.tsx');
const css = read('src/renderer/index.css');
const manager = read('src/renderer/pages/ManagerPage.tsx');
const pos = read('src/renderer/pages/POSPage.tsx');

test('the bar publishes its height as --update-banner-h', () => {
  assert.match(banner, /setProperty\('--update-banner-h', `\$\{el\.offsetHeight\}px`\)/);
  assert.match(banner, /new ResizeObserver\(publish\)/);
});
test('the height is cleared to 0px when the bar goes (hidden, dismissed, unmounted)', () => {
  const zeros = banner.match(/setProperty\('--update-banner-h', '0px'\)/g) ?? [];
  assert.equal(zeros.length, 2, 'once when not shown, once in the cleanup');
});
test('the bar sits below modals (z-40), so a dialog is never under it', () => {
  assert.match(banner, /data-testid="update-banner"[\s\S]{0,40}className="fixed bottom-0 inset-x-0 z-40 /);
  assert.doesNotMatch(banner, /z-50/);
});
test('.app-screen is the viewport less the bar', () => {
  assert.match(css, /\.app-screen\s*\{\s*height:\s*calc\(100vh - var\(--update-banner-h, 0px\)\);\s*\}/);
  assert.match(css, /\.app-screen-min\s*\{\s*min-height:\s*calc\(100vh - var\(--update-banner-h, 0px\)\);\s*\}/);
});
test('the manager, POS and receipt screens stop above the bar', () => {
  assert.match(manager, /<div className="flex app-screen bg-gray-950 text-white overflow-hidden">/);
  assert.doesNotMatch(manager, /\bh-screen\b/);
  assert.match(pos, /<div className="app-screen flex flex-col bg-gray-950">/);
  assert.match(pos, /<div className="app-screen-min bg-gray-950 flex items-center justify-center px-4">/, 'the receipt screen');
  assert.doesNotMatch(pos, /\bh-screen\b/);
});
test('the sync notice rides above the bar', () => {
  assert.match(pos, /data-testid="sync-notice"\s*style=\{\{ bottom: 'calc\(0\.75rem \+ var\(--update-banner-h, 0px\)\)' \}\}/);
});

console.log(`\n${passed} passed`);
