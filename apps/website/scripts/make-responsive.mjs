// Smaller copies of the wide screenshots and video posters, for phones (night 3).
// node scripts/make-responsive.mjs   (run after make-screens.mjs or tools/video/render.cjs re-make an image)
//
// For every public/screens/*.webp and public/video/*-poster.webp at least 1000 px wide, writes <name>-800.webp
// (800 px wide). Shot.astro and ProductVideo.astro add it to srcset when the file exists, so a phone downloads the
// 800 px copy and a desktop the full one. Never edits the originals.
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');

export const SMALL_W = 800;
const dirs = ['public/screens', 'public/video'];
for (const dir of dirs) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.webp') || /-\d+\.webp$/.test(f)) continue;
    if (dir.endsWith('video') && !f.endsWith('-poster.webp')) continue;
    const src = `${dir}/${f}`;
    const { width } = await sharp(src).metadata();
    if (width < 1000) continue;
    const out = src.replace(/\.webp$/, `-${SMALL_W}.webp`);
    const info = await sharp(src).resize({ width: SMALL_W }).webp({ quality: 80, effort: 6 }).toFile(out);
    console.log(`${out}  ${width} -> ${info.width} x ${info.height}  ${(info.size / 1024).toFixed(0)} KB`);
  }
}
