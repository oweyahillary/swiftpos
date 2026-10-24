// Renders the product videos frame by frame on stage.html and encodes them (ffmpeg on PATH: H.264 MP4 + VP9 WebM, and a
// WebP poster). Every screen is real: the till renderer's states (tools/till-shots clip-*.cjs, STATES dir), the site's
// own receipts and phone summary (element captures of the built site), the dashboard's Analytics captures
// (docs/website/screenshots). Demo businesses are FICTIONAL (src/assets/demo-brands).
//   STATES=<dir> node render.cjs [reel|shop|grill|fuel|owner ...]
// Needs playwright-core on NODE_PATH and Chromium (CHROME or Playwright's default path), and sharp (apps/website).
const { chromium } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const { execFileSync } = require('child_process');
const sharp = require(path.resolve(__dirname, '../../node_modules/sharp'));
const exe = process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const ST = process.env.STATES; if (!ST) { console.error('STATES=<dir> needed'); process.exit(1); }
const SITE = path.resolve(__dirname, '../..');
const OUT = path.join(SITE, 'public/video');
const FPS = 30;
const url = (f) => 'file:///' + f.replace(/\\/g, '/');
const st = (k) => JSON.parse(fs.readFileSync(path.join(ST, k + '.json'), 'utf8'));
const brand = (id, name) => ({ name, mark: url(path.join(SITE, `public/demo-brands/${id}-mark.png`)) });
const KIJANI = brand('kijani-basket', 'Kijani Basket'), GRILL = brand('mama-lishe-grill', 'Mama Lishe Grill'), KIFARU = brand('kifaru-fuel', 'Kifaru Fuel & Mart');

/** A till scene: [stateIndex, at] pairs; the first is shown from the start. */
function till(prefix, pairs, start, end, extra) {
  const s = st(prefix);
  return { device: 'monitor', start, end, frames: pairs.map(([i, at]) => ({ src: url(path.join(ST, s[i].file)), at, tap: s[i].tap })), ...extra };
}
async function natural(file) { const m = await sharp(file).metadata(); return { w: m.width, h: m.height }; }
async function slip(file, start, end, extra) {
  const f = path.join(ST, file); const n = await natural(f);
  const shown = (n.h * 400) / n.w, room = 640;
  const maxY = Math.max(0, ((shown - room) * n.w) / 400);
  return { device: 'slip', start, end, natural: n.w, frames: [{ src: url(f), at: start }],
    scroll: [{ t: start + 0.5, y: 0 }, { t: end - 0.4, y: maxY }], ...extra };
}
async function phone(file, start, end, fromY, toY, extra) {
  const n = await natural(file);
  return { device: 'phone', start, end, natural: n.w, frames: [{ src: url(file), at: start }], scroll: [{ t: start + 0.4, y: fromY }, { t: end - 0.3, y: toY }], ...extra };
}
async function laptop(file, start, end, extra) {
  const n = await natural(file);
  return { device: 'laptop', start, end, natural: n.w, frames: [{ src: url(file), at: start }],
    cam: [{ t: start, s: 1, fx: n.w / 2, fy: n.h / 2 }, { t: end, s: 1.06, fx: n.w * 0.55, fy: n.h * 0.45 }], ...extra };
}
const cam = (...k) => k.map(([t, s, fx = 640, fy = 400]) => ({ t, s, fx, fy }));
const DASH = path.resolve(SITE, '../../docs/website/screenshots');

async function specs() {
  const phoneCap = path.join(ST, 'analytics-phone.png');
  if (!fs.existsSync(phoneCap)) await sharp(path.join(DASH, 'app-analytics-phone.webp')).extract({ left: 0, top: 0, width: 390, height: 2600 }).png().toFile(phoneCap);
  const branches = path.join(ST, 'analytics-branches.png');
  if (!fs.existsSync(branches)) await sharp(path.join(DASH, 'app-analytics-branches.webp')).png().toFile(branches);
  const summary = path.join(ST, 'phone-summary.png');
  return {
    shop: { dur: 12.2, poster: 6.6, scenes: [
      till('shop', [[0, 0], [1, 1.0], [2, 1.5], [3, 2.0], [4, 2.5], [5, 3.0], [6, 3.7], [7, 4.35], [8, 4.65], [9, 4.95], [10, 5.25], [11, 5.55], [12, 6.25], [13, 7.1], [14, 7.8]], 0, 8.8, {
        brand: KIJANI, ptrOff: 8.2,
        cam: cam([0, 1], [3.3, 1.04], [3.95, 1.45, 640, 400], [5.85, 1.45, 640, 400], [6.5, 1.3, 1100, 560], [6.9, 1.3, 1100, 560], [7.35, 1.4, 640, 410], [8.8, 1.42, 640, 410]),
        caps: [{ t0: 0.3, t1: 3.45, n: 1, text: 'Scan or tap: milk, bread, flour, eggs' }, { t0: 3.6, t1: 6.95, n: 2, text: 'Weigh the beef: 0.640 kg' }, { t0: 7.05, t1: 8.75, n: 3, text: 'Pay by M-Pesa' }] }),
      await slip('slip-shop.png', 8.8, 12.2, { brand: KIJANI, caps: [{ t0: 9.0, t1: 12.1, n: 4, text: 'The receipt prints, with your logo' }] }),
    ] },
    grill: { dur: 12.0, poster: 5.95, scenes: [
      till('grill', [[0, 0], [1, 0.9], [2, 1.6], [3, 2.2], [4, 2.75], [5, 3.2], [6, 3.7], [7, 4.15], [8, 4.55], [9, 5.1], [10, 5.55], [11, 5.95], [12, 6.5], [13, 7.0], [14, 7.4], [15, 8.1]], 0, 8.9, {
        brand: GRILL, ptrOff: 8.5,
        cam: cam([0, 1], [2.3, 1], [2.6, 1.35, 640, 420], [4.6, 1.35, 640, 420], [5.0, 1], [7.5, 1], [8.0, 1.5, 1046, 230], [8.9, 1.52, 1046, 230]),
        caps: [{ t0: 0.3, t1: 2.35, n: 1, text: 'Table 4: tap the dishes' }, { t0: 2.45, t1: 6.2, n: 2, text: 'Spicy, on the dish’s own line' }, { t0: 7.45, t1: 8.85, n: 3, text: 'Send it to the kitchen' }] }),
      await slip('slip-kitchen.png', 8.9, 12.0, { brand: GRILL, caps: [{ t0: 9.1, t1: 11.9, n: 4, text: 'The kitchen ticket prints at once' }] }),
    ] },
    fuel: { dur: 9.6, poster: 2.2, scenes: [
      till('fuel', [[0, 0], [1, 0.9], [2, 1.7], [3, 2.4], [4, 3.1], [5, 3.8], [6, 4.4], [7, 5.1]], 0, 6.0, {
        brand: KIFARU, ptrOff: 5.4,
        cam: cam([0, 1], [1.0, 1], [1.35, 1.4, 640, 400], [2.55, 1.4, 640, 400], [2.9, 1], [3.5, 1], [3.85, 1.3, 1120, 300], [4.9, 1.3, 1120, 300], [5.3, 1]),
        caps: [{ t0: 0.3, t1: 2.75, n: 1, text: 'Tap the pump, then KES 2,000' }, { t0: 3.3, t1: 5.0, n: 2, text: 'Scan the oil and the water' }, { t0: 5.1, t1: 5.95, n: 3, text: 'Fuel and shop on one sale' }] }),
      await slip('slip-fuel.png', 6.0, 9.6, { brand: KIFARU, caps: [{ t0: 6.2, t1: 9.5, n: 4, text: 'Litres and shillings on the receipt' }] }),
    ] },
    owner: { dur: 10.8, poster: 5.4, scenes: [
      await phone(summary, 0, 3.2, 0, 0, { brand: GRILL, caps: [{ t0: 0.3, t1: 3.1, n: 1, text: 'The day’s numbers, on your phone' }] }),
      await phone(phoneCap, 3.2, 7.6, 0, 1450, { brand: GRILL, caps: [{ t0: 3.4, t1: 7.5, n: 2, text: 'Do this next: what to order, and when' }] }),
      await laptop(branches, 7.6, 10.8, { brand: GRILL, caps: [{ t0: 7.8, t1: 10.7, n: 3, text: 'Every branch, side by side' }] }),
    ] },
    reel: { dur: 18.6, poster: 1.9, scenes: [
      till('shop', [[0, 0], [1, 0.7], [3, 1.2], [5, 1.7], [6, 2.3], [9, 2.8], [11, 3.2], [12, 3.8], [13, 4.25], [14, 4.75]], 0, 5.4, {
        brand: KIJANI, ptrOff: 5.0,
        cam: cam([0, 1], [2.0, 1.03], [2.5, 1.4, 640, 400], [3.5, 1.4, 640, 400], [3.95, 1.25, 1100, 560], [4.3, 1.35, 640, 410], [5.4, 1.36, 640, 410]),
        caps: [{ t0: 0.2, t1: 2.15, n: 1, text: 'A minimart: scan or tap' }, { t0: 2.25, t1: 3.9, n: 2, text: 'Weigh it: 0.640 kg' }, { t0: 4.0, t1: 5.35, n: 3, text: 'Pay by M-Pesa' }] }),
      await slip('slip-shop.png', 5.4, 7.0, { brand: KIJANI, caps: [{ t0: 5.5, t1: 6.95, n: 4, text: 'Your logo on the receipt' }] }),
      till('grill', [[1, 7.0], [2, 7.45], [3, 7.8], [4, 8.15], [5, 8.45], [6, 8.75], [7, 9.05], [8, 9.35], [9, 9.65], [10, 9.95], [11, 10.25], [12, 10.6], [13, 10.95], [14, 11.25], [15, 11.8]], 7.0, 12.4, {
        brand: GRILL, ptrOff: 12.1,
        cam: cam([7.0, 1], [11.3, 1], [11.75, 1.5, 1046, 230], [12.4, 1.5, 1046, 230]),
        caps: [{ t0: 7.15, t1: 8.4, n: 1, text: 'A restaurant: tap the dishes' }, { t0: 8.45, t1: 10.5, n: 2, text: 'Spicy, on the dish’s own line' }, { t0: 11.0, t1: 12.35, n: 3, text: 'Send it to the kitchen' }] }),
      await slip('slip-kitchen.png', 12.4, 13.9, { brand: GRILL, caps: [{ t0: 12.5, t1: 13.85, n: 4, text: 'The kitchen ticket prints' }] }),
      await phone(summary, 13.9, 15.9, 0, 0, { brand: GRILL, caps: [{ t0: 14.0, t1: 15.85, n: 5, text: 'The owner sees the day' }] }),
      await phone(phoneCap, 15.9, 18.6, 0, 1100, { brand: GRILL, caps: [{ t0: 16.0, t1: 18.5, n: 6, text: 'and what to do next' }] }),
    ] },
  };
}

(async () => {
  const want = process.argv.slice(2); const all = await specs();
  const names = want.length ? want : Object.keys(all);
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: exe });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  for (const name of names) {
    const spec = all[name];
    const frames = path.join(ST, 'frames-' + name); fs.rmSync(frames, { recursive: true, force: true }); fs.mkdirSync(frames, { recursive: true });
    await p.goto(url(path.join(__dirname, 'stage.html')));
    await p.evaluate((s) => { window.SPEC = s; }, spec);
    await p.evaluate(() => window.ready());
    const n = Math.round(spec.dur * FPS);
    for (let i = 0; i < n; i++) {
      await p.evaluate((t) => window.render(t), i / FPS);
      await p.screenshot({ path: path.join(frames, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
    }
    // The poster: one frame, as a WebP.
    await p.evaluate((t) => window.render(t), spec.poster);
    const posterPng = path.join(frames, 'poster.png'); await p.screenshot({ path: posterPng });
    await sharp(posterPng).resize({ width: 1280 }).webp({ quality: 74, effort: 6 }).toFile(path.join(OUT, `${name}-poster.webp`));
    const inp = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%05d.jpg'), '-vf', 'scale=1280:720:flags=lanczos:out_range=tv,format=yuv420p', '-an'];
    execFileSync('ffmpeg', [...inp, '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF || (name === 'reel' ? '30' : '27'), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', path.join(OUT, `${name}.mp4`)]);
    execFileSync('ffmpeg', [...inp, '-c:v', 'libvpx-vp9', '-crf', process.env.VP9CRF || (name === 'reel' ? '44' : '40'), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', path.join(OUT, `${name}.webm`)]);
    const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    console.log(name, `${n} frames`, `mp4 ${kb(name + '.mp4')} KB`, `webm ${kb(name + '.webm')} KB`, `poster ${kb(name + '-poster.webp')} KB`);
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
