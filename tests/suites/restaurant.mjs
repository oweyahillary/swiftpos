/**
 * Suite: Restaurant
 * Tests: tables CRUD, floor plan positions, reservations, waitlist,
 *        kitchen ticket status flow, order-first model, QR ordering
 *
 * Run alone:
 *   node tests/runner.mjs --email owner@restaurant.com --password pass --suite restaurant
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, DELETE, state, BASE_URL } from '../lib.mjs';

const today    = new Date().toISOString().split('T')[0];
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

export async function run() {
  // ── Self-login when running this suite standalone ─────────────────────────
  // When run as part of the full suite (auth runs first), ownerToken is already
  // set. When run alone (--suite restaurant), we log in here instead.
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [restaurant] skipped — no auth token and no credentials in state');
      return;
    }
    const login = await POST('/api/auth/login', {
      email:    state.ownerEmail,
      password: state.ownerPassword,
    });
    if (!login.data?.accessToken) {
      console.log('  [restaurant] login failed:', login.data?.error ?? 'unknown');
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
    console.log('  [restaurant] logged in as', state.ownerEmail);
  }



  let tableId       = null;
  let reservationId = null;
  let waitlistId    = null;
  let openOrderId   = null;

  // ── Tables: list ─────────────────────────────────────────────────────────
  group('RESTAURANT — Tables: list');

  const tables = await GET('/api/tables?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/tables → 200', tables.status === 200, 'got ' + tables.status);
  ok('Tables is array', Array.isArray(tables.data));
  okish('At least one table configured', (tables.data ?? []).length > 0,
    'No tables found — create some in Settings to test floor plan');

  if ((tables.data ?? []).length > 0) {
    const t = tables.data[0];
    ok('Table has id',       !!t.id);
    ok('Table has name',     !!t.name);
    ok('Table has capacity', Number(t.capacity) > 0);
    ok('Table status is active', t.status === 'active');
  }

  const allTables = await GET('/api/tables/all?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/tables/all → 200 (owner)', allTables.status === 200, 'got ' + allTables.status);
  ok('All-tables includes inactive', Array.isArray(allTables.data));

  // ── Tables: CRUD ──────────────────────────────────────────────────────────
  group('RESTAURANT — Tables: create, update, delete');

  const tableName = 'TestTable-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const createTable = await POST('/api/tables', {
    branch_id:  state.branchId,
    name:       tableName,
    capacity:   4,
    sort_order: 99,
  }, state.ownerToken);
  ok('POST /api/tables → 201', createTable.status === 201,
    'got ' + createTable.status + ': ' + (createTable.data?.error ?? ''));
  ok('Created table has id', !!createTable.data?.id);
  tableId = createTable.data?.id;

  if (tableId) {
    // Duplicate name → 409
    const dupTable = await POST('/api/tables', {
      branch_id: state.branchId,
      name:      tableName,
      capacity:  2,
    }, state.ownerToken);
    ok('Duplicate table name → 409', dupTable.status === 409, 'got ' + dupTable.status);

    // Update floor plan position + zone + shape
    const updateTable = await PATCH('/api/tables/' + tableId, {
      capacity: 6,
      pos_x:    120,
      pos_y:    240,
      zone:     'Terrace',
      shape:    'circle',
    }, state.ownerToken);
    ok('PATCH table → 200', updateTable.status === 200, 'got ' + updateTable.status);
    ok('Capacity updated', updateTable.data?.capacity === 6, 'got ' + updateTable.data?.capacity);
    ok('Zone saved',   updateTable.data?.zone  === 'Terrace', 'got ' + updateTable.data?.zone);
    ok('Shape saved',  updateTable.data?.shape === 'circle',  'got ' + updateTable.data?.shape);
    ok('pos_x saved',  updateTable.data?.pos_x === 120,       'got ' + updateTable.data?.pos_x);

    // Soft deactivate then reactivate
    const deact = await PATCH('/api/tables/' + tableId, { status: 'inactive' }, state.ownerToken);
    ok('Deactivate table → 200', deact.status === 200);
    ok('Status is inactive', deact.data?.status === 'inactive');

    const react = await PATCH('/api/tables/' + tableId, { status: 'active' }, state.ownerToken);
    ok('Reactivate table → 200', react.status === 200);

    // Delete
    const del = await DELETE('/api/tables/' + tableId, state.ownerToken);
    ok('DELETE table → 200', del.status === 200, 'got ' + del.status);
    tableId = null;
  }

  // No branch_id → 400
  const nobranchTable = await POST('/api/tables', { name: 'NoBranch' }, state.ownerToken);
  ok('Table without branch_id → 400', nobranchTable.status === 400, 'got ' + nobranchTable.status);

  // ── Reservations: CRUD ────────────────────────────────────────────────────
  group('RESTAURANT — Reservations: list and create');

  const rList = await GET('/api/reservations?date=' + today + '&branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/reservations → 200', rList.status === 200, 'got ' + rList.status);
  ok('Reservations is array', Array.isArray(rList.data));

  const rCreate = await POST('/api/reservations', {
    branch_id:     state.branchId,
    guest_name:    'Test Guest ' + Date.now(),
    guest_phone:   '0712345678',
    party_size:    3,
    reserved_date: tomorrow,
    reserved_time: '19:00',
    notes:         'Window seat',
  }, state.ownerToken);
  ok('POST /api/reservations → 201', rCreate.status === 201,
    'got ' + rCreate.status + ': ' + (rCreate.data?.error ?? ''));
  ok('Reservation has id',     !!rCreate.data?.id);
  ok('Status is confirmed',    rCreate.data?.status === 'confirmed');
  ok('Party size saved as 3',  rCreate.data?.party_size === 3);
  reservationId = rCreate.data?.id;

  // Missing required fields → 400
  const badRes = await POST('/api/reservations', {
    branch_id: state.branchId,
    party_size: 2,
  }, state.ownerToken);
  ok('Reservation missing guest_name → 400', badRes.status === 400, 'got ' + badRes.status);

  group('RESTAURANT — Reservations: update and cancel');

  if (reservationId) {
    const seat = await PATCH('/api/reservations/' + reservationId, { status: 'seated' }, state.ownerToken);
    ok('Seat reservation → 200',    seat.status === 200, 'got ' + seat.status);
    ok('Status becomes seated',     seat.data?.status === 'seated');

    const update = await PATCH('/api/reservations/' + reservationId,
      { notes: 'Highchair needed', party_size: 4 }, state.ownerToken);
    ok('Update notes/party_size → 200', update.status === 200);
    ok('party_size updated to 4',   update.data?.party_size === 4);

    const complete = await PATCH('/api/reservations/' + reservationId, { status: 'completed' }, state.ownerToken);
    ok('Complete reservation → 200', complete.status === 200);

    const cancel = await DELETE('/api/reservations/' + reservationId, state.ownerToken);
    ok('Cancel reservation → 204', cancel.status === 204, 'got ' + cancel.status);
    reservationId = null;
  }

  // Cross-tenant: fake id → 404
  const fakeRes = await PATCH('/api/reservations/00000000-0000-0000-0000-000000000001',
    { status: 'seated' }, state.ownerToken);
  ok('Fake reservation id → 404', [404, 400].includes(fakeRes.status), 'got ' + fakeRes.status);

  // ── Waitlist ──────────────────────────────────────────────────────────────
  group('RESTAURANT — Waitlist: add and seat');

  const wList = await GET('/api/reservations/waitlist?branch_id=' + (state.branchId ?? ''), state.ownerToken);
  ok('GET /api/reservations/waitlist → 200', wList.status === 200, 'got ' + wList.status);
  ok('Waitlist is array', Array.isArray(wList.data));

  const wCreate = await POST('/api/reservations/waitlist', {
    branch_id:      state.branchId,
    guest_name:     'Walk-in ' + Date.now(),
    guest_phone:    '0798765432',
    party_size:     2,
    estimated_wait: 15,
  }, state.ownerToken);
  ok('POST /api/reservations/waitlist → 201', wCreate.status === 201,
    'got ' + wCreate.status + ': ' + (wCreate.data?.error ?? ''));
  ok('Waitlist entry has id',   !!wCreate.data?.id);
  ok('Status is waiting',       wCreate.data?.status === 'waiting');
  waitlistId = wCreate.data?.id;

  const badWait = await POST('/api/reservations/waitlist', { branch_id: state.branchId }, state.ownerToken);
  ok('Waitlist missing guest_name → 400', badWait.status === 400, 'got ' + badWait.status);

  if (waitlistId) {
    const seatWait = await PATCH('/api/reservations/waitlist/' + waitlistId,
      { status: 'seated' }, state.ownerToken);
    ok('Seat waitlist entry → 200',  seatWait.status === 200, 'got ' + seatWait.status);
    ok('Status becomes seated',      seatWait.data?.status === 'seated');
    ok('seated_at is set',           !!seatWait.data?.seated_at);

    const leftWait = await PATCH('/api/reservations/waitlist/' + waitlistId,
      { status: 'left' }, state.ownerToken);
    ok('Mark waitlist left → 200', leftWait.status === 200);
    waitlistId = null;
  }

  // ── Kitchen tickets ───────────────────────────────────────────────────────
  group('RESTAURANT — Kitchen tickets: list');

  const tickets = await GET('/api/kitchen/tickets?branch_id=' + (state.branchId ?? ''));
  ok('GET /api/kitchen/tickets (no auth) → 200', tickets.status === 200, 'got ' + tickets.status);
  ok('Tickets is array', Array.isArray(tickets.data));

  // No branch_id → 400
  const nobranchTickets = await GET('/api/kitchen/tickets');
  ok('Tickets without branch_id → 400', nobranchTickets.status === 400, 'got ' + nobranchTickets.status);

  // Invalid status → 400
  const badStatus = await PATCH(
    '/api/kitchen/tickets/00000000-0000-0000-0000-000000000001/status',
    { status: 'on_fire', branch_id: state.branchId }
  );
  ok('Invalid ticket status → 400', badStatus.status === 400, 'got ' + badStatus.status);

  // Fake ticket + correct branch → 404 (branch ownership check)
  const fakeBranchTicket = await PATCH(
    '/api/kitchen/tickets/00000000-0000-0000-0000-000000000001/status',
    { status: 'preparing', branch_id: state.branchId }
  );
  ok('Fake ticket id → 404', fakeBranchTicket.status === 404, 'got ' + fakeBranchTicket.status);

  // Cross-branch isolation: ticket cannot be advanced from another branch
  const crossBranch = await PATCH(
    '/api/kitchen/tickets/00000000-0000-0000-0000-000000000002/status',
    { status: 'preparing', branch_id: '00000000-0000-0000-0000-000000000099' }
  );
  ok('Cross-branch ticket update → 404 (isolation)', crossBranch.status === 404, 'got ' + crossBranch.status);

  group('RESTAURANT — Kitchen tickets: status flow (if tickets exist)');

  const pending = (tickets.data ?? []).filter(t => t.status === 'new' || t.status === 'preparing');
  if (pending.length > 0) {
    const ticket = pending[0];
    const ticketId = ticket.id;

    const toPreparing = await PATCH('/api/kitchen/tickets/' + ticketId + '/status',
      { status: 'preparing', branch_id: state.branchId });
    ok('Ticket → preparing', toPreparing.status === 200, 'got ' + toPreparing.status);
    ok('preparing_at set',   !!toPreparing.data?.preparing_at);

    const toReady = await PATCH('/api/kitchen/tickets/' + ticketId + '/status',
      { status: 'ready', branch_id: state.branchId });
    ok('Ticket → ready', toReady.status === 200, 'got ' + toReady.status);
    ok('ready_at set',   !!toReady.data?.ready_at);

    const toCollected = await PATCH('/api/kitchen/tickets/' + ticketId + '/status',
      { status: 'collected', branch_id: state.branchId });
    ok('Ticket → collected', toCollected.status === 200, 'got ' + toCollected.status);
    ok('collected_at set',   !!toCollected.data?.collected_at);
  } else {
    okish('Kitchen status flow (new→preparing→ready→collected)',
      false, 'No pending tickets — place an order to create tickets');
  }

  // ── Order-first model ─────────────────────────────────────────────────────
  group('RESTAURANT — Order-first: send to kitchen then fire course');

  if (state.shiftId && state.branchId) {
    const openOrder = await POST('/api/orders/open', {
      branch_id:    state.branchId,
      order_number: 'REST-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      order_type:   'dine_in',
      table_number: 'T1',
      covers:       2,
      subtotal:     800,
      vat_amount:   111.03,
      total:        800,
      shift_id:     state.shiftId,
      items: [
        {
          product: null, product_name: 'Grilled Chicken', category_name: 'Mains',
          quantity: 1, unitPrice: 500, lineTotal: 500,
          course: 'main', fire_status: 'held',
          selectedVariants: [], selectedModifiers: [],
        },
        {
          product: null, product_name: 'Garlic Bread', category_name: 'Starters',
          quantity: 1, unitPrice: 300, lineTotal: 300,
          course: 'starter', fire_status: 'fired',
          selectedVariants: [], selectedModifiers: [],
        },
      ],
    }, state.ownerToken);
    ok('POST /api/orders/open → 200/201', [200, 201].includes(openOrder.status),
      'got ' + openOrder.status + ': ' + (openOrder.data?.error ?? ''));
    ok('Open order has orderId', !!openOrder.data?.orderId);
    openOrderId = openOrder.data?.orderId;

    if (openOrderId) {
      const fireCourse = await POST('/api/orders/' + openOrderId + '/fire-course',
        { course: 'main' }, state.ownerToken);
      ok('POST /fire-course → 200', fireCourse.status === 200,
        'got ' + fireCourse.status + ': ' + (fireCourse.data?.error ?? ''));

      // Unknown course → 400 or handled gracefully
      const badCourse = await POST('/api/orders/' + openOrderId + '/fire-course',
        { course: 'dessert' }, state.ownerToken);
      ok('Fire unknown course → 200/400 (not 500)', badCourse.status !== 500,
        'got ' + badCourse.status);
    }
  } else {
    okish('Order-first flow tested', false, 'Needs open shift — run orders suite first');
  }

  // ── QR ordering ───────────────────────────────────────────────────────────
  group('RESTAURANT — QR ordering: settings and public menu');

  const qrSettings = await GET('/api/qr/settings', state.ownerToken);
  ok('GET /api/qr/settings → 200', qrSettings.status === 200, 'got ' + qrSettings.status);

  const menuSlug = qrSettings.data?.menu_slug;
  okish('Business has menu_slug configured', !!menuSlug,
    'Set a menu_slug in Settings → QR Ordering to test the public menu');

  if (menuSlug) {
    // Public menu — no auth required
    const menu = await GET('/api/qr/' + menuSlug + '/menu');
    ok('GET /api/qr/:slug/menu (no auth) → 200', menu.status === 200, 'got ' + menu.status);
    ok('Menu has business object',   !!menu.data?.business?.id);
    ok('Menu has categories array',  Array.isArray(menu.data?.categories));
    ok('Menu has products array',    Array.isArray(menu.data?.products));

    // Invalid slug → 404
    const badSlug = await GET('/api/qr/slug-that-does-not-exist-xyz999/menu');
    ok('Bad menu slug → 404', badSlug.status === 404, 'got ' + badSlug.status);

    // QR order with no items → 400
    const noItems = await POST('/api/qr/' + menuSlug + '/order', {
      branch_id: state.branchId,
      items: [],
    });
    ok('QR order with empty items → 400', noItems.status === 400, 'got ' + noItems.status);

    // QR order without branch_id → 400
    const noBranch = await POST('/api/qr/' + menuSlug + '/order', {
      items: [{ product_id: '00000000-0000-0000-0000-000000000001', quantity: 1 }],
    });
    ok('QR order without branch_id → 400', noBranch.status === 400, 'got ' + noBranch.status);

    // Place a real QR order if products exist
    if ((menu.data?.products ?? []).length > 0 && state.branchId) {
      const product = menu.data.products[0];
      const qrOrder = await POST('/api/qr/' + menuSlug + '/order', {
        branch_id:  state.branchId,
        guest_name: 'Test Guest',
        items:      [{ product_id: product.id, quantity: 1 }],
        notes:      'Automated test order',
      });
      ok('POST /api/qr/:slug/order (no auth) → 200/201',
        [200, 201].includes(qrOrder.status),
        'got ' + qrOrder.status + ': ' + (qrOrder.data?.error ?? ''));
      okish('QR order has order_number', !!qrOrder.data?.order_number);
    } else {
      okish('QR order placement', false, 'No products in menu or no branchId');
    }
  }

  group('RESTAURANT — QR settings: update slug and toggle');

  const updateQr = await PATCH('/api/qr/settings', { qr_ordering: true }, state.ownerToken);
  ok('Enable QR ordering → 200', updateQr.status === 200, 'got ' + updateQr.status);

  // Slug with special chars should be sanitised
  const slugUpdate = await PATCH('/api/qr/settings',
    { menu_slug: 'My Café & Restaurant 2025!' }, state.ownerToken);
  ok('Special-char slug → 200 (sanitised)', slugUpdate.status === 200, 'got ' + slugUpdate.status);
  if (slugUpdate.data?.menu_slug) {
    ok('Slug is lowercase-alphanumeric-hyphen',
      /^[a-z0-9-]+$/.test(slugUpdate.data.menu_slug),
      'got: "' + slugUpdate.data.menu_slug + '"');
  }

  // Restore original slug if there was one
  if (menuSlug) {
    await PATCH('/api/qr/settings', { menu_slug: menuSlug }, state.ownerToken);
  }
}
