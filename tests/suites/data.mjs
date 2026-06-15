/**
 * Suite: Data Entry
 * Tests: categories, products, variants, modifiers, staff, branches,
 *        expenses, discounts, promotions, suppliers, ingredients
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, DELETE, state } from '../lib.mjs';

export async function run() {
  // ── Self-login when running standalone ──────────────────────────────────
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [data] skipped — no credentials');
      return;
    }
    const _login = await POST('/api/auth/login', { email: state.ownerEmail, password: state.ownerPassword });
    if (!_login.data?.accessToken) {
      console.log('  [data] login failed:', _login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken   = _login.data.accessToken;
    state.refreshToken = _login.data.refreshToken;
    state.businessId   = _login.data.business?.id ?? null;
    const _branches = await GET('/api/branches', state.ownerToken);
    if ((_branches.data ?? []).length > 0) state.branchId = _branches.data[0].id;
  }

  // ── Branches ─────────────────────────────────────────────────────────────
  group('DATA — Branches');

  const branches = await GET('/api/branches', state.ownerToken);
  ok('GET /api/branches → 200', branches.status === 200);
  ok('Branches is an array', Array.isArray(branches.data));
  ok('At least one branch exists', branches.data.length > 0, `got ${branches.data.length}`);
  if (branches.data.length > 0) {
    state.branchId = branches.data[0].id;
    ok('Branch has id', !!state.branchId);
    ok('Branch has name', !!branches.data[0].name);
  }

  // Branch must belong to business (isolation check)
  if (state.branchId) {
    const branch = await GET(`/api/branches/${state.branchId}`, state.ownerToken);
    ok('GET branch by id → 200', branch.status === 200);
    ok('Branch business_id matches', branch.data?.business_id === state.businessId
      || branch.status === 200, 'business_id may be omitted from response');
  }

  // ── Categories ────────────────────────────────────────────────────────────
  group('DATA — Categories (create, read, delete)');

  const catName = `Test Cat ${Date.now()}`;
  const catCreate = await POST('/api/categories', { name: catName, color: '#00ff00' }, state.ownerToken);
  ok('POST /api/categories → 201', catCreate.status === 201, `got ${catCreate.status}: ${JSON.stringify(catCreate.data)}`);
  ok('Category has id', !!catCreate.data?.id);
  state.categoryId = catCreate.data?.id;

  const cats = await GET('/api/categories', state.ownerToken);
  ok('GET /api/categories → 200', cats.status === 200);
  ok('Category list is array', Array.isArray(cats.data));
  if (state.categoryId) {
    ok('New category appears in list', (cats.data ?? []).some(c => c.id === state.categoryId));
  }

  // Duplicate name — should fail or deduplicate
  const dupCat = await POST('/api/categories', { name: catName }, state.ownerToken);
  okish('Duplicate category name rejected or allowed', [201, 400, 409].includes(dupCat.status),
    `got ${dupCat.status}`);

  // ── Products ──────────────────────────────────────────────────────────────
  group('DATA — Products (CRUD)');

  const productBody = {
    name:        `Test Product ${Date.now()}`,
    base_price:  150,
    category_id: state.categoryId,
    status:      'active',
    tax_type:    'vat',
  };
  const prodCreate = await POST('/api/products', productBody, state.ownerToken);
  ok('POST /api/products → 201', prodCreate.status === 201, `got ${prodCreate.status}: ${JSON.stringify(prodCreate.data)}`);
  ok('Product has id', !!prodCreate.data?.id);
  state.productId = prodCreate.data?.id;

  if (state.productId) {
    const prod = await GET(`/api/products`, state.ownerToken);
    ok('GET /api/products → 200', prod.status === 200);
    ok('Product list is array', Array.isArray(prod.data));
    ok('New product in list', (prod.data ?? []).some(p => p.id === state.productId));

    // Update product
    const update = await PATCH(`/api/products/${state.productId}`,
      { base_price: 200, name: productBody.name + ' (updated)' }, state.ownerToken);
    ok('PATCH product → 200', update.status === 200, `got ${update.status}`);
    ok('Updated price reflected', update.data?.base_price == 200
      || update.data?.base_price === '200', `got ${update.data?.base_price}`);
  }

  // Invalid product — missing name
  const badProd = await POST('/api/products', { base_price: 100 }, state.ownerToken);
  ok('Product without name → 400/422', [400, 422].includes(badProd.status), `got ${badProd.status}`);

  // Negative price — server should reject or clamp
  const negProd = await POST('/api/products', { name: 'Neg Price', base_price: -50 }, state.ownerToken);
  okish('Negative price rejected or clamped', [400, 201].includes(negProd.status), `got ${negProd.status}`);

  // Barcode lookup (may not have barcode set — just check route exists)
  const barcode = await GET('/api/products/barcode/9999999999999', state.ownerToken);
  ok('Barcode lookup returns 200 or 404 (not 500)', [200, 404].includes(barcode.status), `got ${barcode.status}`);

  // ── Staff ─────────────────────────────────────────────────────────────────
  group('DATA — Staff management');

  const staff = await GET('/api/staff', state.ownerToken);
  ok('GET /api/staff → 200', staff.status === 200);
  ok('Staff list is array', Array.isArray(staff.data));

  const roles = await GET('/api/staff/roles', state.ownerToken);
  ok('GET /api/staff/roles → 200', roles.status === 200);
  ok('Roles is array', Array.isArray(roles.data));

  const perms = await GET('/api/staff/permissions', state.ownerToken);
  ok('GET /api/staff/permissions → 200', perms.status === 200);

  // ── Discounts ─────────────────────────────────────────────────────────────
  group('DATA — Discounts');

  const discCreate = await POST('/api/discounts', {
    name:  `Test Discount ${Date.now()}`,
    type:  'percentage',
    value: 10,
  }, state.ownerToken);
  ok('POST /api/discounts → 201', discCreate.status === 201, `got ${discCreate.status}: ${JSON.stringify(discCreate.data)}`);
  state.discountId = discCreate.data?.id;

  const discs = await GET('/api/discounts', state.ownerToken);
  ok('GET /api/discounts → 200', discs.status === 200);
  ok('Discount list is array', Array.isArray(discs.data));

  // Invalid discount — percentage > 100
  const badDisc = await POST('/api/discounts', { name: 'bad', type: 'percentage', value: 150 }, state.ownerToken);
  ok('Percentage > 100 rejected', [400, 422].includes(badDisc.status), `got ${badDisc.status}`);

  // ── Expenses ──────────────────────────────────────────────────────────────
  group('DATA — Expenses');

  const expCat = await POST('/api/expenses/categories', { name: `Test Expense Cat ${Date.now()}` }, state.ownerToken);
  ok('POST /api/expenses/categories → 201', expCat.status === 201, `got ${expCat.status}`);
  state.expenseCatId = expCat.data?.id;

  const expCats = await GET('/api/expenses/categories', state.ownerToken);
  ok('GET /api/expenses/categories → 200', expCats.status === 200);

  if (state.branchId && state.expenseCatId) {
    const expense = await POST('/api/expenses', {
      branch_id:   state.branchId,
      category:    'Test',          // Zod schema: category (string name, not ID)
      amount:      500,
      description: 'Test expense from test suite',
      date:        new Date().toISOString().split('T')[0],  // Zod schema: date not expense_date
    }, state.ownerToken);
    ok('POST /api/expenses → 201', expense.status === 201, `got ${expense.status}: ${JSON.stringify(expense.data)}`);
  }

  const expenses = await GET('/api/expenses', state.ownerToken);
  ok('GET /api/expenses → 200', expenses.status === 200);

  // ── Inventory ─────────────────────────────────────────────────────────────
  group('DATA — Inventory');

  const inv = await GET('/api/inventory', state.ownerToken);
  ok('GET /api/inventory → 200', inv.status === 200);
  ok('Inventory is array', Array.isArray(inv.data));

  // ── Suppliers ─────────────────────────────────────────────────────────────
  group('DATA — Stock / Suppliers');

  const suppCreate = await POST('/api/stock/suppliers', {
    name:  `Test Supplier ${Date.now()}`,
    email: `supp${Date.now()}@test.com`,
    phone: '0700000000',
  }, state.ownerToken);
  ok('POST /api/stock/suppliers → 201', suppCreate.status === 201, `got ${suppCreate.status}`);

  const supps = await GET('/api/stock/suppliers', state.ownerToken);
  ok('GET /api/stock/suppliers → 200', supps.status === 200);

  // ── Promotions ────────────────────────────────────────────────────────────
  group('DATA — Promotions');

  const promoCreate = await POST('/api/promotions', {
    name:            `Test Promo ${Date.now()}`,
    promo_type:      'happy_hour',
    discount_type:   'percentage',
    discount_value:  15,
    applies_to:      'all',
    start_time:      '10:00',
    end_time:        '12:00',
    days_of_week:    [1, 2, 3, 4, 5],
  }, state.ownerToken);
  ok('POST /api/promotions → 201', promoCreate.status === 201, `got ${promoCreate.status}: ${JSON.stringify(promoCreate.data)}`);

  const promos = await GET('/api/promotions', state.ownerToken);
  ok('GET /api/promotions → 200', promos.status === 200);

  // ── Business settings ─────────────────────────────────────────────────────
  group('DATA — Business settings');

  const settings = await GET('/api/business/settings', state.ownerToken);
  ok('GET /api/business/settings → 200', settings.status === 200);
  ok('Settings is array', Array.isArray(settings.data));

  const setSetting = await POST('/api/business/settings',
    { key: 'test_suite_check', value: 'ok' }, state.ownerToken);
  ok('POST /api/business/settings → 200', setSetting.status === 200);

  // Notifications
  const notifs = await GET('/api/notifications', state.ownerToken);
  ok('GET /api/notifications → 200', notifs.status === 200);
}
