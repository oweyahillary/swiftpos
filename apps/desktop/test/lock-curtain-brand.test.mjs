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
 * 0.6.25: the logo is bigger on the PIN screen and the lock screen (the owner found it small in a big white card).
 *
 * MUTATIONS TO CONFIRM BITE: the PIN logo back to 88 → its 0.6.25 pin fails; the logo card removed → "shows the logo" fails; the background back to /98 → "opaque"
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

// 0.6.25 (owner, PIN screen screenshot: "increase the size of the logo abit … the white space is big").
const pin = fs.readFileSync(path.join(DESKTOP, 'src/renderer/pages/PinPage.tsx'), 'utf8');
test('0.6.25: the PIN screen logo is up to 160 × 240 on a tight card', () => {
  assert.match(pin, /data-testid="pin-logo" className="inline-flex items-center justify-center bg-white rounded-xl" style=\{\{ padding: '8px 10px' \}\}>\s*<img src=\{logoDataUri\} alt="" style=\{\{ maxHeight: 160, maxWidth: 240,/);
});
test('0.6.25: the lock screen logo matches (up to 150 × 240)', () => {
  assert.match(src, /style=\{\{ padding: '8px 10px' \}\}>\s*<img src=\{logo\} alt="" style=\{\{ maxHeight: 150, maxWidth: 240,/);
});

// 0.6.25 (owner, manager screenshot: "Where its b foods can we add the logo there").
const mgr = fs.readFileSync(path.join(DESKTOP, 'src/renderer/pages/ManagerPage.tsx'), 'utf8');
test('0.6.25: the manager sidebar shows the logo beside the business name (icon only without one)', () => {
  assert.match(mgr, /posApi\.branding\.get\(\)\.then\(\(b\) => \{ if \(!cancelled\) setBrandLogo\(b\?\.logoPng \?\? null\); \}\)/);
  assert.match(mgr, /\{brandLogo \? \([\s\S]{0,250}data-testid="sidebar-logo"[\s\S]{0,300}<img src=\{brandLogo\}/);
  assert.match(mgr, /width: sidebarOpen \? 52 : 40/);   // fits the collapsed 64 px sidebar
});
// 0.6.25 (owner: "the size on the printer should not be too small").
const prep = fs.readFileSync(path.join(DESKTOP, 'src/renderer/lib/prepareRasterLogo.ts'), 'utf8');
const webTab = fs.readFileSync(path.join(DESKTOP, '..', 'dashboard/src/pages/settings/BrandingTab.tsx'), 'utf8');
test('0.6.25: a small logo is scaled UP to fill the receipt box, on the till and the web', () => {
  assert.match(prep, /const scale = Math\.min\(RECEIPT_MAX_W \/ bitmap\.width, RECEIPT_MAX_H \/ bitmap\.height\);/);
  assert.match(prep, /export const RECEIPT_MAX_H = 288;/);
  assert.match(webTab, /const scale = Math\.min\(RECEIPT_LOGO_MAX_WIDTH \/ bmp\.width, RECEIPT_LOGO_MAX_HEIGHT \/ bmp\.height\);/);
});

console.log(`\n${passed} passed`);
