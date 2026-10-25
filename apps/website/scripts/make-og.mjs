// Makes one Open Graph card (1200x630 PNG) per page into public/og/, from one template: the wordmark, the page's own
// headline and a line under it, on the night teal, with a strip of thermal paper on the right (the site's signature).
// Run from apps/website: node scripts/make-og.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(process.cwd() + '/package.json');
const sharp = require('sharp');

const CARDS = [
  // 2026-10-23: Home has its own card, for every trade (public/og-zaptill.png, from make-images.mjs, stays the fallback).
  { slug: 'home', kicker: 'For shops, restaurants, stations and car parks', lines: ['Know where every shilling', 'went, every single day.'], sub: 'Points of sale, M-Pesa and the day close, through internet cuts, in Kenya.' },
  { slug: 'how-it-works', kicker: 'How it works', lines: ['A day with ZapTill,', 'from PIN to phone.'], sub: 'A restaurant and the minimart next door, from the float to the email at night.' },
  { slug: 'features', kicker: 'Features', lines: ['Everything it does,', 'for every kind of business.'], sub: 'Barcodes, stock, the kitchen, the pumps, parking bays, the day close.' },
  { slug: 'who-its-for', kicker: "Who it's for", lines: ['Made for the way', 'your place works.'], sub: 'Shops, minimarts, restaurants, bars, petrol stations and car parks.' },
  { slug: 'restaurants', kicker: 'For restaurants and cafés', lines: ['From the order to the plate,', 'nothing gets lost.'], sub: 'Kitchen tickets with extras and notes, tables, M-Pesa, the day close.' },
  { slug: 'bars', kicker: 'For bars and lounges', lines: ["Know whose drawer is short", 'before the lights go off.'], sub: 'Over and short by name, voids with a manager PIN, credit for regulars.' },
  { slug: 'quick-service', kicker: 'For quick service', lines: ['Faster at the counter.', 'Right in the bag.'], sub: 'Combos on one line, dispatch tickets that count the bags, offers.' },
  { slug: 'retail', kicker: 'For shops and supermarkets', lines: ['Stock that adds up.', 'A point of sale that never stops.'], sub: 'Departments, barcodes and labels, weighed items, stock and suppliers.' },
  { slug: 'minimarts', kicker: 'For minimarts', lines: ['A quick queue, a weighed kilo,', 'a drawer that adds up.'], sub: 'Scan or tap, weigh at the point of sale, sell on account, close by cashier.' },
  { slug: 'petrol-stations', kicker: 'For petrol stations', lines: ['Every litre, every pump,', 'every shilling.'], sub: 'Pumps on the point of sale, fuel by amount or litres, tanks, the forecourt shop.' },
  { slug: 'parking', kicker: 'For car parks', lines: ['Every bay, every plate,', 'every hour charged.'], sub: 'Bays and number plates on the web POS, cash or M-Pesa, occupancy.' },
  { slug: 'analytics', kicker: 'ZapTill Analytics', lines: ['Know what to do next,', 'in plain words.'], sub: 'What to order, what sells together, which branch needs stock.' },
  { slug: 'pricing', kicker: 'Pricing', lines: ['Pay once for your point of sale.', 'About KES 100 a day for the cloud.'], sub: 'Setup once per branch. One cloud fee for the business, first month free.' },
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
