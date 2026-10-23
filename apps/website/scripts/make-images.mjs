// Rebuilds the site's static images in public/ (favicons, the Open Graph card, the Analytics crop).
// Run from apps/website: node scripts/make-images.mjs <path-to-analytics-screenshot.png>
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');
const ICON = '../desktop/resources/icon.png';
// The Analytics demo screenshot (1400 px wide, from the seeded demo restaurant; never a client's data).
const SHOT = process.argv[2];
if (!SHOT) { console.error('Usage: node scripts/make-images.mjs <analytics-demo-screenshot.png>'); process.exit(1); }
const out = 'public/';
await sharp(ICON).resize(256, 256).png({ compressionLevel: 9 }).toFile(out + 'favicon.png');
await sharp(ICON).resize(32, 32).png({ compressionLevel: 9 }).toFile(out + 'favicon-32.png');
await sharp(ICON).resize(180, 180).flatten({ background: '#061a1d' }).png({ compressionLevel: 9 }).toFile(out + 'apple-touch-icon.png');
const meta = await sharp(SHOT).metadata();
console.log('shot', meta.width, meta.height);
// Top of the page: the summary and the "Do this next" cards, cropped to 16:10.
await sharp(SHOT).extract({ left: 0, top: 0, width: 1400, height: 875 }).webp({ quality: 78 }).toFile(out + 'screens/analytics-demo.webp');
// Open Graph image: 1200x630, the wordmark and the headline on the night teal.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="#061a1d"/>
<circle cx="1050" cy="80" r="420" fill="#14b8a6" opacity="0.10"/>
<rect x="80" y="80" width="76" height="76" rx="18" fill="#050d12" stroke="#5eead4" stroke-width="3"/>
<path d="M100 104h36v9l-23.5 26.5h24V150H99v-9l23.5-26.5H100z" fill="#14b8a6"/>
<text x="176" y="135" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="46" fill="#e4efee">ZapTill</text>
<text x="80" y="300" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="72" fill="#ffffff">Know where every shilling</text>
<text x="80" y="385" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="72" fill="#ffffff">went, every single day.</text>
<text x="80" y="480" font-family="Segoe UI, Arial, sans-serif" font-size="32" fill="#9fb7b5">Tills, kitchen, M-Pesa and the day close, for businesses in Kenya.</text>
<rect x="80" y="530" width="120" height="6" rx="3" fill="#14b8a6"/>
</svg>`;
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out + 'og-zaptill.png');
console.log('done');
