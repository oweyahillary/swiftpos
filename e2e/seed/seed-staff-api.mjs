/**
 * seed-staff-api.mjs — the test staff for the Playwright specs, through the API only (A536).
 *
 * The same people and roles as seed-users.setup.ts (manager / supervisor / cashier and a custom "Waiter" role that may
 * only take orders), but with no browser: the owner signs in on POST /api/auth/login and everything else is the
 * normal owner API. Idempotent — a role or a person that already exists is left as it is (the Waiter role's
 * permissions are re-applied). Never touches the database directly.
 *
 * Run (from the repo root or e2e/):
 *   E2E_API_URL=https://<dev api> E2E_OWNER_EMAIL=… E2E_OWNER_PASSWORD=… node e2e/seed/seed-staff-api.mjs
 *
 * Where the logins go: $GITHUB_ENV when set (the nightly workflow — the later steps see MANAGER_EMAIL, CASHIER_PIN …),
 * otherwise e2e/.env (like seed:users). The PINs are the test PINs of the dev test business, not secrets; override
 * one with E2E_<KEY>_PIN (e.g. E2E_CASHIER_PIN) if the dev business needs another.
 *
 * Refuses production (e2e/lib/prod-guard.mjs) before the first request.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProduction } from '../lib/prod-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, '..', '.env');

const API = (process.env.E2E_API_URL || process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL || process.env.OWNER_EMAIL || '';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD || process.env.OWNER_PASSWORD || '';

const USERS = [
  { key: 'MANAGER',    name: 'Test Manager',    email: 'manager@test.local',    pin: '1111', roleName: 'manager' },
  { key: 'SUPERVISOR', name: 'Test Supervisor', email: 'supervisor@test.local', pin: '2222', roleName: 'supervisor' },
  { key: 'CASHIER',    name: 'Test Cashier',    email: 'cashier@test.local',    pin: '3333', roleName: 'cashier' },
  { key: 'WAITER',     name: 'Test Waiter',     email: 'waiter@test.local',     pin: '4444', roleName: 'Waiter' },
].map((u) => ({ ...u, pin: process.env[`E2E_${u.key}_PIN`] || u.pin }));

const CUSTOM_ROLE = {
  name: 'Waiter',
  description: 'Custom test role — take orders only',
  permissionKeys: ['orders.create', 'products.view', 'customers.view'],
};

async function call(method, p, body, token) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

function must(res, what) {
  if (!res.ok) throw new Error(`${what} -> ${res.status}: ${typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data)}`);
  return res.data;
}

function persist(pairs) {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(''));
    return `$GITHUB_ENV`;
  }
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${k}=${v}\n`;
  }
  writeFileSync(ENV_FILE, text);
  return ENV_FILE;
}

async function run() {
  assertNotProduction({ E2E_API_URL: API });
  if (!OWNER_EMAIL || !OWNER_PASSWORD) throw new Error('E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD are required');

  const login = must(await call('POST', '/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PASSWORD }), 'owner sign-in');
  const token = login.accessToken;
  if (!token) throw new Error(`owner sign-in gave no accessToken (${JSON.stringify(Object.keys(login))}) — sign-in codes on for the test business?`);

  const branches = must(await call('GET', '/api/branches', null, token), 'GET /api/branches');
  if (!Array.isArray(branches) || !branches.length) throw new Error('the test business has no branch');
  const branch = branches.find((b) => /caf|corner|test|main/i.test(b.name)) ?? branches[0];

  let roles = must(await call('GET', '/api/staff/roles', null, token), 'GET /api/staff/roles');
  const perms = must(await call('GET', '/api/staff/permissions', null, token), 'GET /api/staff/permissions');
  const byName = (n) => roles.find((r) => (r.name || '').toLowerCase() === n.toLowerCase());

  let waiter = byName(CUSTOM_ROLE.name);
  if (!waiter) waiter = must(await call('POST', '/api/staff/roles', { name: CUSTOM_ROLE.name, description: CUSTOM_ROLE.description }, token), 'create Waiter role');
  const permIds = CUSTOM_ROLE.permissionKeys.map((k) => perms.find((p) => p.key === k)?.id).filter(Boolean);
  must(await call('PUT', `/api/staff/roles/${waiter.id}/permissions`, { permission_ids: permIds }, token), 'set Waiter permissions');

  if (!byName('supervisor')) {
    const sup = await call('POST', '/api/staff/roles', { name: 'supervisor', description: 'Branch supervisor (created by seed)' }, token);
    if (sup.ok) {
      const ids = perms.filter((p) => p.key !== 'settings.manage').map((p) => p.id);
      must(await call('PUT', `/api/staff/roles/${sup.data.id}/permissions`, { permission_ids: ids }, token), 'set supervisor permissions');
    }
  }
  roles = must(await call('GET', '/api/staff/roles', null, token), 'GET /api/staff/roles');

  const staff = must(await call('GET', '/api/staff', null, token), 'GET /api/staff');
  const existing = new Set((Array.isArray(staff) ? staff : []).map((s) => (s.email || '').toLowerCase()));

  const lines = [];
  let failed = 0;
  for (const u of USERS) {
    if (existing.has(u.email)) { lines.push(`=  ${u.key} already exists (${u.email})`); continue; }
    const role = byName(u.roleName);
    if (!role) { lines.push(`!  ${u.key} skipped — no role '${u.roleName}'`); failed++; continue; }
    const res = await call('POST', '/api/staff', { name: u.name, email: u.email, role_id: role.id, pin: u.pin, branch_ids: [branch.id] }, token);
    if (res.ok) lines.push(`+  ${u.key} created (${u.email})`);
    else { lines.push(`!  ${u.key} failed ${res.status} — ${JSON.stringify(res.data).slice(0, 200)}`); failed++; }
  }

  // Staff logins only — the owner's login stays in the secrets and is never written out.
  const pairs = { KDS_BRANCH_ID: branch.id };
  for (const u of USERS) { pairs[`${u.key}_EMAIL`] = u.email; pairs[`${u.key}_PIN`] = u.pin; }
  const where = persist(pairs);

  console.log(`A536 staff seed on ${API} (branch: ${branch.name})\n${lines.join('\n')}\nlogins written to ${where}`);
  if (failed) process.exitCode = 1;
}

run().catch((e) => {
  console.error(e.code === 'E2E_PROD_GUARD' ? e.message : `✗ ${e.message}`);
  process.exitCode = e.code === 'E2E_PROD_GUARD' ? 3 : 1;
});
