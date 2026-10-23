// Checks the built site in dist/ (run `npm run build` first): node scripts/check-dist.mjs  (or npm run check)
//
//   - every internal link and #anchor resolves to a page or file in dist/
//   - every page has a <title>, a meta description, a canonical link and exactly one <h1>
//   - headings never skip a level going down (an h2 is not followed by an h4)
//   - every <img> has alt text (or is aria-hidden), a width and a height; at most one image a page loads eagerly
//   - every JSON-LD block parses
//   - page weight: the HTML plus the CSS, scripts and images it references (Google Fonts are external and not counted)
//
// Prints a table of page weights and exits 1 if any check fails.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(DIST)) { console.error('dist/ not found: run npm run build first'); process.exit(1); }

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(DIST);
const pages = files.filter((f) => f.endsWith('.html'));
const errors = [];
const err = (page, msg) => errors.push(`${page}: ${msg}`);

const urlOf = (file) => '/' + relative(DIST, file).replace(/\\/g, '/').replace(/index\.html$/, '').replace(/\.html$/, '');
const idsByUrl = new Map();
const htmlByUrl = new Map();
for (const f of pages) {
  const html = readFileSync(f, 'utf8');
  htmlByUrl.set(urlOf(f), { html, file: f });
  idsByUrl.set(urlOf(f), new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

/** dist/ path for a site URL: /a/ -> a/index.html, /x.png -> x.png. */
function resolve(pathname) {
  const clean = decodeURIComponent(pathname);
  if (clean.endsWith('/')) return join(DIST, clean, 'index.html');
  const direct = join(DIST, clean);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const asDir = join(DIST, clean, 'index.html');
  if (existsSync(asDir)) return asDir;
  const asHtml = join(DIST, clean + '.html');
  return existsSync(asHtml) ? asHtml : direct;
}
const size = (p) => (existsSync(p) ? statSync(p).size : 0);

const rows = [];
let external = 0;
for (const [url, { html, file }] of htmlByUrl) {
  const is404 = url === '/404';
  // Head
  if (!/<title>[^<]{5,}<\/title>/.test(html)) err(url, 'no <title>');
  if (!/<meta name="description" content="[^"]{30,}"/.test(html)) err(url, 'no meta description');
  if (!is404 && !/<link rel="canonical" href="https:\/\/zaptill\.co\.ke\/[^"]*"/.test(html)) err(url, 'no canonical link');
  // Headings
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  const h1s = levels.filter((l) => l === 1).length;
  if (h1s !== 1) err(url, `${h1s} <h1> elements (want 1)`);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) { err(url, `heading jumps from h${levels[i - 1]} to h${levels[i]}`); break; }
  }
  // Images
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  let eager = 0;
  for (const tag of imgs) {
    const src = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    const alt = (tag.match(/\salt="([^"]*)"/) || [])[1];
    if (!/aria-hidden="true"/.test(tag) && !alt) err(url, `image without alt text: ${src}`);
    if (!/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag)) err(url, `image without width/height: ${src}`);
    if (!/loading="lazy"/.test(tag)) eager++;
  }
  if (eager > 1) err(url, `${eager} images load eagerly (want at most 1, the first screenful)`);
  // JSON-LD
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { err(url, `JSON-LD does not parse: ${e.message}`); }
  }
  // Links and assets
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const assets = new Set();
  for (const ref of refs) {
    if (/^(https?:|mailto:|tel:|data:)/.test(ref)) {
      if (/^https?:\/\/(zaptill\.co\.ke)(\/|$)/.test(ref)) continue;   // canonical / og:url: our own absolute URLs
      external++;
      continue;
    }
    const [pathPart, hash] = ref.split('#');
    const target = pathPart === '' ? url : pathPart;
    if (!target.startsWith('/')) { err(url, `relative link: ${ref}`); continue; }
    const f = resolve(target);
    if (!existsSync(f)) { err(url, `broken link: ${ref}`); continue; }
    if (hash) {
      const ids = idsByUrl.get(urlOf(f));
      if (ids && !ids.has(hash)) err(url, `missing anchor: ${ref}`);
    }
    if (/\.(css|js|webp|png|jpg|svg)$/.test(target)) assets.add(f);
  }
  const assetBytes = [...assets].reduce((a, f) => a + size(f), 0);
  // og:image and favicons are not downloaded with the page.
  const heavy = [...assets].filter((f) => !/og[\\/]|og-zaptill|favicon|apple-touch/.test(f));
  const pageBytes = Buffer.byteLength(html) + heavy.reduce((a, f) => a + size(f), 0);
  rows.push({ url, html: Buffer.byteLength(html), assets: assetBytes, page: pageBytes });
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`.padStart(7);
console.log('Page weight (HTML + CSS + JS + images; Google Fonts not counted)');
for (const r of rows.sort((a, b) => a.url.localeCompare(b.url))) console.log(`  ${r.url.padEnd(24)} ${kb(r.page)}   (HTML ${kb(r.html).trim()})`);
const heaviest = Math.max(...rows.map((r) => r.page));
if (heaviest > 1.5 * 1024 * 1024) errors.push(`a page is over 1.5 MB (${kb(heaviest)})`);
console.log(`${pages.length} pages, ${external} external links (not fetched), heaviest page ${kb(heaviest).trim()}`);
if (errors.length) { console.log(`\n${errors.length} problem(s):`); for (const e of errors) console.log('  ' + e); process.exit(1); }
console.log('All links resolve; titles, descriptions, canonicals, headings, alt text and JSON-LD are in order.');
