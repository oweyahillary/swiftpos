/**
 * reports-refunds-and-exports.test.mjs — A193 (standalone Refunds view) + A143
 * (inventory report tab + export download hub).
 *
 * A193: a refund keeps status 'completed', so it never shows in the Void Log —
 * it needs its own audit surface. New GET /api/reports/refunds mirrors /voids but
 * filters by refunded_at and reports the refunded amount + authorizer/reason.
 * A143: the inventory report and every export format were live endpoints with no
 * UI caller; this wires an Inventory tab and an Exports download hub.
 *
 * Source-level; mutation-checkable — drop the refunded_at filter, the tab, or an
 * export wiring and a named assertion fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/reports.ts'), 'utf8');
const page   = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/ReportsPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// ── A193 server ──
ok('server: GET /reports/refunds exists', () => {
  assert.match(server, /router\.get\('\/refunds'/, 'the refunds report route must exist');
});

ok('server: refunds are selected by refund state, not order status', () => {
  assert.match(server, /\.not\('refunded_at', 'is', null\)/,
    "must select orders that were refunded (refunded_at not null) — status stays 'completed'");
  assert.match(server, /\.gte\('refunded_at', start\)[\s\S]*?\.lte\('refunded_at', end\)/,
    'refunds must be dated by the refund event (refunded_at), not created_at');
});

ok('server: the log carries reason + authorizer + refunded amount', () => {
  assert.match(server, /refund_reason, refunded_by, refund_authorized_by/,
    'the select must include the audit fields (reason + who)');
  assert.match(server, /totalValue:\s*enriched\.reduce\(\(s, o\) => s \+ Number\(o\.refunded_amount\)/,
    'the value total must sum the refunded amount, not the order total');
});

// ── A193 client ──
ok('client: a Refunds tab calls the refunds report', () => {
  assert.match(page, /api\.get<RefundsReport>\(`\/api\/reports\/refunds/,
    'RefundsTab must fetch /api/reports/refunds');
  assert.match(page, /\{ id: 'refunds',\s*label: 'Refunds' \}/, 'Refunds must be in TAB_LIST');
  assert.match(page, /activeTab === 'refunds'\s*&&\s*<RefundsTab/, 'the switch must render RefundsTab');
});

// ── A143 inventory ──
ok('client: an Inventory tab renders the existing inventory endpoint', () => {
  assert.match(page, /api\.get<InventoryReport>\(`\/api\/reports\/inventory/,
    'InventoryTab must fetch /api/reports/inventory');
  assert.match(page, /\{ id: 'inventory',\s*label: 'Inventory' \}/, 'Inventory must be in TAB_LIST');
  assert.match(page, /activeTab === 'inventory'\s*&&\s*<InventoryTab/, 'the switch must render InventoryTab');
});

// ── A143 exports hub ──
ok('client: the Exports hub covers all five requested formats', () => {
  for (const key of ['daily', 'audit', 'shifts', 'pnl', 'expenses']) {
    assert.match(page, new RegExp(`key: '${key}'`), `the exports hub must offer '${key}'`);
  }
  assert.match(page, /window\.open\(`\$\{API_URL\}\/api\/reports\/export\/\$\{key\}/,
    'each export must open /api/reports/export/<key> as a download');
  assert.match(page, /\{ id: 'exports',\s*label: 'Exports' \}/, 'Exports must be in TAB_LIST');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
