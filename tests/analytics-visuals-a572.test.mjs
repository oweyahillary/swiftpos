/**
 * analytics-visuals-a572.test.mjs — A572: two Analytics cards the owner found hard to read (2026-10-22).
 *   1. Payment mix ("this pie chart looks off"): the legend's method name and KES amount were drawn over each other
 *      ("CaKES 95,340", "M-" above "Pesa") and the % clipped at the card's edge — the legend row was a flex row whose
 *      name could shrink to nothing while its text still painted. Now the legend wraps below the donut when the CARD is
 *      narrow (flex-wrap, a 15rem legend basis), and each row is a fixed grid: the name truncates with its full text on
 *      hover, the amount and the % never wrap.
 *   2. "Your week at a glance" ("the cards are small, reading them is a bit hard"): body-size text (text-sm, not
 *      text-xs), the whole item name on up to two lines (line-clamp-2, not truncate), 7 across only from 1800px,
 *      stacked on a phone, today's card ringed.
 * Source pins on apps/dashboard/src/pages/analytics/charts.tsx (Donut) and AnalyticsPage.tsx (the week block); the
 * rendered cards were checked at 1600, 1024 and 375 px (docs/screenshots/analytics-a572-*.webp).
 *
 *   node tests/analytics-visuals-a572.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A572 report):
 *   - the Donut legend row back to `flex items-center gap-2` with an untruncated name   → "legend rows" fails
 *   - the Donut wrapper back to `flex flex-col sm:flex-row`                               → "legend wraps" fails
 *   - the week item name back to `truncate` at text-xs                                    → "week items" fails
 *   - the week grid back to `xl:grid-cols-7`                                              → "week grid" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'apps/dashboard/src/pages/analytics');
const charts = fs.readFileSync(path.join(DIR, 'charts.tsx'), 'utf8');
const page = fs.readFileSync(path.join(DIR, 'AnalyticsPage.tsx'), 'utf8');

const between = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `"${start}" not found`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `"${end}" not found after "${start}"`);
  return src.slice(a, b);
};
const donut = between(charts, 'export function Donut(', '\n}\n');
const week = between(page, 'data-testid="analytics-week"', '</ol>');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
console.log('\nA572 — Analytics: the payment-mix legend and the week at a glance, readable at every width\n');

ok('legend wraps below the donut when the card is narrow (the card decides, not the screen)', () => {
  assert.match(donut, /className="flex flex-wrap items-center justify-center gap-4"/, 'the donut and its legend sit in a wrapping row');
  assert.doesNotMatch(donut, /sm:flex-row/, 'no screen breakpoint puts the legend beside the donut in a narrow card');
  assert.match(donut, /<ul className="[^"]*\bgrow basis-60 min-w-0\b[^"]*"/, 'the legend keeps a 15rem basis, so it wraps instead of squeezing');
});

ok('legend rows: a fixed grid — the name truncates (title on hover), amount and % never wrap or overlap', () => {
  assert.match(donut, /<li key=\{x\.key\} className="grid grid-cols-\[0\.625rem_minmax\(0,1fr\)_auto_2\.75rem\] items-center gap-x-2">/,
    'each row is swatch | name (shrinks) | amount (its own width) | % (fixed)');
  assert.match(donut, /<span className="text-gray-300 truncate" title=\{x\.label\}>\{x\.label\}<\/span>/, 'the name truncates with its full text on hover');
  assert.match(donut, /tabular-nums text-right whitespace-nowrap">\{fmt\.money\(x\.value/, 'the amount is right-aligned and never wraps');
  assert.match(donut, /tabular-nums text-right whitespace-nowrap">\{\(x\.share \* 100\)/, 'the % never wraps');
  assert.doesNotMatch(donut, /flex-1 min-w-0">\{x\.label\}/, 'the old row (a name that could shrink to nothing and paint over the amount) is gone');
});

ok('week items: body-size text, the whole name on up to two lines, the count in its own column', () => {
  assert.match(week, /<li key=\{x\.productId \?\? x\.name\} className="flex items-start justify-between gap-3 text-sm leading-snug">/, 'each item row is text-sm');
  assert.match(week, /<span className="text-gray-200 min-w-0 line-clamp-2 break-words" title=\{x\.name\}>\{x\.name\}<\/span>/, 'the name wraps to two lines, not one');
  assert.doesNotMatch(week, /\btruncate\b/, 'nothing in the week cards truncates to one line');
  assert.doesNotMatch(week, /className="[^"]*\btext-xs\b[^"]*"[^>]*>\{(?:d\.day|x\.name|fmt\.qty)/, 'the day, the item and the count are not text-xs');
  assert.match(week, /<p className="text-sm font-bold text-white">\{d\.day\}/, 'the day name is text-sm');
  assert.match(week, /text-white font-semibold tabular-nums flex-shrink-0">\{fmt\.qty\(x\.qty\)\}/, 'the count is its own non-shrinking column');
});

ok('week grid: stacked on a phone, 2/3/4 as it widens, 7 across only from 1800px; today ringed', () => {
  assert.match(week, /<ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-\[1800px\]:grid-cols-7 gap-3">/);
  assert.doesNotMatch(week, /(?<!min-\[1800px\]):grid-cols-7|xl:grid-cols-7/, '7 across only on a very wide screen');
  assert.match(page, /const todayName = new Date\(\)\.toLocaleDateString\('en-GB', \{ weekday: 'long' \}\);/, "today's weekday name");
  assert.match(week, /today \? 'ring-1 ring-swift' : ''/, "today's card is ringed in the back office's teal");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
