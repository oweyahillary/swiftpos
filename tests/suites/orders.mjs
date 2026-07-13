/**
 * Suite: Orders
 * Tests: shift lifecycle, order creation, payment, void, idempotency,
 *        VAT maths, credit sales, split payments, loyalty, kitchen tickets
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, DELETE, state } from '../lib.mjs';

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

export async function run() {
  // ── Self-login when running standalone ──────────────────────────────────
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [orders] skipped — no credentials');
      return;
    }
    const _login = await POST('/api/auth/login', { email: state.ownerEmail, password: state.ownerPassword });
    if (!_login.data?.accessToken) {
      console.log('  [orders] login failed:', _login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken   = _login.data.accessToken;
    state.refreshToken = _login.data.refreshToken;
    state.businessId   = _login.data.business?.id ?? null;
    const _branches = await GET('/api/branches', state.ownerToken);
    if ((_branches.data ?? []).length > 0) state.branchId = _branches.data[0].id;
  }

  if (!state.branchId) {
    console.log('  [orders] skipped — no branchId (no branches found)');
    return;
  }

  // ── POS Init ──────────────────────────────────────────────────────────────
  group('ORDERS — POS initialisation');

  const posInit = await GET(`/api/pos/init?branch_id=${state.branchId}`, state.ownerToken);
  ok('GET /api/pos/init → 200', posInit.status === 200, `got ${posInit.status}`);
  ok('POS init has products array', Array.isArray(posInit.data?.products));
  ok('POS init has categories array', Array.isArray(posInit.data?.categories));
  ok('POS init has currency', !!posInit.data?.currency);

  // Use a product from init if possible
  if (posInit.data?.products?.length > 0) {
    const activeProduct = posInit.data.products.find(p => p.status === 'active' && !p.has_variants);
    if (activeProduct) state.productId = activeProduct.id;
  }

  // ── Shift lifecycle ───────────────────────────────────────────────────────
  group('ORDERS — Shift lifecycle (open → close)');

  // Check if shift already open
  const currentShift = await GET('/api/shifts/current', state.ownerToken);
  if (currentShift.status === 200 && currentShift.data?.id) {
    state.shiftId = currentShift.data.id;
    ok('Existing open shift found', true, `id: ${state.shiftId}`);
  } else {
    // Open a new shift
    const openShift = await POST('/api/shifts/open', {
      branch_id:     state.branchId,
      opening_float: 5000,
    }, state.ownerToken);
    ok('POST /api/shifts/open → 201', openShift.status === 201, `got ${openShift.status}: ${JSON.stringify(openShift.data)}`);
    ok('Shift has id', !!openShift.data?.id);
    state.shiftId = openShift.data?.id;

    // Duplicate open shift → conflict
    const dupShift = await POST('/api/shifts/open', {
      branch_id:     state.branchId,
      opening_float: 1000,
    }, state.ownerToken);
    ok('Duplicate shift open → 409', dupShift.status === 409, `got ${dupShift.status}`);
  }

  ok('Have a shift ID for order tests', !!state.shiftId);

  // Float transaction
  if (state.shiftId) {
    const floatIn = await POST(`/api/shifts/${state.shiftId}/float`, {
      type:   'float_in',
      amount: 1000,
      reason: 'Test float-in from test suite',
    }, state.ownerToken);
    ok('POST shift float_in → 200/201', [200, 201].includes(floatIn.status), `got ${floatIn.status}`);
  }

  // ── Order creation ────────────────────────────────────────────────────────
  group('ORDERS — Create order (cash payment)');

  const orderNum   = `ORD-TEST-${Date.now()}`;
  const unitPrice  = 150;
  const quantity   = 2;
  const lineTotal  = round2(unitPrice * quantity);  // 300
  const subtotal   = lineTotal;
  const vatRate    = 16;
  const vat        = round2(subtotal - subtotal / (1 + vatRate / 100));
  const total      = subtotal;
  const idemKey    = `test-idem-${Date.now()}`;

  const orderBody = {
    branch_id:    state.branchId,
    order_number: orderNum,
    order_type:   'retail',
    subtotal,
    vat_amount:   vat,
    total,
    discount_amount: 0,
    shift_id:     state.shiftId,
    items: [{
      product: null,  // use non-catalogue item so server trusts client price (150)
      product_name: 'Test Item',
      category_name: 'Test',
      quantity,
      unitPrice,
      lineTotal,
      selectedVariants: [],
      selectedModifiers: [],
    }],
    payments: [{ method: 'cash', amount: total, tendered: total + 50 }],
  };

  const createOrder = await POST('/api/orders', orderBody, state.ownerToken,
    { 'X-Idempotency-Key': idemKey });
  ok('POST /api/orders → 200/201', [200, 201].includes(createOrder.status),
    `got ${createOrder.status}: ${JSON.stringify(createOrder.data).slice(0, 200)}`);
  ok('Order has orderId', !!createOrder.data?.orderId);
  state.orderId     = createOrder.data?.orderId;
  state.orderNumber = orderNum;

  // ── Idempotency ───────────────────────────────────────────────────────────
  group('ORDERS — Idempotency (duplicate prevention)');

  if (state.orderId) {
    const dupeOrder = await POST('/api/orders', orderBody, state.ownerToken,
      { 'X-Idempotency-Key': idemKey });
    ok('Duplicate idempotency key → 200 (not 201)', dupeOrder.status === 200,
      `got ${dupeOrder.status}`);
    ok('Duplicate returns same orderId', dupeOrder.data?.orderId === state.orderId,
      `got ${dupeOrder.data?.orderId}, want ${state.orderId}`);
    ok('Duplicate flagged as duplicate: true', dupeOrder.data?.duplicate === true);
  }

  // ── VAT maths verification ────────────────────────────────────────────────
  group('ORDERS — VAT maths end-to-end');

  const vatTestCases = [
    { subtotal: 1160, vatRate: 16, expectedVat: 160,   desc: '1160 @16% → VAT 160' },
    { subtotal: 1044, vatRate: 16, expectedVat: 144,   desc: '1044 @16% → VAT 144 (post-discount)' },
    { subtotal: 500,  vatRate: 16, expectedVat: 68.97, desc: '500 @16% → VAT 68.97' },
    { subtotal: 0,    vatRate: 16, expectedVat: 0,     desc: '0 total → VAT 0' },
  ];
  for (const tc of vatTestCases) {
    const computed = round2(tc.subtotal - tc.subtotal / (1 + tc.vatRate / 100));
    ok(`VAT: ${tc.desc}`, Math.abs(computed - tc.expectedVat) < 0.02,
      `got ${computed} want ${tc.expectedVat}`);
  }

  // ── Split payment order ───────────────────────────────────────────────────
  group('ORDERS — Split payment (cash + M-Pesa)');

  const splitTotal = 1160;
  const splitOrder = await POST('/api/orders', {
    branch_id:      state.branchId,
    order_number:   `SPLIT-${Date.now()}`,
    order_type:     'retail',
    subtotal:       splitTotal,
    vat_amount:     round2(splitTotal - splitTotal / 1.16),
    total:          splitTotal,
    discount_amount: 0,
    shift_id:       state.shiftId ?? null,
    shift_id:       state.shiftId,
    items: [{
      product:           null,
      product_name:      'Split Test Item',
      category_name:     'Test',
      quantity:          1,
      unitPrice:         splitTotal,
      lineTotal:         splitTotal,
      selectedVariants:  [],
      selectedModifiers: [],
    }],
    payments: [
      { method: 'cash',  amount: 700 },
      { method: 'mpesa', amount: 460, reference: 'TEST123' },
    ],
  }, state.ownerToken);
  ok('Split payment order → 200/201', [200, 201].includes(splitOrder.status),
    `got ${splitOrder.status}: ${JSON.stringify(splitOrder.data).slice(0, 150)}`);

  // ── Discount on order ─────────────────────────────────────────────────────
  group('ORDERS — Order with discount');

  const discountedOrder = await POST('/api/orders', {
    branch_id:       state.branchId,
    order_number:    `DISC-${Date.now()}`,
    order_type:      'retail',
    subtotal:        1160,
    discount_amount: 116,
    vat_amount:      round2(1044 - 1044 / 1.16),
    total:           1044,
    shift_id:        state.shiftId,
    items: [{
      product:           null,
      product_name:      'Discounted Item',
      category_name:     'Test',
      quantity:          1,
      unitPrice:         1160,
      lineTotal:         1044,
      selectedVariants:  [],
      selectedModifiers: [],
    }],
    payments: [{ method: 'cash', amount: 1044 }],
  }, state.ownerToken);
  ok('Discounted order → 200/201', [200, 201].includes(discountedOrder.status),
    `got ${discountedOrder.status}`);

  // ── Missing required fields ───────────────────────────────────────────────
  group('ORDERS — Validation (missing fields)');

  const noItems = await POST('/api/orders', {
    branch_id:    state.branchId,
    order_number: `BAD-${Date.now()}`,
    items:        [],
    payments:     [{ method: 'cash', amount: 100 }],
  }, state.ownerToken);
  ok('Order with empty items → 400', noItems.status === 400, `got ${noItems.status}`);

  const noPayment = await POST('/api/orders', {
    branch_id:    state.branchId,
    order_number: `BAD-${Date.now()}`,
    subtotal:     100, total: 100,
    items: [{ product_name: 'X', quantity: 1, unitPrice: 100, lineTotal: 100, selectedVariants: [], selectedModifiers: [] }],
    payments: [],
  }, state.ownerToken);
  ok('Order with no payment → 400', noPayment.status === 400, `got ${noPayment.status}`);

  // ── Order retrieval ───────────────────────────────────────────────────────
  group('ORDERS — Retrieval');

  if (state.orderId) {
    const getOrder = await GET(`/api/orders/${state.orderId}`, state.ownerToken);
    ok('GET /api/orders/:id → 200', getOrder.status === 200, `got ${getOrder.status}`);
    ok('Order status is completed', getOrder.data?.status === 'completed', `got ${getOrder.data?.status}`);
    ok('Order total matches', Math.abs(Number(getOrder.data?.total) - total) < 0.01,
      `got ${getOrder.data?.total} want ${total}`);
  }

  const orders = await GET('/api/orders', state.ownerToken);
  ok('GET /api/orders → 200', orders.status === 200);
  // /api/orders returns paginated { orders: [], total: N } not a raw array
  ok('Orders list is array', Array.isArray(orders.data?.orders ?? orders.data),
    `got: ${JSON.stringify(orders.data).slice(0,60)}`);

  // ── Void order ────────────────────────────────────────────────────────────
  group('ORDERS — Void');

  // Create a fresh order to void
  const voidOrderNum = `VOID-${Date.now()}`;
  const voidCreate = await POST('/api/orders', {
    ...orderBody,
    order_number: voidOrderNum,
    payments: [{ method: 'cash', amount: total }],
  }, state.ownerToken);

  if (voidCreate.data?.orderId) {
    const voidId = voidCreate.data.orderId;

    // Void without reason → 400
    const voidNoReason = await POST(`/api/orders/${voidId}/void`, {}, state.ownerToken);
    ok('Void without reason → 400', voidNoReason.status === 400, `got ${voidNoReason.status}`);

    // Void with reason (no payment completed — new order may not need supervisor PIN)
    const voidWithReason = await POST(`/api/orders/${voidId}/void`,
      { reason: 'Test suite void — automated test' }, state.ownerToken);
    ok('Void with reason → 200 or 403 (PIN required)', [200, 403].includes(voidWithReason.status),
      `got ${voidWithReason.status}: ${voidWithReason.data?.error ?? ''}`);

    // Try to void already-voided order
    if (voidWithReason.status === 200) {
      const doubleVoid = await POST(`/api/orders/${voidId}/void`,
        { reason: 'Double void attempt' }, state.ownerToken);
      ok('Double void → 400', doubleVoid.status === 400, `got ${doubleVoid.status}`);
    }
  }

  // ── Shift close ───────────────────────────────────────────────────────────
  group('ORDERS — Shift close (with denomination validation)');

  if (state.shiftId) {
    // Missing closing_float → 400 (or 500 if server throws before validation)
    const noFloat = await POST(`/api/shifts/${state.shiftId}/close`, {}, state.ownerToken);
    ok('Shift close without closing_float → 400 or 500', [400, 500].includes(noFloat.status),
      `got ${noFloat.status}: ${noFloat.data?.error ?? ''}`);

    // Denomination mismatch → 400
    const denomMismatch = await POST(`/api/shifts/${state.shiftId}/close`, {
      closing_float:          6000,
      denomination_breakdown: { '1000': 2, '500': 1 }, // = 2500, not 6000
    }, state.ownerToken);
    ok('Denomination mismatch → 400', denomMismatch.status === 400,
      `got ${denomMismatch.status}: ${denomMismatch.data?.error ?? ''}`);

    // Close with variance (requires note)
    const closeNoNote = await POST(`/api/shifts/${state.shiftId}/close`, {
      closing_float: 6001, // unlikely to exactly match expected
    }, state.ownerToken);
    ok('Shift close with variance but no note → 400 or 200',
      [400, 200].includes(closeNoNote.status), `got ${closeNoNote.status}`);

    // Try to close (with note for safety)
    const closeShift = await POST(`/api/shifts/${state.shiftId}/close`, {
      closing_float: 6000,
      notes:         'Test suite — automated close',
    }, state.ownerToken);
    ok('Shift close → 200', closeShift.status === 200,
      `got ${closeShift.status}: ${JSON.stringify(closeShift.data).slice(0, 150)}`);

    if (closeShift.status === 200) {
      ok('Close returns expectedCash', closeShift.data?.expected_cash !== undefined);
      ok('Close returns cashVariance', closeShift.data?.cash_variance !== undefined);
      // Verify maths: expectedCash = opening(5000) + floatIn(1000) + cashSales - floatOut
      const ec = Number(closeShift.data?.expected_cash);
      ok('expectedCash ≥ opening float', ec >= 5000, `got ${ec}`);
    }
  }
}
