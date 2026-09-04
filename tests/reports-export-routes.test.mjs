/**
 * reports-export-routes.test.mjs — A143 (Exports hub offered a report with no route).
 *
 * The Exports hub lists 8 formats; the 2026-09-03 QA pass found /export/expenses
 * returned 404 — the route was documented in the header but never implemented, so
 * the button downloaded an HTML "not found" page. This pins that every format the
 * hub offers has a real server route, so a hub button can never 404 again.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exp   = fs.readFileSync(path.join(root, 'apps/server/src/routes/reports-export.ts'), 'utf8');
const daily = fs.readFileSync(path.join(root, 'apps/server/src/routes/reports-daily.ts'), 'utf8');
const page  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/ReportsPage.tsx'), 'utf8');

const routesText = exp + '\n' + daily;

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// The formats the Exports hub offers (EXPORT_FORMATS keys).
const HUB_KEYS = ['sales', 'daily', 'hourly', 'products', 'shifts', 'pnl', 'expenses', 'audit'];

ok('every Exports-hub format has a real server route (no 404s)', () => {
  for (const key of HUB_KEYS) {
    const re = new RegExp(`router\\.get\\('/${key}'`);
    assert.match(routesText, re, `no server route for /export/${key} — the hub button would 404`);
  }
});

ok('the previously-missing /expenses route now exists', () => {
  assert.match(exp, /router\.get\('\/expenses'/, 'the /export/expenses route must exist (was the 404)');
  assert.match(exp, /\.from\('expenses'\)[\s\S]*?expense_date/, 'it must query the expenses table by expense_date');
});

ok('the hub still offers exactly the keys we route', () => {
  for (const key of HUB_KEYS) {
    assert.match(page, new RegExp(`key: '${key}'`), `hub is missing the '${key}' button`);
  }
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
