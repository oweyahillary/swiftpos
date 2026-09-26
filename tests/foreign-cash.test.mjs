/**
 * foreign-cash.test.mjs — A334 (2026-09-26): a drawer shared by the till and the web POS reconciles.
 *
 * The till computes its close from what it holds (it is the cash authority); the web's sales on the same
 * drawer live only in the cloud. Owner: the till's close INCLUDES them. The till sends the ids it holds;
 * POST /api/shifts/:id/foreign-cash sums the rest with the cloud close's own arithmetic.
 *
 *   node tests/foreign-cash.test.mjs
 *
 * RUNS the real rule (apps/server/src/lib/foreignCash.ts). The till side runs for real in
 * apps/desktop/test/shared-drawer.test.mjs (compiled shiftService on SQLite). Route + IPC wiring are pinned by
 * source here (Express / Electron not run) — the live two-surface close is a target check (rule 16).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - count known orders too                         → "only what the till does not hold" fails
 *   - drop 'refunded' from the cash statuses         → "a web refund comes back out" fails
 *   - the route loses its terminal/opener/manager check → "authorised like /:id/close" fails
 *   - the POS sell gate asks for the web's part        → "the sell gate never waits on the cloud" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.FOREIGN_CASH_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, FOREIGN_CASH_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
  const { foreignCash, foreignExpected } = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/foreignCash.ts')).href);

  // A shared drawer in the cloud: the till's sale o-till (already on the till) and two web sales, one refunded in part.
  const cloud = {
    orders: [{ id: 'o-till', status: 'completed' }, { id: 'o-web-1', status: 'completed' }, { id: 'o-web-2', status: 'completed' }],
    payments: [
      { order_id: 'o-till',  method: 'cash',  status: 'completed', amount: 400 },
      { order_id: 'o-web-1', method: 'cash',  status: 'completed', amount: 500 },
      { order_id: 'o-web-1', method: 'mpesa', status: 'completed', amount: 300 },
      { order_id: 'o-web-2', method: 'cash',  status: 'completed', amount: 250 },
      { order_id: 'o-web-2', method: 'cash',  status: 'refunded',  amount: -50 },
      { order_id: 'o-web-2', method: 'cash',  status: 'pending',   amount: 999 },
    ],
    floats:   [{ id: 'f-till', type: 'float_in', amount: 100 }, { id: 'f-web', type: 'float_out', amount: 80 }],
    expenses: [{ id: 'e-web', amount: 30 }],
  };
  const known = { order_ids: ['o-till'], float_ids: ['f-till'], expense_ids: [] };
  const f = foreignCash(cloud, known);

  ok('only what the till does not hold: 2 web sales', () => assert.equal(f.orders, 2));
  ok('cash only (not M-Pesa), completed payments (not pending)', () => assert.equal(f.cash_sales, 500 + 250 - 50));
  ok('a web refund comes back out (negative refunded rows count)', () => {
    const noRefund = foreignCash({ ...cloud, payments: cloud.payments.filter((p) => p.status !== 'refunded') }, known);
    assert.equal(f.cash_sales - noRefund.cash_sales, -50);
  });
  ok('floats and expenses the till does not hold', () => { assert.equal(f.float_in, 0); assert.equal(f.float_out, 80); assert.equal(f.expenses, 30); });
  ok('the change to expected cash: 700 − 80 − 30 = 590', () => assert.equal(foreignExpected(f), 590));
  ok('a voided / uncompleted web order adds nothing', () => {
    const v = foreignCash({ ...cloud, orders: cloud.orders.map((o) => (o.id === 'o-web-1' ? { ...o, status: 'voided' } : o)) }, known);
    assert.equal(v.orders, 1); assert.equal(v.cash_sales, 200);
  });
  ok('the till knows everything → nothing foreign', () => {
    const all = foreignCash(cloud, { order_ids: ['o-till', 'o-web-1', 'o-web-2'], float_ids: ['f-till', 'f-web'], expense_ids: ['e-web'] });
    assert.deepEqual(all, { orders: 0, cash_sales: 0, float_in: 0, float_out: 0, expenses: 0 });
  });

  // ── The route (source) ──
  const sh = read('apps/server/src/routes/shifts.ts');
  const route = sh.slice(sh.indexOf("router.post('/:id/foreign-cash'"), sh.indexOf("router.post('/:id/close'"));
  ok('the route exists, scoped to the caller\'s business, read-only', () => {
    assert.ok(route.length > 0);
    assert.match(route, /\.eq\('business_id', req\.businessId\)/);
    assert.doesNotMatch(route, /\.(update|insert|upsert|delete)\(/);
  });
  ok('authorised like /:id/close — the opener, a cashier on the same terminal, or a manager', () => {
    assert.match(route, /const sameTerminal =/); assert.match(route, /const openedByRequester =/);
    assert.match(route, /if \(!openedByRequester && !sameTerminal && !isManager\) \{\s*res\.status\(403\)/);
  });
  ok('same arithmetic source as the close: completed orders, cash payments completed|refunded', () => {
    assert.match(route, /fetchAllIds\('orders', q => q\.eq\('shift_id', id\)\.eq\('status', 'completed'\)\)/);
    assert.match(route, /\.eq\('method', 'cash'\)\.in\('status', \['completed', 'refunded'\]\)/);
  });

  // ── The till's wiring (source — Electron main not run here) ──
  const ipc = read('apps/desktop/src/main/ipcHandlers.ts');
  ok('an online PIN sign-in checks the cloud for this till\'s open drawer and returns what it joined', () => {
    assert.match(ipc, /const joinedDrawer = await joinCloudDrawer\(data\.staff\?\.id\);/);
    assert.match(ipc, /const adopted = adoptCloudShift\(cloud\);/);
    assert.match(ipc, /ownerFetch\('\/api\/shifts\/current'\), 4_000\)/);
  });
  ok('the close and the Z-report include the web\'s part; the till sends what it holds', () => {
    assert.match(ipc, /closeShift\(Number\(closing_float\), notes, await fetchForeignCash\(/);
    assert.match(ipc, /computeZReport\(shiftId, await fetchForeignCash\(shiftId\)\)/);
    assert.match(ipc, /body: JSON\.stringify\(localShiftIds\(shiftId\)\)/);
  });
  ok('the sell gate never waits on the cloud: POSPage asks shift.current() WITHOUT includeForeign', () => {
    const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
    assert.ok((pos.match(/posApi\.shift\.current\(\)/g) || []).length >= 1);
    assert.doesNotMatch(pos, /includeForeign/);
    assert.match(ipc, /if \(!opts\?\.includeForeign\) return currentShiftReport\(\);/);
  });
  ok('another cashier signing in is told whose drawer it is before selling', () => {
    const pin = read('apps/desktop/src/renderer/pages/PinPage.tsx');
    assert.match(pin, /if \(j && !j\.sameCashier\) \{/);
    assert.match(pin, /data-testid="joined-drawer"/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
