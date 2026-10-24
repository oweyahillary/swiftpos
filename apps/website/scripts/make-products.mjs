// Turns the licensed stock photos (Unsplash, free licence: see src/data/photo-credits.json) into the demo products'
// square tiles: public/demo-products/<file>.webp, 400 x 400, at most 40 KB. The originals were downloaded once into the
// session scratchpad (stock-downloads/, images only) and are not kept in the repo.
//   node scripts/make-products.mjs <stock-downloads-dir>
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');
const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/make-products.mjs <stock-downloads-dir>'); process.exit(1); }
const { photos } = JSON.parse(readFileSync('src/data/photo-credits.json', 'utf8'));
mkdirSync('public/demo-products', { recursive: true });
for (const p of photos) {
  const src = `${dir}/${p.download}.jpg`;
  const m = await sharp(src).metadata();
  let img = sharp(src);
  if (p.crop) {   // [left, top, size] as fractions of the width/height
    const [l, t, s] = p.crop; const side = Math.round(Math.min(m.width, m.height) * s);
    img = img.extract({ left: Math.round(m.width * l), top: Math.round(m.height * t), width: Math.min(side, m.width - Math.round(m.width * l)), height: Math.min(side, m.height - Math.round(m.height * t)) });
  }
  const out = `public/demo-products/${p.file}`;
  let q = 72;
  for (;;) {
    await img.clone().resize(400, 400, { fit: 'cover', position: p.position || 'centre' }).webp({ quality: q, effort: 6 }).toFile(out);
    if (statSync(out).size <= 40 * 1024 || q <= 40) break;
    q -= 8;
  }
  console.log(p.file, Math.round(statSync(out).size / 1024) + ' KB');
}
