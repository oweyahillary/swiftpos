/**
 * analytics-costs-layout-a583.test.mjs — A583: Analytics > Costs "scroll down to an empty space" (owner, 2026-10-23,
 * TJS PIZZA CHIKEN AND FRIES, a restaurant with 29 items and no costs, dark mode, ~1900px window).
 *
 * Root cause: the dashboard is a 100dvh flex layout that never scrolls itself (`h-[100dvh] overflow-hidden`); a page
 * scrolls inside <main> (`overflow-y-auto`). <main> was not positioned, so an absolutely placed element inside a page
 * had the window as its containing block and was NOT clipped by either overflow box. The Costs area's "Items without a
 * cost" table has an `sr-only` header ("Set its cost", position:absolute) ~2,800px down the page: the window grew to
 * that height, and once <main> reached its end the wheel carried on scrolling the WINDOW — the whole layout slid up out
 * of view and the owner saw a blank dark screen. Only Costs showed it on a desktop because only that table has an
 * sr-only label (the Pager's "Per page" is sr-only on a phone, so lists could do the same there).
 * Measured in headless Chromium with the real DashboardLayout + AnalyticsPage (1920x1000, the banner link): the window
 * scrolled 1,889px into nothing before; 0 after, at 1920, 1440 and 390 px, via the tile, the banner and ?tab=costs.
 *
 * Fix: <main> is `relative` (the scroll container is the containing block of everything a page places absolutely), and
 * the Costs table's sr-only header cell is `relative` too (the area is safe in any host layout).
 * Also pinned: the lead's per-area error panel with Retry (an area that fails to load says so in its own panel).
 * Screenshots: docs/screenshots/analytics-costs-a583-*.webp.
 *
 *   node tests/analytics-costs-layout-a583.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A583 report):
 *   - `relative` removed from <main> in DashboardLayout.tsx                 → "main is the containing block" fails
 *   - `relative` removed from the NoCostList sr-only header cell           → "the sr-only header" fails
 *   - the area-error branch replaced by the plain Loading line             → "area error panel" fails
 *   - `retry` dropped from the area effect's dependencies                  → "Retry reloads" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/dashboard/src');
const layout = fs.readFileSync(path.join(SRC, 'components/DashboardLayout.tsx'), 'utf8');
const areas = fs.readFileSync(path.join(SRC, 'pages/analytics/areas.tsx'), 'utf8');
const page = fs.readFileSync(path.join(SRC, 'pages/analytics/AnalyticsPage.tsx'), 'utf8');

const between = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `"${start}" not found`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `"${end}" not found after "${start}"`);
  return src.slice(a, b);
};
const classesOf = (tag) => (tag.match(/className="([^"]*)"/) ?? [])[1]?.split(/\s+/) ?? [];

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
console.log('\nA583 — Analytics > Costs: no empty band below the page (the window never scrolls)\n');

ok('the layout: a 100dvh flex box that clips, and <main> is the one scroll container', () => {
  const root = layout.match(/<div className="[^"]*h-\[100dvh\][^"]*">/);
  assert.ok(root, 'the root is the 100dvh box');
  for (const c of ['flex', 'h-[100dvh]', 'overflow-hidden']) assert.ok(classesOf(root[0]).includes(c), `the root keeps ${c}`);
  const mains = layout.match(/<main\b[^>]*>/g) ?? [];
  assert.strictEqual(mains.length, 1, 'one <main>');
  for (const c of ['flex-1', 'min-w-0', 'overflow-y-auto']) assert.ok(classesOf(mains[0]).includes(c), `<main> keeps ${c}`);
});

ok('main is the containing block: `relative`, so an absolutely placed element (sr-only) cannot grow the window', () => {
  const main = (layout.match(/<main\b[^>]*>/) ?? [''])[0];
  const cls = classesOf(main);
  assert.ok(cls.includes('relative') || cls.includes('absolute') || cls.includes('fixed'), `<main> is positioned (got "${cls.join(' ')}")`);
  assert.ok(!cls.includes('static'), '<main> is not static');
});

ok('the sr-only header of the "Items without a cost" table sits in a positioned cell', () => {
  const list = between(areas, 'function NoCostList(', '\n}\n');
  const th = list.match(/<th className=\{`([^`]*)`\}><span className="sr-only">Set its cost<\/span><\/th>/);
  assert.ok(th, 'the "Set its cost" header cell');
  assert.match(th[1], /\brelative\b/, 'the header cell is relative');
  // every other sr-only in the analytics areas is inside a positioned element on the same line
  for (const line of areas.split('\n').filter((l) => l.includes('sr-only'))) assert.match(line, /\brelative\b/, `sr-only without a positioned parent: ${line.trim()}`);
});

ok('area error panel: a failed area says so in its own panel with Retry (not only at the top of the page)', () => {
  assert.match(page, /const \[areaError, setAreaError\] = useState<Record<string, string>>\(\{\}\);/);
  assert.match(page, /const \[retry, setRetry\] = useState\(0\);/);
  assert.match(page, /if \(err\?\.code === 'ANALYTICS_OFF'\) \{ fail\(e\); return; \}\s*\n\s*setAreaError\(\(a\) => \(\{ \.\.\.a, \[tabKey\]: err\?\.message \|\| 'This area could not be loaded\.' \}\)\);/,
    'a failure other than ANALYTICS_OFF goes to the area, not the page');
  const panel = between(page, '{!current ? (', ': forbidden ?');
  assert.match(panel, /areaError\[tabKey\] && !busy/, 'shown once the load has finished');
  assert.match(panel, /data-testid="analytics-area-error"/);
  assert.match(panel, /<button type="button" onClick=\{\(\) => setRetry\(\(n\) => n \+ 1\)\}[^>]*>Retry<\/button>/, 'a Retry button');
  assert.match(panel, />Loading…<\/p>/, 'otherwise the Loading line');
});

ok('Retry reloads: the area effect clears the error and re-runs on retry', () => {
  const eff = between(page, 'const tabKey = `${tab}|${qs}`;', '// A561: once the cloud says');
  assert.match(eff, /setAreaError\(\(a\) => \{ if \(!\(tabKey in a\)\) return a;/, 'the old error is cleared on a new try');
  assert.match(eff, /\}, \[tabKey, locked, retry\]\);/, 'retry is a dependency');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
