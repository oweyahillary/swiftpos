// A497 — Finance › Orders: a date filter, Today by default.
// Owner, 2026-10-15: "under financ -> order add a date filter or field to select dates, and by default it should only show
// todays order unless a user select show orders or a date range".
//
//   node --no-warnings tests/orders-dates.test.mjs
//
// MUTATIONS TO CONFIRM BITE: the default range back to null (every date) → "opens on Today" fails; the date params dropped
// → "the cloud is asked for those days" fails; the search no longer ignoring the dates → "a search looks across every date"
// fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/OrdersPage.tsx'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('\nFinance › Orders: dates\n');
ok('opens on Today (the first of the Reports presets — the local Kenya day)', () => {
  assert.match(src, /const \[range, setRange\]\s+= useState<\{ from: string; to: string \} \| null>\(\(\) => \{\s*const t = reportPresets\(\)\[0\];\s*return \{ from: t\.from, to: t\.to \};/);
});
ok('the cloud is asked for those days: the start of the first to the end of the last local day', () => {
  assert.match(src, /params\.set\('date_from', localDayStart\(r\.from\)\.toISOString\(\)\);/);
  assert.match(src, /params\.set\('date_to', localDayEnd\(r\.to\)\.toISOString\(\)\);/);
  assert.match(server, /if \(date_from\)\s+q = q\.gte\('created_at', date_from as string\);/);
  assert.match(server, /if \(date_to\)\s+q = q\.lte\('created_at', date_to as string\);/);
});
ok('the presets, "All dates", and a from → to range; choosing one reloads the list', () => {
  assert.match(src, /\{ label: 'All dates', r: null as/);
  assert.match(src, /data-testid="orders-from"/); assert.match(src, /data-testid="orders-to"/);
  assert.match(src, /\}, \[search, status, range\]\);/, 'load depends on the range, so the list reloads');
});
ok('a search by order number looks across every date (and says so)', () => {
  assert.match(src, /if \(r && !q\) \{/);
  assert.match(src, /Searching every date/);
});
ok('a local day runs 00:00:00.000 → 23:59:59.999 in the browser\'s own time (Kenya), never the UTC day', () => {
  const start = /function localDayStart\(day: string\): Date \{[^}]*new Date\(y, m - 1, d, 0, 0, 0, 0\)/;
  const end = /function localDayEnd\(day: string\): Date \{[^}]*new Date\(y, m - 1, d, 23, 59, 59, 999\)/;
  assert.match(src, start); assert.match(src, end);
  const d = (s, h, mi, se, ms) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd, h, mi, se, ms); };
  const a = d('2026-10-15', 0, 0, 0, 0), b = d('2026-10-15', 23, 59, 59, 999);
  assert.equal(b - a, 86_399_999);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
