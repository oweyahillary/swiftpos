// A457 — the till's Overview, redesigned (owner, 2026-10-12: "can you make the desktop overview beautiful i know we can
// do better"). The figures are untouched (branch-day, money-reports and till-extras-0618 pin those); this pins the new
// parts so a later edit cannot quietly drop them.
//
//   node test/overview-look.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mp = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'ManagerPage.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}`); fail++; } };

ok('every Overview (restaurant, retail, petrol) draws its payment methods as one ring-and-bars mix',
  (mp.match(/<PaymentMix methods=\{sales\??\.paymentMethods\}/g) ?? []).length === 3 && /data-testid="overview-payment-mix"/.test(mp));
ok('…the ring and the bars are shares of what was PAID (all methods), coloured per method',
  /const total = rows\.reduce\(\(a, \[, v\]\) => a \+ v, 0\);/.test(mp) && (mp.match(/methodColour\((m|method)\)\.dot/g) ?? []).length >= 2);
ok('top sellers ranked with a bar against the best seller (restaurant and retail)',
  (mp.match(/<TopSellers items=\{topItems\}/g) ?? []).length === 2 && /data-testid="overview-top-sellers"/.test(mp));
// A465 (owner, 2026-10-13): "remove the icons on the cards on the desktop overview but leave the colors".
ok('the headline cards carry a colour and no icon; revenue is the gradient one',
  (mp.match(/<KpiCard label=\{`Revenue \$\{when\}`\}[^\n]*\saccent\b/g) ?? []).length === 3 && (mp.match(/label="VAT collected"[^\n]*tone="amber"/g) ?? []).length === 2
  && /bg-gradient-to-br from-action-500 to-action-700/.test(mp)
  && !/KPI_ICON/.test(mp) && !/<KpiCard[^>]*\sicon=/.test(mp));
ok('the hourly chart: taller, gridlines, the peak picked out, an hour readout on hover',
  /<div className="relative h-36">/.test(mp) && /onMouseEnter=\{\(\) => setHover\(h\)\}/.test(mp) && /Point at a bar for its hour/.test(mp));
ok('the old inline payment blocks are gone (one implementation)', !/<div className="h-1 bg-gray-700 rounded-full overflow-hidden">/.test(mp));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
