/**
 * report-presets-lit.test.mjs — one period preset lit at a time (owner, 2026-10-26: on Monday 26 Oct the Reports bar lit
 * "Today" AND "This week" — both cover 26–26 Oct). activePreset (lib/reportPeriods.ts): the preset the person clicked
 * wins while its days are still the range; dates set otherwise light the first preset that matches; none matches: none.
 * Used by Reports (DateRangeBar) and Finance › Orders.
 *
 *   node tests/report-presets-lit.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: activePreset ignoring `picked` → "This week clicked on a Monday lights This week only"
 * fails; ReportsPage back to `range.from === p.from && range.to === p.to` → "Reports lights one preset" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'apps/dashboard/package.json'));
const esbuild = require('esbuild');
const out = path.join(ROOT, 'apps/dashboard/node_modules/.cache/report-periods-test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [path.join(ROOT, 'apps/dashboard/src/lib/reportPeriods.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
const { reportPresets, activePreset } = await import(pathToFileURL(out).href);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
console.log('\nOne period preset lit\n');

const monday = new Date(2026, 9, 26, 10, 0);          // Mon 26 Oct 2026, local
const first = new Date(2026, 10, 1, 10, 0);           // Sun 1 Nov 2026
ok('on a Monday Today and This week are the same days (why two used to light)', () => {
  const p = reportPresets(monday);
  const today = p.find((x) => x.label === 'Today'), week = p.find((x) => x.label === 'This week');
  assert.deepEqual([today.from, today.to], [week.from, week.to]);
});
ok('This week clicked on a Monday lights This week only', () => {
  const p = reportPresets(monday);
  const week = p.find((x) => x.label === 'This week');
  assert.equal(activePreset(p, { from: week.from, to: week.to }, 'This week'), 'This week');
});
ok('Today clicked lights Today only; nothing clicked lights the first match (Today)', () => {
  const p = reportPresets(monday);
  const t = p[0];
  assert.equal(activePreset(p, { from: t.from, to: t.to }, 'Today'), 'Today');
  assert.equal(activePreset(p, { from: t.from, to: t.to }, null), 'Today');
});
ok('on the 1st: This month clicked lights This month, not Today', () => {
  const p = reportPresets(first);
  const m = p.find((x) => x.label === 'This month');
  assert.equal(activePreset(p, { from: m.from, to: m.to }, 'This month'), 'This month');
});
ok('dates typed by hand: the clicked preset no longer matches → the first matching one, or none', () => {
  const p = reportPresets(monday);
  const y = p.find((x) => x.label === 'Yesterday');
  assert.equal(activePreset(p, { from: y.from, to: y.to }, 'This week'), 'Yesterday');
  assert.equal(activePreset(p, { from: '2026-01-01', to: '2026-01-09' }, 'This week'), null);
  assert.equal(activePreset(p, null, 'Today'), null);
});
ok('Reports lights one preset (activePreset), remembering the one clicked', () => {
  const s = read('apps/dashboard/src/pages/ReportsPage.tsx');
  assert.match(s, /const lit = activePreset\(presets, range, picked\);/);
  assert.match(s, /onClick=\{\(\) => \{ setPicked\(p\.label\); onChange\(/);
  assert.match(s, /\$\{lit === p\.label \? 'bg-swift-strong/);
  assert.doesNotMatch(s, /range\.from === p\.from && range\.to === p\.to \? 'bg-swift-strong/);
});
ok('Finance › Orders lights one preset too', () => {
  const s = read('apps/dashboard/src/pages/OrdersPage.tsx');
  assert.match(s, /activePreset\(reportPresets\(\), range, pickedPreset\) === label/);
  assert.match(s, /setPickedPreset\(r \? label : null\); setRange\(r\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
