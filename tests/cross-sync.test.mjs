/**
 * cross-sync.test.mjs — stage 1 (2026-09-27): what is sold on the web as a till appears on that till;
 * the manager sees other tills from the cloud; and the till's void/refund finds its own sales (A335).
 *
 * Owner: "calculations are off from web to desktop pos the orders should cross sync what i sell on the web
 * using the same till should appear on the till or branch if its a different till. fix it"
 *
 *   node tests/cross-sync.test.mjs
 *
 * RUNS the real cloud rules (lib/foreignCash.ts foreignOrders + foreignCash, lib/resolveOrder.ts). The till
 * side runs for real in apps/desktop/test/web-sales.test.mjs (compiled webSales + shiftService + nodeIngest on
 * SQLite). Express routes and Electron wiring are pinned by source here (not run) — the live two-surface
 * check is a target check (rule 16).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - foreignOrders matches own sales by id only (not idempotency_key) → "a sale the till rang is never sent back" fails
 *   - foreignOrders drops 'voided'                                     → "a web void is sent (so it reaches the till)" fails
 *   - resolveOrderId skips the idempotency_key lookup                   → "A335: the till's own id finds the sale" fails
 *   - the void route goes back to req.params.id                         → "void and refund resolve the id" fails
 *   - ownReversals matches by id only (not idempotency_key)             → "A336 follow-up: a web refund…" fails
 *   - ownReversals keeps the sale's paid rows as refund rows            → "…only the money-out rows" fails
 *   - the foreign-orders route stops sending own_reversals              → "…sent with the web-sales pull" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.CROSS_SYNC_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, CROSS_SYNC_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
  const { foreignOrders, foreignCash, ownReversals } = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/foreignCash.ts')).href);
  const { resolveOrderId } = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/resolveOrder.ts')).href);

  // ── The rule: which sales on a drawer go down to the till ──
  const TILL_UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const onDrawer = [
    { id: 'cloud-1', status: 'completed', idempotency_key: TILL_UUID,  payments: [{ status: 'completed', amount: 400 }] },   // the till's own sale
    { id: 'cloud-2', status: 'completed', idempotency_key: 'web-k-2', payments: [{ status: 'completed', amount: 700 }, { status: 'pending', amount: 9 }] },
    { id: 'cloud-3', status: 'voided',    idempotency_key: 'web-k-3', payments: [{ status: 'completed', amount: 50 }] },
    { id: 'cloud-4', status: 'open',      idempotency_key: 'web-k-4' },
    { id: 'cloud-5', status: 'held',      idempotency_key: 'web-k-5' },
  ];
  const down = foreignOrders(onDrawer, [TILL_UUID]);
  await ok('a sale the till rang is never sent back (matched by idempotency_key — the cloud re-keys it)', () => {
    assert.ok(!down.some((o) => o.id === 'cloud-1'));
  });
  await ok('a web sale is sent; a web void is sent (so it reaches the till); open and held tabs are not sales yet', () => {
    assert.deepEqual(down.map((o) => o.id), ['cloud-2', 'cloud-3']);
  });
  await ok('payments as the close counts them: a pending M-Pesa push is not money', () => {
    assert.deepEqual(down.find((o) => o.id === 'cloud-2').payments.map((p) => p.amount), [700]);
  });
  await ok('a sale the till already downloaded is sent again (own_ids is only what it RANG) — how a later void arrives', () => {
    assert.ok(foreignOrders(onDrawer, [TILL_UUID]).some((o) => o.id === 'cloud-2'));
  });
  await ok('no double count: once downloaded (the till holds cloud-2), foreign-cash no longer adds it', () => {
    const input = { orders: [{ id: 'cloud-2', status: 'completed', idempotency_key: 'web-k-2' }],
      payments: [{ order_id: 'cloud-2', method: 'cash', status: 'completed', amount: 700 }], floats: [], expenses: [] };
    assert.equal(foreignCash(input, { order_ids: [] }).cash_sales, 700);          // not yet downloaded → the close adds it
    assert.equal(foreignCash(input, { order_ids: ['cloud-2'] }).cash_sales, 0);   // downloaded → the till's own figures hold it
  });

  // ── A335: the till voids/refunds by ITS id ──
  const rows = { id: { 'aaaaaaaa-0000-4000-8000-000000000001': 'aaaaaaaa-0000-4000-8000-000000000001' },
                 idempotency_key: { [TILL_UUID]: 'aaaaaaaa-0000-4000-8000-000000000009', 'T1--37': 'aaaaaaaa-0000-4000-8000-000000000007' } };
  const asked = [];
  const lookup = async (col, v) => { asked.push(`${col}=${v}`); return rows[col][v] ?? null; };
  await ok('A335: the till\'s own id finds the sale (by idempotency_key)', async () => {
    assert.equal(await resolveOrderId(TILL_UUID, lookup), 'aaaaaaaa-0000-4000-8000-000000000009');
  });
  await ok('the web\'s cloud id still finds it directly', async () => {
    assert.equal(await resolveOrderId('aaaaaaaa-0000-4000-8000-000000000001', lookup), 'aaaaaaaa-0000-4000-8000-000000000001');
  });
  await ok('a non-uuid id is never compared to the uuid column (Postgres would reject it)', async () => {
    asked.length = 0;
    assert.equal(await resolveOrderId('T1--37', lookup), 'aaaaaaaa-0000-4000-8000-000000000007');
    assert.deepEqual(asked, ['idempotency_key=T1--37']);
  });
  await ok('unknown → the ref unchanged (the route then answers 404 as before)', async () => {
    assert.equal(await resolveOrderId('nope', lookup), 'nope');
  });

  // ── The cloud routes (source — Express not run here) ──
  const orders = read('apps/server/src/routes/orders.ts');
  await ok('void and refund resolve the id inside the caller\'s business before anything else', () => {
    for (const r of ["router.post('/:id/refund'", "router.post('/:id/void'"]) {
      const body = orders.slice(orders.indexOf(r), orders.indexOf(r) + 400);
      assert.match(body, /const orderId = await cloudOrderId\(req\.params\.id, req\.businessId!\);/, r);
    }
    assert.match(orders, /\.eq\(column, value\)\.eq\('business_id', businessId\)/);
  });
  await ok('the order list carries device_id (the branch view marks this till)', () => {
    // 0.6.27: then cashier_id, delivery_person, delivery_fee (History's own-sales filter and "Delivery — Eugene").
    assert.match(orders, /created_at, branch_id, customer_name, device_id,\n\s+cashier_id, delivery_person, delivery_fee,\n\s+payments \( method, amount, status \)/);
  });
  const sh = read('apps/server/src/routes/shifts.ts');
  const route = sh.slice(sh.indexOf("router.post('/:id/foreign-orders'"), sh.indexOf("router.post('/:id/close'"));
  await ok('foreign-orders: read-only, scoped to the business and the shift, authorised like foreign-cash', () => {
    assert.ok(route.length > 0);
    assert.match(route, /\.eq\('shift_id', id\)\s*\.eq\('business_id', req\.businessId\)/);
    assert.doesNotMatch(route, /\.(update|insert|upsert|delete)\(/);
    assert.match(route, /if \(!openedByRequester && !sameTerminal && !isManager\) \{\s*res\.status\(403\)/);
    assert.match(route, /res\.json\(\{ orders: foreignOrders\(/);
  });

  // ── The till's wiring (source — Electron main not run here) ──
  const se = read('apps/desktop/src/main/syncEngine.ts');
  const ipc = read('apps/desktop/src/main/ipcHandlers.ts');
  await ok('the till asks for each of its drawers, telling the cloud only what it RANG, and stores the answer', () => {
    const f = se.slice(se.indexOf('export async function pullWebSales'), se.indexOf('// A291: cheap catalogue-freshness poll.'));
    assert.match(f, /for \(const shift of webSaleShifts\(\)\)/);
    assert.match(f, /\/api\/shifts\/\$\{encodeURIComponent\(shift\.id\)\}\/foreign-orders/);
    assert.match(f, /body: JSON\.stringify\(\{ own_ids: ownOrderIds\(shift\.id\) \}\)/);
    assert.match(f, /changed \+= applyWebOrders\(shift, body\.orders \?\? \[\]\);/);
  });
  await ok('…every ~20 s, after every full sync, and at sign-in', () => {
    const idx = read('apps/desktop/src/main/index.ts');
    assert.match(idx, /pullIfCatalogueChanged\(\)\.catch\(console\.error\);[\s\S]{0,200}pullWebSales\(\)\.catch\(console\.error\);\s*\}, 20_000\);/);
    assert.match(se, /try \{ await pullWebSales\(\); \} catch/);
    assert.match(ipc, /const joinedDrawer = await joinCloudDrawer\(data\.staff\?\.id\);[\s\S]{0,300}pullWebSales\(\)\.catch/);
  });
  await ok('the branch view reads the cloud order list for this branch; offline falls back to this till and says so', () => {
    const h = ipc.slice(ipc.indexOf("handle('manager:branchOrders'"), ipc.indexOf("handle('manager:branchOrders'") + 1000);
    assert.match(h, /\/api\/orders\?\$\{q\}/); assert.match(h, /q\.set\('branch_id', cfg\.branch_id\)/);
    const mp = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
    assert.match(mp, /label: 'All tills at this branch'/);
    assert.match(mp, /note: 'The cloud could not be reached — showing this till only\.'/);
  });
  await ok('rule 21: the new screens say "cloud", never "server" alone', () => {
    const mp = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
    const tab = mp.slice(mp.indexOf('function OrdersTab'), mp.indexOf('// ── Shift Tab'));
    assert.doesNotMatch(tab.replace(/\/\/.*$/gm, ''), /\bserver\b/i);
  });

  // ── A336 follow-up (0.6.26): the till's OWN sales reversed on the web go back down as reversals ──
  const OWN_A = '0a1b2c3d-0000-4000-8000-00000000000a', OWN_B = '0a1b2c3d-0000-4000-8000-00000000000b';
  const OWN_C = '0a1b2c3d-0000-4000-8000-00000000000c';
  const drawer2 = [
    { id: 'c-a', status: 'completed', idempotency_key: OWN_A, refunded_at: '2026-09-30T10:00:00Z', refunded_amount: '400.00', refund_reason: 'Cold',
      payments: [{ id: 'p-a1', method: 'cash', amount: 700, status: 'completed', created_at: '2026-09-30T09:00:00Z' },
                 { id: 'p-a2', method: 'cash', amount: -400, status: 'refunded', created_at: '2026-09-30T10:00:00Z' }] },
    { id: 'c-b', status: 'voided', idempotency_key: OWN_B, voided_at: '2026-09-30T11:00:00Z', void_reason: 'Wrong till',
      payments: [{ id: 'p-b1', method: 'mpesa', amount: 250, status: 'completed' }] },
    { id: 'c-c', status: 'completed', idempotency_key: OWN_C, refunded_amount: 0, payments: [] },            // untouched — not sent
    { id: 'c-w', status: 'voided', idempotency_key: 'web-k-9', payments: [] },                                // web-rung — goes as an order
  ];
  const rev = ownReversals(drawer2, [OWN_A, OWN_B, OWN_C]);
  await ok('A336 follow-up: a web refund and a web void of the till\'s own sales go back, under the TILL\'s id', () => {
    assert.deepEqual(rev.map((r) => [r.local_id, r.status]), [[OWN_A, 'completed'], [OWN_B, 'voided']]);
    assert.equal(rev[0].refunded_amount, 400); assert.equal(rev[0].refund_reason, 'Cold');
    assert.equal(rev[1].voided_at, '2026-09-30T11:00:00Z'); assert.equal(rev[1].void_reason, 'Wrong till');
  });
  await ok('…only the money-out rows of the refund travel (never the sale\'s own payments)', () => {
    assert.deepEqual(rev[0].refund_payments, [{ id: 'p-a2', method: 'cash', amount: -400, created_at: '2026-09-30T10:00:00Z' }]);
    assert.deepEqual(rev[1].refund_payments, []);
  });
  await ok('…a sale the till did not ring, or one nobody reversed, is not a reversal', () => {
    assert.equal(ownReversals(drawer2, []).length, 0);
    assert.ok(!rev.some((r) => r.local_id === OWN_C || r.local_id === 'web-k-9'));
  });
  await ok('…sent with the web-sales pull (an older till ignores the field)', () => {
    assert.match(read('apps/server/src/routes/shifts.ts'),
      /res\.json\(\{ orders: foreignOrders\(rows, ownIds\), own_reversals: ownReversals\(rows, ownIds\) \}\);/);
    assert.match(se, /changed \+= applyOwnReversals\(body\.own_reversals \?\? \[\], undefined,/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
