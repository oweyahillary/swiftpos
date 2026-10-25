// Turns the Phase 2 screenshots into the site's WebP screens in public/screens/.
// Every source is a capture of a MADE-UP demo business ("Mama Lishe Grill" on the till, the seeded demo restaurant in
// Analytics), never a client's.
//   node scripts/make-screens.mjs <till-shots-dir> <analytics-shots-dir>
// Till shots: the real till renderer (apps/desktop/dist/renderer) in headless Chromium with a stubbed preload and demo
// data; the harness lives outside the repo (see docs/website/WEBSITE-LOG.md, Night 1 Phase 2).
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');
const [TILL, AN] = process.argv.slice(2);
const out = 'public/screens/';
const q = { quality: 80, effort: 6 };

// 2026-10-23, every business type: node scripts/make-screens.mjs --trades <till-shots-dir>. The shop and petrol tills
// (tools/till-shots: EXTRA=shop.js s-shop.cjs, EXTRA=petrol.js s-pumps.cjs), 1920x1200 captures down to 1280x800, and
// the two keypads cropped from them. FICTIONAL demo brands (src/assets/demo-brands): Kijani Basket, Kifaru Fuel & Mart and
// Mama Lishe Grill.
if (TILL === '--trades') {
  const dir = AN;
  if (!dir) { console.error('Usage: node scripts/make-screens.mjs --trades <till-shots-dir>'); process.exit(1); }
  // The restaurant screens again, now with Mama Lishe Grill's branding (its colour strip, its logo on the PIN screen) and
  // the dishes' photos; and Kijani Basket's PIN screen with its logo.
  for (const n of ['pin', 'float', 'pos', 'split']) await sharp(`${dir}/${n}.png`).resize({ width: 1280 }).webp(q).toFile(`${out}till-${n}.webp`);
  await sharp(`${dir}/shop-pin.png`).resize({ width: 1280 }).webp(q).toFile(`${out}till-shop-pin.webp`);
  await sharp(`${dir}/shop-pos.png`).resize({ width: 1280 }).webp(q).toFile(`${out}till-shop.webp`);
  await sharp(`${dir}/petrol-sale.png`).resize({ width: 1280 }).webp(q).toFile(`${out}till-pumps.webp`);
  await sharp(`${dir}/shop-weigh.png`).extract({ left: 674, top: 232, width: 572, height: 736 }).resize({ width: 480 }).webp(q).toFile(`${out}till-weigh.webp`);
  await sharp(`${dir}/petrol-panel.png`).extract({ left: 628, top: 278, width: 664, height: 644 }).resize({ width: 520 }).webp(q).toFile(`${out}till-pump-entry.webp`);
  console.log('done (trades)');
  process.exit(0);
}
if (!TILL || !AN) { console.error('Usage: node scripts/make-screens.mjs <till-shots-dir> <analytics-shots-dir>'); process.exit(1); }

// Till screens: 1920x1200 captures (1280x800 at 1.5x) down to 1280x800.
for (const n of ['pin', 'float', 'pos', 'split']) {
  await sharp(`${TILL}/${n}.png`).resize({ width: 1280 }).webp(q).toFile(`${out}till-${n}.webp`);
}
// The till's shift report: each cashier's expected cash, counted and difference.
await sharp(`${TILL}/shiftcard.png`).resize({ width: 1200 }).webp(q).toFile(`${out}till-shifts.webp`);

// Analytics: the money-leaks charts and the credit-age card (the debtor list is left out on purpose).
await sharp(`${AN}/analytics-v2-leaks.png`).extract({ left: 22, top: 1180, width: 1396, height: 285 }).webp(q).toFile(`${out}analytics-leaks.webp`);
await sharp(`${AN}/analytics-v2-credit.png`).extract({ left: 22, top: 1075, width: 552, height: 172 }).webp(q).toFile(`${out}analytics-credit.webp`);
console.log('done');
