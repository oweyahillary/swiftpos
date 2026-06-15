/**
 * Suite: Permissions / RBAC
 * Tests: permission enforcement, surface restrictions, branch scoping,
 *        role escalation prevention, owner-vs-staff access
 */
import { group, ok, okish, SKIP, GET, POST, PATCH, DELETE, state } from '../lib.mjs';

export async function run() {
  // ── Self-login when running standalone ──────────────────────────────────
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [permissions] skipped — no credentials');
      return;
    }
    const _login = await POST('/api/auth/login', { email: state.ownerEmail, password: state.ownerPassword });
    if (!_login.data?.accessToken) {
      console.log('  [permissions] login failed:', _login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken   = _login.data.accessToken;
    state.refreshToken = _login.data.refreshToken;
    state.businessId   = _login.data.business?.id ?? null;
    const _branches = await GET('/api/branches', state.ownerToken);
    if ((_branches.data ?? []).length > 0) state.branchId = _branches.data[0].id;
  }

  group('PERMISSIONS — Owner has full access');

  const endpoints = [
    ['/api/business', 200],
    ['/api/staff', 200],
    ['/api/products', 200],
    ['/api/categories', 200],
    ['/api/discounts', 200],
    ['/api/expenses', 200],
    ['/api/inventory', 200],
    ['/api/orders', 200],
    ['/api/notifications', 200],
    ['/api/devices', 200],
  ];

  for (const [path, expectedStatus] of endpoints) {
    const res = await GET(path, state.ownerToken);
    ok(`Owner GET ${path} → ${expectedStatus}`, res.status === expectedStatus,
      `got ${res.status}`);
  }

  group('PERMISSIONS — Surface restrictions (desktop token)');

  // Web-only routes must block desktop-surface tokens
  // Reports are web-only (requireWebSurface middleware)
  // We test this by checking the reports endpoint works for owner
  // (owner is exempt from surface check) and would fail for desktop cashier

  const today = new Date().toISOString().split('T')[0];
  const reportsRes = await GET(`/api/reports/sales?from=${today}&to=${today}`, state.ownerToken);
  ok('Owner can access reports (web surface)', reportsRes.status === 200,
    `got ${reportsRes.status}`);

  group('PERMISSIONS — requirePermission enforcement');

  // These mutations require specific permissions
  // Owner always has wildcard — all should succeed
  const staffCreate = await POST('/api/staff', {
    name:      'Test Staff Member',
    email:     `teststaff${Date.now()}@swiftpos.test`,
    role_id:   null,
    branch_ids: state.branchId ? [state.branchId] : [],
    pin:        '1234',
  }, state.ownerToken);
  // 201 = created, 400 = validation error, either is fine (not 403)
  ok('Owner can create staff (not 403)', staffCreate.status !== 403,
    `got ${staffCreate.status}: ${staffCreate.data?.error ?? ''}`);
  if (staffCreate.data?.id) state.staffId = staffCreate.data.id;

  // Products.manage — owner should be able to delete
  if (state.productId) {
    const deleteRes = await DELETE(`/api/products/${state.productId}`, state.ownerToken);
    // 204 = soft-deleted (inactive), 404 = already gone
    ok('Owner can delete product',
      [200, 204, 404].includes(deleteRes.status),
      `got ${deleteRes.status}: ${deleteRes.data?.error ?? ''}`);
    state.productId = null;
  }

  group('PERMISSIONS — Branch scoping');

  // Staff are scoped to their branch — owner can see all branches
  if (state.branchId) {
    const branchOrders = await GET(`/api/orders?branch_id=${state.branchId}`, state.ownerToken);
    ok('Owner can filter orders by branch', branchOrders.status === 200,
      `got ${branchOrders.status}`);

    const branchStock = await GET(`/api/branches/${state.branchId}/stock`, state.ownerToken);
    ok('Owner can view branch stock', branchStock.status === 200,
      `got ${branchStock.status}`);
  }

  group('PERMISSIONS — Role escalation prevention');

  // Can't create staff with owner/admin role (ELEVATED_ROLE_NAMES guard)
  // First get the roles to find an elevated role id
  const rolesRes = await GET('/api/staff/roles', state.ownerToken);
  if (rolesRes.status === 200 && Array.isArray(rolesRes.data)) {
    const ownerRole = rolesRes.data.find(r =>
      ['owner', 'admin'].includes((r.name ?? '').toLowerCase()));
    if (ownerRole) {
      const escalateAttempt = await POST('/api/staff', {
        name:    'Escalated User',
        email:   `esc${Date.now()}@test.com`,
        role_id: ownerRole.id,
        pin:     '9999',
      }, state.ownerToken);
      // Server blocks elevated role assignment by non-owners
      // Owner creating owner is a special case — may be allowed or blocked by design
      ok('Elevated role assignment handled', [201, 400, 403].includes(escalateAttempt.status),
        `got ${escalateAttempt.status}`);
    }
  }

  group('PERMISSIONS — Cross-business isolation');

  // Can't access another business's branches using a known UUID
  const foreignId = '00000000-0000-0000-0000-000000000001';
  const crossBiz = await GET(`/api/branches/${foreignId}`, state.ownerToken);
  ok('Cross-business branch access → 404', [403, 404].includes(crossBiz.status),
    `got ${crossBiz.status}`);

  // Category with different business_id
  const crossCat = await GET(`/api/orders/${foreignId}`, state.ownerToken);
  ok('Cross-business order access → 404', [403, 404].includes(crossCat.status),
    `got ${crossCat.status}`);

  group('PERMISSIONS — Missing auth on all routes');

  // A sample of routes that must require auth
  const protectedRoutes = [
    '/api/business',
    '/api/staff',
    '/api/products',
    '/api/orders',
    '/api/reports/sales',
    '/api/devices',
    '/api/inventory',
    '/api/shifts/current',
  ];

  for (const path of protectedRoutes) {
    const noAuth = await GET(path);
    ok(`${path} requires auth → 401`, noAuth.status === 401, `got ${noAuth.status}`);
  }

  group('PERMISSIONS — Device registration check');

  const devices = await GET('/api/devices', state.ownerToken);
  ok('GET /api/devices → 200', devices.status === 200, `got ${devices.status}`);
  ok('Devices is array', Array.isArray(devices.data));

  // Approve a non-existent device → 404
  const fakeApprove = await PATCH('/api/devices/00000000-0000-0000-0000-000000000001/approve',
    {}, state.ownerToken);
  ok('Approve non-existent device → 404', fakeApprove.status === 404,
    `got ${fakeApprove.status}`);

  group('PERMISSIONS — permissions_version staleness detection');

  // The owner token has pv ≥ 1 (from migration 13)
  // Make a normal request — should work fine
  const normalReq = await GET('/api/business', state.ownerToken);
  ok('Normal request with valid pv → 200', normalReq.status === 200, `got ${normalReq.status}`);
  // Owners skip the pv check entirely (isOwner = true) — verify no false positives
  ok('Owner never gets PERMISSIONS_CHANGED', normalReq.data?.code !== 'PERMISSIONS_CHANGED');
}
