/**
 * Suite: Petrol Station
 * Tests: pumps CRUD, activate/idle lifecycle, fuel tanks CRUD,
 *        delivery recording, wet-stock reconciliation, fuel reports,
 *        full fuel sale order flow
 *
 * Run alone:
 *   node tests/runner.mjs --email owner@petrol.com --password pass --suite petrol
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, DELETE, state } from '../lib.mjs';

export async function run() {
  // ── Self-login when running this suite standalone ─────────────────────────
  // When run as part of the full suite (auth runs first), ownerToken is already
  // set. When run alone (--suite restaurant), we log in here instead.
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [petrol] skipped — no auth token and no credentials in state');
      return;
    }
    const login = await POST('/api/auth/login', {
      email:    state.ownerEmail,
      password: state.ownerPassword,
    });
    if (!login.data?.accessToken) {
      console.log('  [petrol] login failed:', login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken  = login.data.accessToken;
    state.refreshToken = login.data.refreshToken;
    state.businessId  = login.data.business?.id ?? null;
    // Also need branchId — fetch branches
    const branches = await GET('/api/branches', state.ownerToken);
    if ((branches.data ?? []).length > 0) {
      state.branchId = branches.data[0].id;
    }
    console.log('  [petrol] logged in as', state.ownerEmail);
  }



  let pumpId    = null;
  let tankId    = null;
  let fuelProdId = null;

  // ── Fuel products ─────────────────────────────────────────────────────────
  group('PETROL — Fuel products (prerequisite check)');

  // Petrol needs is_fuel products. Check if any exist; create one if not.
  const allProducts = await GET('/api/products', state.ownerToken);
  ok('GET /api/products → 200', allProducts.status === 200, 'got ' + allProducts.status);

  const existingFuel = (allProducts.data ?? []).find(p => p.is_fuel === true);
  okish('At least one is_fuel product exists', !!existingFuel,
    'No fuel product found — creating one for this test run');

  if (existingFuel) {
    fuelProdId = existingFuel.id;
  } else {
    // Create a fuel product to use for tanks + pumps tests
    const fuelProd = await POST('/api/products', {
      name:       'Test Petrol ' + Math.random().toString(36).slice(2, 6),
      base_price: 178.50,
      is_fuel:    true,
      fuel_unit:  'L',
      tax_type:   'B',
      status:     'active',
    }, state.ownerToken);
    ok('Created fuel product → 201', fuelProd.status === 201,
      'got ' + fuelProd.status + ': ' + (fuelProd.data?.error ?? ''));
    fuelProdId = fuelProd.data?.id;
  }
  ok('Have a fuel product ID', !!fuelProdId, 'fuelProdId=' + fuelProdId);

  // ── Pumps: CRUD ───────────────────────────────────────────────────────────
  group('PETROL — Pumps: list and create');

  const pumps = await GET('/api/pumps?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/pumps → 200', pumps.status === 200, 'got ' + pumps.status);
  ok('Pumps is array', Array.isArray(pumps.data));
  okish('Business has pumps configured', (pumps.data ?? []).length > 0,
    'No pumps found — creating one for this test run');

  if ((pumps.data ?? []).length > 0) {
    const p = pumps.data[0];
    ok('Pump has id',     !!p.id);
    ok('Pump has name',   !!p.name);
    ok('Pump has status', ['idle', 'dispensing', 'inactive'].includes(p.status),
      'got status: ' + p.status);
  }

  // Create a pump
  const pumpName = 'Pump-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const createPump = await POST('/api/pumps', {
    name:            pumpName,
    fuel_product_id: fuelProdId,
    status:          'idle',
    sort_order:      99,
    branch_id:       state.branchId,
  }, state.ownerToken);
  ok('POST /api/pumps → 201', createPump.status === 201,
    'got ' + createPump.status + ': ' + (createPump.data?.error ?? ''));
  ok('Created pump has id',     !!createPump.data?.id);
  ok('Pump status is idle',     createPump.data?.status === 'idle');
  ok('Pump name saved',         createPump.data?.name === pumpName);
  pumpId = createPump.data?.id;

  // Missing name → 400
  const noPumpName = await POST('/api/pumps', {
    fuel_product_id: fuelProdId, branch_id: state.branchId,
  }, state.ownerToken);
  ok('Pump without name → 400', noPumpName.status === 400, 'got ' + noPumpName.status);

  group('PETROL — Pumps: update');

  if (pumpId) {
    const updatePump = await PATCH('/api/pumps/' + pumpId, {
      name: pumpName + '-updated',
      sort_order: 1,
    }, state.ownerToken);
    ok('PATCH pump → 200', updatePump.status === 200, 'got ' + updatePump.status);
    ok('Name updated', updatePump.data?.name === pumpName + '-updated');

    // Fake pump → 404
    const fakePump = await PATCH('/api/pumps/00000000-0000-0000-0000-000000000001',
      { name: 'X' }, state.ownerToken);
    ok('PATCH fake pump → 404', fakePump.status === 404, 'got ' + fakePump.status);
  }

  // ── Pump lifecycle: activate → idle ───────────────────────────────────────
  group('PETROL — Pump lifecycle: activate and idle');

  if (pumpId) {
    // Activate: idle → dispensing
    const activate = await PATCH('/api/pumps/' + pumpId + '/activate', {}, state.ownerToken);
    ok('Activate pump → 200', activate.status === 200,
      'got ' + activate.status + ': ' + (activate.data?.error ?? ''));
    ok('Status is dispensing', activate.data?.status === 'dispensing',
      'got ' + activate.data?.status);

    // Activating an already-dispensing pump should still 200 (idempotent)
    const reactivate = await PATCH('/api/pumps/' + pumpId + '/activate', {}, state.ownerToken);
    ok('Re-activate dispensing pump → 200', reactivate.status === 200,
      'got ' + reactivate.status);

    // Release: dispensing → idle
    const idle = await PATCH('/api/pumps/' + pumpId + '/idle', {}, state.ownerToken);
    ok('Release pump to idle → 200', idle.status === 200,
      'got ' + idle.status + ': ' + (idle.data?.error ?? ''));
    ok('Status is idle', idle.data?.status === 'idle', 'got ' + idle.data?.status);

    // Mark inactive — inactive pump cannot be activated
    const markInactive = await PATCH('/api/pumps/' + pumpId,
      { status: 'inactive' }, state.ownerToken);
    ok('Mark pump inactive → 200', markInactive.status === 200);

    const activateInactive = await PATCH('/api/pumps/' + pumpId + '/activate', {}, state.ownerToken);
    ok('Activate inactive pump → 404 (blocked)', activateInactive.status === 404,
      'got ' + activateInactive.status);

    // Restore to idle for cleanup
    await PATCH('/api/pumps/' + pumpId, { status: 'idle' }, state.ownerToken);
  }

  // ── Fuel tanks: CRUD ──────────────────────────────────────────────────────
  group('PETROL — Fuel tanks: list and create');

  const tanks = await GET('/api/fuel-tanks?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/fuel-tanks → 200', tanks.status === 200, 'got ' + tanks.status);
  ok('Tanks is array', Array.isArray(tanks.data));
  okish('Business has tanks configured', (tanks.data ?? []).length > 0,
    'No tanks found — creating one for this test run');

  if ((tanks.data ?? []).length > 0) {
    const t = tanks.data[0];
    ok('Tank has id',              !!t.id);
    ok('Tank has name',            !!t.name);
    ok('Tank has capacity_litres', Number(t.capacity_litres) > 0);
    ok('current_level ≤ capacity',
      Number(t.current_level) <= Number(t.capacity_litres),
      'level=' + t.current_level + ' capacity=' + t.capacity_litres);
  }

  const tankName = 'Tank-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const createTank = await POST('/api/fuel-tanks', {
    name:             tankName,
    fuel_product_id:  fuelProdId,
    capacity_litres:  10000,
    current_level:    5000,
    reorder_level:    1000,
    branch_id:        state.branchId,
  }, state.ownerToken);
  ok('POST /api/fuel-tanks → 201', createTank.status === 201,
    'got ' + createTank.status + ': ' + (createTank.data?.error ?? ''));
  ok('Tank has id',                !!createTank.data?.id);
  ok('capacity_litres saved',      Number(createTank.data?.capacity_litres) === 10000);
  ok('current_level saved',        Number(createTank.data?.current_level)   === 5000);
  ok('reorder_level saved',        Number(createTank.data?.reorder_level)   === 1000);
  tankId = createTank.data?.id;

  // Missing required fields → 400
  const badTank = await POST('/api/fuel-tanks', {
    name: 'BadTank',
    // missing fuel_product_id and capacity_litres
  }, state.ownerToken);
  ok('Tank missing required fields → 400', badTank.status === 400, 'got ' + badTank.status);

  group('PETROL — Fuel tanks: update and delivery');

  if (tankId) {
    // Update reorder level
    const updateTank = await PATCH('/api/fuel-tanks/' + tankId, {
      reorder_level: 2000,
    }, state.ownerToken);
    ok('PATCH tank → 200', updateTank.status === 200, 'got ' + updateTank.status);
    ok('reorder_level updated', Number(updateTank.data?.reorder_level) === 2000);

    // Record a delivery: +3000 litres (total would be 8000, under 10000 cap)
    const delivery = await POST('/api/fuel-tanks/' + tankId + '/delivery', {
      litres:        3000,
      delivery_note: 'Test delivery from test suite',
    }, state.ownerToken);
    ok('POST /api/fuel-tanks/:id/delivery → 200', delivery.status === 200,
      'got ' + delivery.status + ': ' + (delivery.data?.error ?? ''));
    ok('delivered_litres matches', Number(delivery.data?.delivered_litres) === 3000);
    ok('new_level is 8000',        Number(delivery.data?.new_level) === 8000);
    ok('Tank in response',         !!delivery.data?.tank?.id);

    // Delivery that would overflow capacity — capped at capacity
    const overflow = await POST('/api/fuel-tanks/' + tankId + '/delivery', {
      litres: 50000, // far more than capacity
    }, state.ownerToken);
    ok('Overflow delivery → 200 (capped)', overflow.status === 200,
      'got ' + overflow.status);
    ok('Level capped at capacity',
      Number(overflow.data?.new_level) <= 10000,
      'got ' + overflow.data?.new_level);

    // Zero litres → 400
    const zeroDelivery = await POST('/api/fuel-tanks/' + tankId + '/delivery', {
      litres: 0,
    }, state.ownerToken);
    ok('Zero litres delivery → 400', zeroDelivery.status === 400, 'got ' + zeroDelivery.status);

    // Negative litres → 400
    const negDelivery = await POST('/api/fuel-tanks/' + tankId + '/delivery', {
      litres: -100,
    }, state.ownerToken);
    ok('Negative litres delivery → 400', negDelivery.status === 400, 'got ' + negDelivery.status);

    // Fake tank → 404
    const fakeTankDelivery = await POST('/api/fuel-tanks/00000000-0000-0000-0000-000000000001/delivery', {
      litres: 1000,
    }, state.ownerToken);
    ok('Delivery to fake tank → 404', fakeTankDelivery.status === 404, 'got ' + fakeTankDelivery.status);
  }

  // ── Stock movements ───────────────────────────────────────────────────────
  group('PETROL — Fuel stock movements');

  const movements = await GET('/api/fuel-tanks/movements?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/fuel-tanks/movements → 200', movements.status === 200, 'got ' + movements.status);
  ok('Movements is array', Array.isArray(movements.data));

  if ((movements.data ?? []).length > 0) {
    const m = movements.data[0];
    ok('Movement has movement_type', !!m.movement_type);
    ok('Movement type is sale or restock',
      ['sale', 'restock'].includes(m.movement_type),
      'got: ' + m.movement_type);
    ok('Movement has quantity_change', m.quantity_change !== undefined);
    ok('Movement has created_at',      !!m.created_at);
  }

  // ── Fuel order flow ───────────────────────────────────────────────────────
  group('PETROL — Full fuel sale order flow');

  if (state.shiftId && state.branchId && pumpId && fuelProdId) {
    // 1. Activate pump
    const activateForSale = await PATCH('/api/pumps/' + pumpId + '/activate', {}, state.ownerToken);
    ok('Activate pump for sale → 200', activateForSale.status === 200);

    // 2. Create a fuel order (litres as quantity, amount as lineTotal)
    const litres = 20;
    const pricePerLitre = 178.50;
    const amount = Math.round(litres * pricePerLitre * 100) / 100;

    const fuelOrder = await POST('/api/orders', {
      branch_id:       state.branchId,
      order_number:    'FUEL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      order_type:      'fuel_sale',
      subtotal:        amount,
      vat_amount:      0,
      total:           amount,
      discount_amount: 0,
      shift_id:        state.shiftId,
      items: [{
        product:           { id: fuelProdId },
        product_name:      existingFuel?.name ?? 'Petrol',
        category_name:     'Fuel',
        quantity:          litres,
        unitPrice:         pricePerLitre,
        lineTotal:         amount,
        isFuel:            true,
        selectedVariants:  [],
        selectedModifiers: [],
      }],
      payments: [{ method: 'cash', amount: amount }],
    }, state.ownerToken);
    ok('POST fuel order → 200/201', [200, 201].includes(fuelOrder.status),
      'got ' + fuelOrder.status + ': ' + (fuelOrder.data?.error ?? ''));
    ok('Fuel order has orderId', !!fuelOrder.data?.orderId);

    // 3. Release pump
    const releaseAfterSale = await PATCH('/api/pumps/' + pumpId + '/idle', {}, state.ownerToken);
    ok('Release pump after sale → 200', releaseAfterSale.status === 200);
    ok('Pump is idle', releaseAfterSale.data?.status === 'idle');
  } else {
    okish('Full fuel sale flow', false,
      'Skipped — needs open shift, branchId, pumpId, and fuelProdId');
  }

  // ── Reports ───────────────────────────────────────────────────────────────
  group('PETROL — Fuel reports');

  const today = new Date().toISOString().split('T')[0];

  const pumpMonitor = await GET(
    '/api/reports/pump-monitor?from=' + today + '&to=' + today + '&branch_id=' + (state.branchId ?? ''),
    state.ownerToken
  );
  ok('GET /api/reports/pump-monitor → 200', pumpMonitor.status === 200, 'got ' + pumpMonitor.status);
  ok('pump-monitor has pumps array', Array.isArray(pumpMonitor.data?.pumps ?? pumpMonitor.data),
    'got: ' + JSON.stringify(pumpMonitor.data).slice(0, 60));

  const wetStock = await GET(
    '/api/reports/wet-stock?from=' + today + '&to=' + today + '&branch_id=' + (state.branchId ?? ''),
    state.ownerToken
  );
  ok('GET /api/reports/wet-stock → 200', wetStock.status === 200, 'got ' + wetStock.status);
  ok('wet-stock has tanks array', Array.isArray(wetStock.data?.tanks ?? wetStock.data),
    'got: ' + JSON.stringify(wetStock.data).slice(0, 60));

  // ── Security ───────────────────────────────────────────────────────────────
  group('PETROL — Security: cross-tenant pump isolation');

  // Activate a pump from a different business → 404 (not 200 or 500)
  const fakePumpActivate = await PATCH(
    '/api/pumps/00000000-0000-0000-0000-000000000001/activate', {}, state.ownerToken
  );
  ok('Activate fake pump → 404', fakePumpActivate.status === 404, 'got ' + fakePumpActivate.status);

  const fakeTankPatch = await PATCH(
    '/api/fuel-tanks/00000000-0000-0000-0000-000000000001',
    { name: 'Hijack' }, state.ownerToken
  );
  ok('PATCH fake tank → 404', fakeTankPatch.status === 404, 'got ' + fakeTankPatch.status);

  // Pumps require auth
  const noAuthPumps = await GET('/api/pumps');
  ok('GET /api/pumps without auth → 401', noAuthPumps.status === 401, 'got ' + noAuthPumps.status);

  const noAuthTanks = await GET('/api/fuel-tanks');
  ok('GET /api/fuel-tanks without auth → 401', noAuthTanks.status === 401, 'got ' + noAuthTanks.status);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  group('PETROL — Cleanup: delete test pump and tank');

  if (pumpId) {
    const delPump = await DELETE('/api/pumps/' + pumpId, state.ownerToken);
    ok('DELETE test pump → 204', delPump.status === 204, 'got ' + delPump.status);
  }

  if (tankId) {
    const delTank = await DELETE('/api/fuel-tanks/' + tankId, state.ownerToken);
    ok('DELETE test tank → 204', delTank.status === 204, 'got ' + delTank.status);
  }
}
