// A457 — the till's Overview, redesigned (owner, 2026-10-12: "can you make the desktop overview beautiful i know we can
// do better"). A468 (owner, 2026-10-13: "match the desktop look and feel of the overview of the desktop app to that of
// the website") — the Overview now reads like the web's (apps/dashboard/src/pages/OverviewPage.tsx): its KPI row with
// "vs yesterday", its live row, its section cards, lists and bars, in its order. The figures are untouched (branch-day,
// money-reports and till-extras-0618 pin those); this pins the look so a later edit cannot quietly drop it.
//
//   node test/overview-look.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mp = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'ManagerPage.tsx'), 'utf8');
const web = fs.readFileSync(path.join(here, '..', '..', 'dashboard', 'src', 'pages', 'OverviewPage.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}`); fail++; } };
const between = (a, b) => { const i = mp.indexOf(a); const j = mp.indexOf(b, i + 1); return i >= 0 && j > i ? mp.slice(i, j) : ''; };
const overviews = between('function ScopeLine(', '// ── Orders Tab');
const resto = between('function RestaurantOverview(', 'function PetrolOverview(');
const petrol = between('function PetrolOverview(', 'function RetailOverview(');
const retail = between('function RetailOverview(', 'function PaymentMix(');
const inOrder = (src, marks) => marks.every((m, i) => src.indexOf(m) >= 0 && (i === 0 || src.indexOf(m) > src.indexOf(marks[i - 1])));

// ── unchanged meaning (A457) ──────────────────────────────────────────────────────────────────────────────────────────
ok('every Overview (restaurant, retail, petrol) draws its payment methods as one ring-and-bars mix',
  (mp.match(/<PaymentMix methods=\{sales\??\.paymentMethods\}/g) ?? []).length === 3 && /data-testid="overview-payment-mix"/.test(mp));
ok('…the ring and the bars are shares of what was PAID (all methods), coloured per method',
  /const total = rows\.reduce\(\(a, \[, v\]\) => a \+ v, 0\);/.test(mp) && (mp.match(/methodColour\((m|method)\)\.dot/g) ?? []).length >= 2);
ok('top sellers ranked, as the web lists them, with a bar against the best seller (restaurant and retail)',
  (mp.match(/<TopSellers items=\{topItems\}/g) ?? []).length === 2
  && /<div className="flex flex-col divide-y divide-gray-800" data-testid="overview-top-sellers">/.test(mp)
  && /width: `\$\{Math\.round\(\(\(Number\(p\.revenue\) \|\| 0\) \/ top\) \* 100\)\}%`/.test(mp));
ok('the hourly chart: the peak picked out, an hour readout on hover',
  /<div className="flex items-end gap-1 h-36">/.test(mp) && /onMouseEnter=\{\(\) => setHover\(h\)\}/.test(mp)
  && /Point at a bar for its hour/.test(mp) && /\{hover === null \? 'Peak ' : ''\}\{hh\(shown\.hour\)\}/.test(mp));
ok('the old inline payment blocks are gone (one implementation)',
  !/<div className="h-1 bg-gray-700 rounded-full overflow-hidden">/.test(mp) && !/Object\.(entries|keys)\(sales/.test(overviews));
// A465 (owner, 2026-10-13): "remove the icons on the cards on the desktop overview but leave the colors".
ok('no icons on the cards; revenue is the accent one on every Overview',
  (mp.match(/<KpiCard label=\{`Revenue \$\{when\}`\}[^\n]*\saccent\b/g) ?? []).length === 3
  && !/KPI_ICON/.test(mp) && !/<KpiCard[^>]*\sicon=/.test(mp) && !/<Icon /.test(overviews));

// ── A468: the web's look ──────────────────────────────────────────────────────────────────────────────────────────────
ok('KPI cards are the web\'s: accent solid in the till\'s theme (the web\'s swift-strong), the rest its one plain card',
  web.includes("'bg-swift-strong border-swift-strong'") && web.includes("'bg-gray-900 border-gray-800'")
  && mp.includes("? 'bg-action-600 border-action-600'\n      : 'bg-gray-900 border-gray-800'")
  && mp.includes('text-xs uppercase tracking-wider font-medium') && mp.includes('<span className="relative text-xl font-semibold tabular-nums text-white">{value}</span>')
  && !/from-action-500 to-action-700/.test(mp));
// A468: "leave the colors" — the plain cards keep a soft tint each (Orders sky, Avg violet, VAT amber; petrol likewise).
ok('…the plain cards keep their colour as a soft tint; the accent card has none',
  mp.includes("{!accent && tone && <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b ${KPI_TINT[tone]} to-transparent`} />}")
  && (mp.match(/tone="sky"/g) ?? []).length === 3 && (mp.match(/tone="violet"/g) ?? []).length === 3 && (mp.match(/tone="amber"/g) ?? []).length === 3);
ok('…VAT stays on its card (A357), plain like the web\'s other cards',
  (mp.match(/<KpiCard label="VAT collected" +value=\{fmt\(s\?\.totalVat \?\? 0, currency\)\} tone="amber" \/>/g) ?? []).length === 2);

// The web's deltaLabel, run as the till has it.
const body = (mp.match(/function deltaOf\(curr: number, prev: number \| null \| undefined\): Delta \{\n([\s\S]*?)\n\}/) ?? [])[1] ?? 'return "missing"';
const deltaOf = new Function('curr', 'prev', body);
ok('"vs yesterday": the web\'s rule — the % change on the day before, none with nothing to compare',
  JSON.stringify(deltaOf(150, 100)) === '{"pct":50,"up":true}' && JSON.stringify(deltaOf(80, 100)) === '{"pct":-20,"up":false}'
  && deltaOf(100, 0) === null && deltaOf(100, null) === null && JSON.stringify(deltaOf(100, 100)) === '{"pct":0,"up":true}');
ok('…on revenue (every Overview) and orders (restaurant, retail), the arrow and colour as on the web',
  (mp.match(/delta=\{p && deltaOf\(s\?\.totalRevenue \?\? 0, p\.totalRevenue\)\}/g) ?? []).length === 2
  && (mp.match(/delta=\{p && deltaOf\(s\?\.totalOrders \?\? 0, p\.totalOrders\)\}/g) ?? []).length === 2
  && /delta=\{p && deltaOf\(sales\?\.summary\?\.totalRevenue \?\? 0, p\.totalRevenue\)\}/.test(petrol)
  && mp.includes("{delta.up ? '▲' : '▼'} {Math.abs(delta.pct)}% vs {vs}") && /delta\.up \? GOOD_TEXT : 'text-red-400'/.test(mp));
ok('…the day before read the same way (manager:branchDay), compared only when both days come from the same place',
  /posApi\.manager\.branchDay\(overviewRange\(stepDay\(date, -1\)\)\)/.test(mp)
  && (mp.match(/const prev = useDayBefore\(date\);/g) ?? []).length === 3
  && mp.includes('return day && prev && day.source === prev.source ? prev.summary : null;')
  && petrol.includes("const p = when === 'today' ? null : comparable(sales, prev);"));
ok('section cards are the web\'s: title, the day in gray beside it, a link on the right',
  web.includes('bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3')
  && mp.includes('className={`bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3 ${className}`}')
  && mp.includes('className="text-xs text-gray-500 hover:text-white transition-colors whitespace-nowrap">{link.label}</button>')
  && !/<Card[\s>]/.test(overviews));
ok('the web\'s order: (pumps first on petrol) KPIs → live row (hourly + open shifts) → payments beside top sellers → stock → tills, shifts, staff',
  inOrder(resto, ['<ScopeLine', '<KpiCard label={`Revenue', '<LiveRow', 'title="Payment methods"', 'title="Top sellers"', '<LowStock', '<BranchShiftsAndTills'])
  && inOrder(retail, ['<ScopeLine', '<KpiCard label={`Revenue', '<LiveRow', 'title="Payment methods"', 'title="Top sellers"', '<LowStock', '<BranchShiftsAndTills'])
  && inOrder(petrol, ['<ScopeLine', 'data-testid="overview-pump-monitor"', '<KpiCard label={`Revenue', '<LiveRow', 'title="Payment methods"', 'title="By fuel grade"', '<LowStock', '<BranchShiftsAndTills']));
ok('the live row: the hourly chart over two columns beside the open shifts (every till\'s, from the day\'s shift report)',
  mp.includes('<div className="grid grid-cols-1 lg:grid-cols-3 gap-3">') && mp.includes('className="lg:col-span-2" testid="overview-hourly"')
  && mp.includes("const open = (day?.shifts ?? []).filter((sh) => sh.state === 'open');") && (mp.match(/<LiveRow day=\{sales\}/g) ?? []).length === 3);
ok('links open the page they name only where this role has it; Low stock only where the Stock page shows (A346)',
  mp.includes('const overviewLink: LinkTo = (tab) => (groupOf(nav, tab) ? () => openTab(tab) : undefined);')
  && (mp.match(/linkTo=\{overviewLink\} showLowStock=\{showStock\}/g) ?? []).length === 3
  && (mp.match(/link=\{linkOf\(linkTo, 'items', 'item mix →'\)\}/g) ?? []).length === 2
  && (mp.match(/\{showLowStock && (<LowStock|\()/g) ?? []).length === 3);
ok('the header: the day on the left, Updated and ↻ Refresh on the right (the same reads again)',
  mp.includes('data-testid="overview-refresh"') && mp.includes('<Fragment key={reload}>{render(date)}</Fragment>') && /↻ Refresh/.test(web));
ok('the KPI row fits a till: two across up to 1280 px, four across from there',
  (overviews.match(/<div className="grid grid-cols-2 xl:grid-cols-4 gap-3">/g) ?? []).length === 3);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
