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
if (!TILL || !AN) { console.error('Usage: node scripts/make-screens.mjs <till-shots-dir> <analytics-shots-dir>'); process.exit(1); }
const out = 'public/screens/';
const q = { quality: 80, effort: 6 };

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
