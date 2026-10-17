// A518 — web tidy-ups from A506's "left as is" list:
//   (a) Table turnover (the owner's page and the manager portal's tab) and Printers said nothing when the cloud refused a
//       load — they show the cloud's words now (lib/posError's message), like the other pages;
//   (b) a holder of reports.overview alone saw no sales on the manager Overview — the client asked only with
//       reports.sales, though the cloud's /reports/sales and /reports/products admit reports.overview;
//   (c) the web POS asked the OWNER for a PIN to void or refund, which the cloud never reads for them (A187/A494 — the owner
//       self-approves); everyone else is still asked.
//
//   node --no-warnings tests/web-tidy-a518.test.mjs
//
// Reads the pages (they are React; the cloud's gates are read from the routes) and runs the shared catalogue.
//
// MUTATIONS TO CONFIRM BITE: a turnover catch back to `catch { /* ignore */ }` → (a) fails; the Overview's /sales back to
// reports.sales only → (b) fails; the PIN box shown to the owner, or override_pin required of them → (c) fails; the PIN
// skipped for everyone → "everyone else still enters a PIN" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const MGR = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); const j = src.indexOf('\nfunction ', i + 10); return src.slice(i, j < 0 ? undefined : j); };

console.log('\nA518 — web tidy-ups (A506 left as is)\n');

await ok('(a) the owner\'s Table turnover shows a refused load — no silent catch left', () => {
  const t = read('apps/dashboard/src/pages/pos/TableTurnoverPage.tsx');
  assert.ok(!/catch \{ \/\* ignore \*\/ \}/.test(t), 'a silent catch is left');
  assert.match(t, /setError\(\(e as Error\)\?\.message \|\| 'Could not load the tables\.'\)/);
  assert.match(t, /setError\(\(e as Error\)\?\.message \|\| 'Could not load the turnover report\.'\)/);
  assert.match(t, /\{error && <p [^>]*data-testid="turnover-error">\{error\}<\/p>\}/);
});
await ok('(a) the manager portal\'s Turnover tab shows a refused load', () => {
  const t = fnBody(MGR, 'ManagerTurnoverTab');
  assert.ok(!/catch \{ \/\* ignore \*\/ \}/.test(t), 'a silent catch is left');
  assert.equal((t.match(/setError\(\(e as Error\)\?\.message \|\|/g) ?? []).length, 2);
  assert.match(t, /data-testid="turnover-error"/);
});
await ok('(a) Printers shows a refused load (it had no catch: the rejection went nowhere)', () => {
  const p = read('apps/dashboard/src/pages/settings/PrintersPage.tsx');
  const load = p.slice(p.indexOf('const load = useCallback'), p.indexOf('useEffect(() => { load(); }, [load]);'));
  assert.match(load, /catch \(e\) \{\s*setLoadError\(\(e as Error\)\?\.message \|\| 'Could not load the printers\.'\);/);
  assert.match(load, /setLoadError\(''\)/);
  assert.match(p, /data-testid="printers-load-error">\{loadError\}/);
});
await ok('(b) the cloud admits reports.overview on /reports/sales and /reports/products — not on /hourly or /products-v2', () => {
  const r = read('apps/server/src/routes/reports.ts');
  assert.match(r, /router\.get\('\/sales', requireAnyPermission\('reports\.sales', 'reports\.overview'\)/);
  assert.match(r, /router\.get\('\/products', requireAnyPermission\('reports\.items', 'reports\.overview'\)/);
  assert.match(r, /router\.get\('\/hourly', requirePermission\('reports\.sales'\)/);
  assert.match(r, /router\.get\('\/products-v2', requirePermission\('reports\.items'\)/);
});
await ok('(b) the manager Overview loads the day\'s figures and the top items for reports.overview alone; the hourly chart stays reports.sales', () => {
  const o = fnBody(MGR, 'OverviewTab');
  assert.match(o, /const seesDay = hasPermission\('reports\.sales'\) \|\| hasPermission\('reports\.overview'\);/);
  assert.match(o, /seesDay \? posApi\.get<SalesSummary>\(`\/api\/reports\/sales\?\$\{params\}`\)/);
  assert.match(o, /hasPermission\('reports\.sales'\) \? posApi\.get<\{ series: HourlyRow\[\] \}>\(`\/api\/reports\/hourly/);
  assert.match(o, /: hasPermission\('reports\.overview'\) \? posApi\.get<\{ products: TopProduct\[\] \}>\(`\/api\/reports\/products\?\$\{params\}`\)/);
  assert.match(o, /\{seesDay && \(/, 'the KPI cards');
  assert.ok(!/\{hasPermission\('reports\.sales'\) && \(/.test(o), 'the KPI cards are no longer reports.sales only');
  // The parking Overview's revenue and the petrol Overview's pump monitor read the same admitted routes.
  assert.match(fnBody(MGR, 'ParkingOverviewTab'), /const seesSales = hasPermission\('reports\.sales'\) \|\| hasPermission\('reports\.overview'\);/);
  assert.match(fnBody(MGR, 'PetrolOverviewTab'), /if \(seesFuel \|\| hasPermission\('reports\.overview'\)\) \{ try \{ const pm = await posApi\.get<any>\(`\/api\/reports\/pump-monitor/);
  // The Overview tab opens for reports.overview (the Accountant holds it).
  assert.ok(P.BUILT_IN_ROLES.find((r) => r.name === 'Accountant').keys.includes('reports.overview'));
});
await ok('(c) the owner\'s web POS session is not asked for a PIN to void or refund (the cloud self-approves the owner)', () => {
  const h = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(h, /const ownerSelf = held\.has\('\*'\);/);
  assert.match(h, /if \(!ownerSelf && !refundPin\.trim\(\)\)/);
  assert.match(h, /\.\.\.\(ownerSelf \? \{\} : \{ override_pin: refundPin\.trim\(\) \}\)/);
  assert.match(h, /\{!ownerSelf && \(\s*<input type="password"[^>]*placeholder="Manager or owner PIN"/);
  assert.equal(P.expandMap({ '*': true }).has('*'), true, "the owner's map holds '*'");
  assert.equal(P.expandMap({ 'sales.void': true, 'sales.refund': true, [P.MAP_MARKER]: true }).has('*'), false, 'a manager does not');
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /\} else if \(req\.isOwner\) \{\s*\n\s*\/\/ A187: an owner refunding from the dashboard self-authorises/);
  assert.match(o, /\} else if \(isPaid && req\.isOwner\) \{\s*\n\s*\/\/ A187: an owner voiding from the dashboard self-authorises/);
});
await ok('(c) everyone else still enters a manager\'s PIN, sent as override_pin', () => {
  const h = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(h, /text: `A manager PIN is required to \$\{revMode\}\.`/);
  assert.match(h, /override_pin: refundPin\.trim\(\)/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
