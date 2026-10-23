// Makes one Open Graph card (1200x630 PNG) per page into public/og/, from one template: the wordmark, the page's own
// headline and a line under it, on the night teal, with a strip of thermal paper on the right (the site's signature).
// Run from apps/website: node scripts/make-og.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');

const CARDS = [
  { slug: 'how-it-works', kicker: 'How it works', lines: ['A day with ZapTill,', 'from PIN to phone.'], sub: 'The morning float, the lunch rush, the kitchen, the close, the email at night.' },
  { slug: 'features', kicker: 'Features', lines: ['Everything it does,', 'grouped by job.'], sub: 'Sell, kitchen, day close, stock, staff, branches, Analytics, offline.' },
  { slug: 'who-its-for', kicker: "Who it's for", lines: ['Made for the way', 'your place works.'], sub: 'Restaurants, bars, quick service and shops in Kenya.' },
  { slug: 'restaurants', kicker: 'For restaurants and cafés', lines: ['From the order to the plate,', 'nothing gets lost.'], sub: 'Kitchen tickets with extras and notes, tables, M-Pesa, the day close.' },
  { slug: 'bars', kicker: 'For bars and lounges', lines: ["Know whose drawer is short", 'before the lights go off.'], sub: 'Over and short by name, voids with a manager PIN, credit for regulars.' },
  { slug: 'quick-service', kicker: 'For quick service', lines: ['Faster at the counter.', 'Right in the bag.'], sub: 'Combos on one line, dispatch tickets that count the bags, offers.' },
  { slug: 'retail', kicker: 'For shops', lines: ['Stock that adds up.', 'A till that never stops.'], sub: 'Departments, barcodes and labels, stock, transfers and drawers by cashier.' },
  { slug: 'analytics', kicker: 'ZapTill Analytics', lines: ['Know what to do next,', 'in plain words.'], sub: 'What to order, what to prepare each day, which branch needs stock.' },
  { slug: 'pricing', kicker: 'Pricing', lines: ['Pay once for the tills.', 'About KES 100 a day for the cloud.'], sub: 'Per branch, the first month of the cloud free. No percentage of sales.' },
  { slug: 'contact', kicker: 'Contact', lines: ['Talk to a person,', 'on WhatsApp.'], sub: 'Call or WhatsApp 0717 675 635, or book a visit.' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const font = 'Segoe UI, Arial, sans-serif';

function svg({ kicker, lines, sub }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="#061a1d"/>
<circle cx="1080" cy="40" r="380" fill="#14b8a6" opacity="0.10"/>
<g transform="translate(1000 96) rotate(3)">
  <rect width="170" height="470" fill="#fffefa"/>
  ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `<rect x="20" y="${40 + i * 30}" width="${[110, 80, 130, 130, 96, 130, 70, 130, 116, 130, 88, 52, 100][i]}" height="8" rx="2" fill="#23292b" opacity="${i % 4 === 0 ? 0.85 : 0.35}"/>`).join('')}
  <rect x="20" y="430" width="130" height="2" fill="#9aa3a5"/>
</g>
<rect x="80" y="76" width="64" height="64" rx="15" fill="#050d12" stroke="#5eead4" stroke-width="3"/>
<path d="M97 96h30v8l-19.5 22H128V136H96v-8l19.5-22H97z" fill="#14b8a6"/>
<text x="162" y="122" font-family="${font}" font-weight="800" font-size="38" fill="#e4efee">ZapTill</text>
<text x="80" y="232" font-family="${font}" font-weight="600" font-size="28" fill="#2dd4bf">${esc(kicker)}</text>
${lines.map((l, i) => `<text x="80" y="${306 + i * 66}" font-family="${font}" font-weight="800" font-size="52" fill="#ffffff">${esc(l)}</text>`).join('\n')}
<text x="80" y="${306 + lines.length * 66 + 20}" font-family="${font}" font-size="24" fill="#9fb7b5">${esc(sub)}</text>
<rect x="80" y="560" width="120" height="6" rx="3" fill="#14b8a6"/>
<text x="220" y="568" font-family="${font}" font-size="22" fill="#9fb7b5">zaptill.co.ke</text>
</svg>`;
}

mkdirSync('public/og', { recursive: true });
for (const c of CARDS) {
  await sharp(Buffer.from(svg(c))).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(`public/og/${c.slug}.png`);
  console.log('og', c.slug);
}
