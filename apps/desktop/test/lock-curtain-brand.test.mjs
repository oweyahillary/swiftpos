/**
 * lock-curtain-brand.test.mjs — 0.6.24: the locked till shows the client's logo, and its text is readable.
 *
 * Owner, 2026-09-30 (screenshot of "Till locked" over a blurred screen): "add the organization logo where the till is,
 * the small wordings are not readable".
 *
 *   node test/lock-curtain-brand.test.mjs
 *
 * Pins the source (React is not run): the curtain reads the logo like the PIN screen (branding:get, refreshed on a pull)
 * and shows it on a white card, the padlock only when there is none; the background is opaque — `bg-gray-950/98` is not
 * a Tailwind opacity step, so it generated nothing and the screen behind showed through the text.
 *
 * MUTATIONS TO CONFIRM BITE: the logo card removed → "shows the logo" fails; the background back to /98 → "opaque"
 * fails; the pull listener dropped → "refreshed" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(DESKTOP, 'src/renderer/components/LockCurtain.tsx'), 'utf8');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test('reads the client logo (branding:get)', () => {
  assert.match(src, /posApi\.branding\.get\(\)\.then\(\(b\) => \{ if \(!cancelled\) setLogo\(b\?\.logoPng \?\? null\); \}\)/);
});
test('refreshed when a pull lands, like the PIN screen', () => {
  assert.match(src, /const unsubscribe = posApi\.pos\.onCatalogueChanged\(load\);/);
});
test('shows the logo on a white card; the padlock only without one', () => {
  assert.match(src, /\{logo \? \([\s\S]{0,300}data-testid="lock-logo"[\s\S]{0,200}bg-white[\s\S]{0,200}<img src=\{logo\}/);
  assert.match(src, /\) : \(\s*<div className="w-16 h-16[\s\S]{0,300}<rect x="3" y="11"/);
});
test('the background is opaque (nothing shows through the text)', () => {
  assert.match(src, /data-testid="lock-curtain" className="fixed inset-0 z-\[9999\] bg-gray-950 flex/);
  assert.doesNotMatch(src, /className="[^"]*bg-gray-950\/98/);
});
test('the small text is brighter and larger', () => {
  assert.match(src, /<p className="text-base text-gray-200 mt-1">/);
  assert.match(src, /<p className="text-sm text-gray-400 mt-3">/);
});

console.log(`\n${passed} passed`);
