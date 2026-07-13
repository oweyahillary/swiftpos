import { test, expect, request as apiRequest } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One-time (idempotent) seed of test users, via the owner API.
 *
 * Run:  npm run seed:users     (uses playwright.seed.config.ts)
 *
 * Steps: owner UI login → read the owner API token → create a custom "Waiter"
 * role with a limited permission set → create manager/supervisor/cashier/waiter
 * staff with KNOWN PINs on the test branch → write their credentials into e2e/.env
 * so the auth helpers can use them. Re-running skips users that already exist.
 *
 * POS staff log in with email + PIN (4–6 digits) — there are no "passwords" for
 * them; the only password account is the owner (Supabase), which already exists.
 */

const ENV_PATH = path.resolve(process.cwd(), '.env');

// The API is a SEPARATE server from the dashboard. The browser (PLAYWRIGHT_BASE_URL,
// e.g. :5173) serves the SPA; the API is on :4000. Hitting /api/* against the SPA
// returns index.html, so API calls must target the API base explicitly.
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

const USERS = [
  { key: 'MANAGER',    name: 'Test Manager',    email: 'manager@test.local',    pin: '1111', roleName: 'manager' },
  { key: 'SUPERVISOR', name: 'Test Supervisor', email: 'supervisor@test.local', pin: '2222', roleName: 'supervisor' },
  { key: 'CASHIER',    name: 'Test Cashier',    email: 'cashier@test.local',    pin: '3333', roleName: 'cashier' },
  { key: 'WAITER',     name: 'Test Waiter',     email: 'waiter@test.local',     pin: '4444', roleName: 'Waiter' },
];

// Custom role: can take orders + see products/customers; NO voids, discounts,
// reports, or settings. Tune the keys here if you want a different rule set.
const CUSTOM_ROLE = {
  name: 'Waiter',
  description: 'Custom test role — take orders only',
  permissionKeys: ['orders.create', 'products.view', 'customers.view'],
};

function upsertEnv(file: string, kv: Record<string, string>) {
  let lines: string[] = [];
  if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [k, v] of Object.entries(kv)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(file, lines.join('\n'));
}

test('seed test users via owner API', async ({ page }) => {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  expect(ownerEmail && ownerPassword, 'Set OWNER_EMAIL/OWNER_PASSWORD in e2e/.env').toBeTruthy();

  // 1. Owner login (UI) → fresh 15-min API token in localStorage.
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(ownerEmail!);
  await page.locator('input[type="password"]').fill(ownerPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

  const token = await page.evaluate(() => {
    const direct = localStorage.getItem('swiftpos_access_token');
    if (direct) return direct;
    const alt = Object.keys(localStorage).find((k) => k.includes('access_token'));
    return alt ? localStorage.getItem(alt) : null;
  });
  expect(token, 'owner API token should be present after login').toBeTruthy();

  const api = await apiRequest.newContext({
    baseURL: API_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  // 2. Pick a branch (prefer the café/test branch, else the first).
  const branchesRes = await api.get('/api/branches');
  const ct = branchesRes.headers()['content-type'] || '';
  if (!ct.includes('application/json')) {
    throw new Error(
      `GET ${API_BASE_URL}/api/branches did not return JSON (got "${ct}"). ` +
      `The API server is probably not reachable at ${API_BASE_URL}. ` +
      `Start it, or set API_BASE_URL in e2e/.env to the correct API URL.`,
    );
  }
  expect(branchesRes.ok(), `GET /api/branches -> ${branchesRes.status()}`).toBeTruthy();
  const branches = await branchesRes.json();
  expect(Array.isArray(branches) && branches.length, 'at least one branch exists').toBeTruthy();
  const branch = branches.find((b: any) => /caf|corner|test/i.test(b.name)) ?? branches[0];

  // 3. Ensure the custom Waiter role exists with the right permissions.
  const rolesRes = await api.get('/api/staff/roles');
  let roles = await rolesRes.json();
  let waiter = roles.find((r: any) => (r.name || '').toLowerCase() === CUSTOM_ROLE.name.toLowerCase());
  if (!waiter) {
    const created = await api.post('/api/staff/roles', {
      data: { name: CUSTOM_ROLE.name, description: CUSTOM_ROLE.description },
    });
    expect(created.ok(), `create Waiter role -> ${created.status()}`).toBeTruthy();
    waiter = await created.json();
  }
  const permsRes = await api.get('/api/staff/permissions');
  const perms = await permsRes.json();
  const permIds = CUSTOM_ROLE.permissionKeys
    .map((k) => perms.find((p: any) => p.key === k)?.id)
    .filter(Boolean);
  await api.put(`/api/staff/roles/${waiter.id}/permissions`, { data: { permission_ids: permIds } });

  // 3b. Ensure a 'supervisor' role exists — some businesses aren't seeded with
  // one. Create it with manager-tier rights (everything except business settings),
  // matching how the app tiers manager/supervisor.
  let supervisor = roles.find((r: any) => (r.name || '').toLowerCase() === 'supervisor');
  if (!supervisor) {
    const created = await api.post('/api/staff/roles', {
      data: { name: 'supervisor', description: 'Branch supervisor (created by seed)' },
    });
    if (created.ok()) {
      supervisor = await created.json();
      const managerTierIds = perms
        .filter((p: any) => p.key !== 'settings.manage')
        .map((p: any) => p.id);
      await api.put(`/api/staff/roles/${supervisor.id}/permissions`, {
        data: { permission_ids: managerTierIds },
      });
    }
  }

  // Re-read roles so every role name resolves to an id.
  roles = await (await api.get('/api/staff/roles')).json();
  const roleId = (name: string) =>
    roles.find((r: any) => (r.name || '').toLowerCase() === name.toLowerCase())?.id;

  // 4. Existing staff → idempotency.
  const staff = await (await api.get('/api/staff')).json();
  const existing = new Set(
    (Array.isArray(staff) ? staff : []).map((s: any) => (s.email || '').toLowerCase()),
  );

  const results: string[] = [];
  for (const u of USERS) {
    if (existing.has(u.email.toLowerCase())) { results.push(`=  ${u.key} already exists (${u.email})`); continue; }
    const rid = roleId(u.roleName);
    if (!rid) { results.push(`!  ${u.key} SKIPPED — role '${u.roleName}' not found`); continue; }
    const res = await api.post('/api/staff', {
      data: { name: u.name, email: u.email, role_id: rid, pin: u.pin, branch_ids: [branch.id] },
    });
    results.push(res.ok()
      ? `+  ${u.key} created (${u.email} / PIN ${u.pin})`
      : `!  ${u.key} FAILED ${res.status()} — ${await res.text()}`);
  }

  // 5. Persist credentials for the test helpers.
  upsertEnv(ENV_PATH, {
    MANAGER_EMAIL: 'manager@test.local',    MANAGER_PIN: '1111',
    SUPERVISOR_EMAIL: 'supervisor@test.local', SUPERVISOR_PIN: '2222',
    CASHIER_EMAIL: 'cashier@test.local',    CASHIER_PIN: '3333',
    WAITER_EMAIL: 'waiter@test.local',      WAITER_PIN: '4444',
  });

  await api.dispose();

  // eslint-disable-next-line no-console
  console.log(
    `\n── Seed results (branch: ${branch.name}) ──\n${results.join('\n')}\n` +
    `Credentials written to ${ENV_PATH}\n`,
  );
});
