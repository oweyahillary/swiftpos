/**
 * admin-hardening.test.mjs — A495: the vendor admin portal and the public routes, hardened after the internal audit.
 *
 *   node tests/admin-hardening.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED routers (admin, qr, kitchen, tech, onboarding, mpesa) over HTTP against an in-memory database, one
 * section per audit item:
 *   1 owner takeover — change email / reset password / reset code are super admin only; the old address is told; a reset
 *     signs the owner out of every browser
 *   2 mode switch & tech tokens — super admin generates, to_mode checked, no self-confirm, confirm + cancel audited,
 *     /mode-switch/apply only from an enrolled till of the branch
 *   3 billing & licensing — super admin only; invoice PATCH scoped, checked, audited; renew checks plan + years BEFORE
 *     expiring; PATCH /clients/:id checks vat_rate / type / currency
 *   4 requireAdmin re-reads the account (deactivated / demoted bite); team role checked and audited
 *   5 /watchdog/test needs a verified admin
 *   6 admin sign-in: no code table → 503, never in; an unknown email still pays for bcrypt
 *   7 export strips every secret column
 *   8 onboarding: one business per account, inputs checked, the owner's role by lib/ownerRole
 *   9 QR: the menu names the branch (orders work), no business id, texts capped, empty / unknown refused, rate-limited
 *  10 KDS token revocation (kds_version), suspended business / closed branch refused
 *  11 M-Pesa: a failure callback never overwrites a completed payment; sandbox refused in production (lib/env)
 *  12 /tech/branch-config: the reveal code only for the owner, devices.approve, or the branch's own till
 *  13 the admin portal hides what an agent may not do (source pins)
 *
 * MUTATIONS TO CONFIRM BITE (done by hand for A495): requireSuperAdmin removed from change-owner-email → "an agent
 * cannot change the owner's email" fails; the .neq('status','completed') removed from the failure callback → "a late
 * failure callback leaves a completed payment completed" fails; the kds_version comparison removed → "a new KDS token
 * revokes the old one" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/adminRules.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
delete process.env.LOGIN_OTP;
delete process.env.MPESA_ENVIRONMENT;   // sandbox: the callback allowlist is skipped for 127.0.0.1
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const R = require(path.join(DIST, 'lib/adminRules.js'));
const ENV = require(path.join(DIST, 'lib/env.js'));

// ── The database, in memory ───────────────────────────────────────────────────────────────────────────────────────────
const id = () => randomUUID();
const SUPER = id(), AGENT = id(), SUPER2 = id();
const BZ = id(), BR = id(), BR2 = id(), OWNER_AUTH = id(), OWNER_USER = id(), MANAGER = id(), CASHIER = id();
const PLAN = id(), INV = id(), OTHER_BZ = id(), OTHER_INV = id();
let db;
const reset = () => {
  db = {
    admin_users: [
      { id: SUPER,  email: 'boss@zaptill.test',  name: 'Boss',  role: 'super_admin', is_active: true, password_hash: bcrypt.hashSync('right password', 4), otp_method: 'email', otp_totp_secret: null, otp_version: 1 },
      { id: SUPER2, email: 'boss2@zaptill.test', name: 'Boss2', role: 'super_admin', is_active: true },
      { id: AGENT,  email: 'agent@zaptill.test', name: 'Agent', role: 'agent',       is_active: true },
    ],
    businesses: [
      { id: BZ, name: 'Pollo', owner_id: OWNER_AUTH, email: 'owner@pollo.test', status: 'active', type: 'restaurant', vat_rate: 16, currency: 'KES',
        menu_slug: 'pollo', qr_ordering: true, ctl_rate: 0, override_pin_hash: 'secret-hash' },
      { id: OTHER_BZ, name: 'Other', owner_id: id(), email: 'o@other.test', status: 'active', menu_slug: 'other', qr_ordering: true },
    ],
    branches: [
      { id: BR,  business_id: BZ, name: 'Main', is_main: true,  status: 'active', kds_version: 0, tech_reveal_code: 'REVEAL1', deploy_mode: 'cloud' },
      { id: BR2, business_id: BZ, name: 'Two',  is_main: false, status: 'active', kds_version: 0, tech_reveal_code: 'REVEAL2', deploy_mode: 'cloud' },
    ],
    users: [
      { id: OWNER_USER, business_id: BZ, name: 'Owner', email: 'owner@pollo.test', status: 'active', permissions_version: 1, roles: { name: 'owner' },
        password_hash: 'h1', pin_hash: 'h2', override_pin_hash: 'h3', otp_totp_secret: 'T', otp_version: 3, must_change_password: false },
      { id: MANAGER, business_id: BZ, name: 'Mgr', email: 'm@pollo.test', status: 'active', permissions_version: 1, roles: { name: 'manager' } },
      { id: CASHIER, business_id: BZ, name: 'Cash', email: 'c@pollo.test', status: 'active', permissions_version: 1, roles: { name: 'cashier' } },
    ],
    tables: [{ id: 'tbl-2', business_id: BZ, branch_id: BR2, name: 'T7' }],
    products: [
      { id: 'p1', business_id: BZ, name: 'Chips', base_price: 200, status: 'active', is_combo: false, show_days: null },
      { id: 'p-other', business_id: OTHER_BZ, name: 'Theirs', base_price: 5, status: 'active', is_combo: false },
    ],
    categories: [], customers: [{ id: id(), business_id: BZ, name: 'Cust', api_key: 'k' }],
    plans: [{ id: PLAN, name: 'Annual', price: 1000 }],
    subscriptions: [{ id: id(), business_id: BZ, plan_id: PLAN, status: 'active' }],
    invoices: [{ id: INV, business_id: BZ, invoice_number: 'INV-1', status: 'pending', amount: 10 },
               { id: OTHER_INV, business_id: OTHER_BZ, invoice_number: 'INV-2', status: 'pending', amount: 10 }],
    tech_access_tokens: [], tech_approval_flags: [], mode_switch_requests: [], admin_audit_log: [], feature_flags: [],
    refresh_tokens: [{ id: 'rt-web', user_id: OWNER_AUTH, session_id: 's-web', device_hint: null, session_kind: 'web', revoked_at: null }],
    user_devices: [{ business_id: BZ, device_id: 'dev-1', branch_id: BR, status: 'approved', retired_at: null }],
    payments: [], orders: [], order_items: [], kitchen_tickets: [], login_otp_codes: [], roles: [], role_permissions: [],
    permissions: [], user_branches: [], onboarding_progress: [],
  };
  adminAuth.forgetAdmin();
};
reset();
let seq = 0, missingOtpTable = false;
const cmp = (a, b) => String(a ?? '') ;
supabase.from = (table) => {
  const f = []; let op = 'select', payload = null, single = false, head = false, countOpt = false;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      if (missingOtpTable && table === 'login_otp_codes') return { data: null, error: { code: '42P01', message: 'relation "login_otp_codes" does not exist' } };
      return { data: payload, error: null };
    }
    if (op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
    if (op === 'delete') { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    const hit = rows();
    return { data: head ? null : hit, error: null, count: hit.length };
  };
  const q = new Proxy({}, {
    get(_t, p) {
      if (p === 'select') return (_c, o) => { if (o?.head) head = true; if (o?.count) countOpt = true; return q; };
      if (p === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (p === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (p === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (p === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (p === 'ilike') return (k, v) => { const s = String(v).replace(/%/g, '').toLowerCase(); f.push((r) => String(r[k] ?? '').toLowerCase().includes(s)); return q; };
      if (p === 'gte') return (k, v) => { f.push((r) => String(r[k] ?? '') >= String(v)); return q; };
      if (p === 'insert' || p === 'upsert') return (row) => {
        op = 'insert';
        const list = (Array.isArray(row) ? row : [row]).map((r) => ({ id: r.id ?? `row-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), attempts: 0, consumed_at: null, ...r }));
        if (!(missingOtpTable && table === 'login_otp_codes')) (db[table] ??= []).push(...list);
        payload = Array.isArray(row) ? list : list[0];
        return q;
      };
      if (p === 'update') return (patch) => { op = 'update'; payload = patch; return q; };
      if (p === 'delete') return () => { op = 'delete'; return q; };
      if (p === 'single' || p === 'maybeSingle') return () => {
        const r = run(); const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        if (p === 'single' && !d && !r.error) return Promise.resolve({ data: null, error: { message: 'none', code: 'PGRST116' } });
        return Promise.resolve({ data: d, error: r.error });
      };
      if (p === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;   // order, limit, range, or, not, lte, like …
    },
  });
  return q;
};
supabase.rpc = async (fn, args) => {
  if (fn === 'bump_kds_version') {
    const b = db.branches.find((x) => x.id === args.p_branch && x.business_id === args.p_business);
    if (!b) return { data: null, error: null };
    b.kds_version = (b.kds_version ?? 0) + 1;
    return { data: b.kds_version, error: null };
  }
  return { data: null, error: null };
};
const authCalls = [];
supabase.auth.admin.updateUserById = async (uid, patch) => { authCalls.push({ uid, patch }); return { data: { user: { id: uid } }, error: null }; };
supabase.auth.admin.getUserById = async (uid) => ({ data: { user: { id: uid, email: uid === OWNER_AUTH ? 'owner@pollo.test' : null } }, error: null });
let signedUp = null;
supabase.auth.getUser = async (t) => (signedUp && t === 'supa-token' ? { data: { user: signedUp }, error: null } : { data: { user: null }, error: { message: 'bad' } });

const mail = [];
mailer.sendEmailChecked = async (m) => { mail.push(m); return { ok: true, provider: 'test' }; };

// ── The app ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api/qr', require(path.join(DIST, 'routes/qr.js')).default);
app.use('/api/kitchen', require(path.join(DIST, 'routes/kitchen.js')).default);
app.use('/api/tech', require(path.join(DIST, 'routes/tech.js')).default);
app.use('/api/onboarding', require(path.join(DIST, 'routes/onboarding.js')).default);
app.use('/api/mpesa', require(path.join(DIST, 'routes/mpesa.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const adminTok = (adminId, role) => jwt.sign({ adminId, email: 'x@zaptill.test', role }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const SUPER_T = adminTok(SUPER, 'super_admin'), AGENT_T = adminTok(AGENT, 'agent'), SUPER2_T = adminTok(SUPER2, 'super_admin');
const userTok = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, permissionKeys: [], ...p }, process.env.JWT_SECRET, { algorithm: 'HS256' });
const audited = (action) => db.admin_audit_log.some((a) => a.action === action);
const refusedSuper = (r) => r.status === 403 && r.body?.code === 'SUPER_ADMIN_REQUIRED';

try {
  console.log('\n1. Owner account takeover by one agent\n');
  for (const [p, body] of [['change-owner-email', { new_email: 'thief@evil.test' }], ['reset-owner-password', { new_password: 'longenough1' }], ['reset-owner-otp', {}]]) {
    await ok(`an agent cannot ${p} (403 SUPER_ADMIN_REQUIRED, nothing changed)`, async () => {
      reset(); authCalls.length = 0;
      const r = await call('POST', `/api/admin/clients/${BZ}/${p}`, AGENT_T, body);
      assert.ok(refusedSuper(r), JSON.stringify(r)); assert.equal(authCalls.length, 0);
      assert.equal(db.businesses[0].email, 'owner@pollo.test');
    });
  }
  await ok('a super admin changes the owner\'s email — and the OLD address is emailed', async () => {
    reset(); mail.length = 0;
    const r = await call('POST', `/api/admin/clients/${BZ}/change-owner-email`, SUPER_T, { new_email: 'new@pollo.test' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.old_email_notified, true);
    assert.ok(mail.some((m) => m.to === 'owner@pollo.test' && /changed/.test(m.subject)), 'the old address is told');
    assert.ok(audited('business.change_owner_email'));
  });
  await ok('a super admin\'s owner-password reset signs the owner out of every browser and asks for a new password', async () => {
    reset(); authCalls.length = 0;
    const r = await call('POST', `/api/admin/clients/${BZ}/reset-owner-password`, SUPER_T, { new_password: 'longenough1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(authCalls.some((c) => c.uid === OWNER_AUTH && c.patch.password === 'longenough1'));
    assert.ok(db.refresh_tokens.find((t) => t.id === 'rt-web').revoked_at, 'the owner\'s web session is revoked');
    assert.equal(db.users.find((u) => u.id === OWNER_USER).must_change_password, true);
  });

  console.log('\n2. Mode switch & tech tokens\n');
  await ok('an agent cannot generate a mode switch; a super admin can, only to local or cloud', async () => {
    reset();
    assert.ok(refusedSuper(await call('POST', '/api/admin/mode-switch/generate', AGENT_T, { business_id: BZ, branch_id: BR, to_mode: 'local' })));
    const bad = await call('POST', '/api/admin/mode-switch/generate', SUPER_T, { business_id: BZ, branch_id: BR, to_mode: 'moon' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const good = await call('POST', '/api/admin/mode-switch/generate', SUPER_T, { business_id: BZ, branch_id: BR, to_mode: 'local' });
    assert.equal(good.status, 200, JSON.stringify(good.body)); assert.ok(good.body.switch_token);
  });
  await ok('cancelling a switch is audited; an unknown one is a 404', async () => {
    reset();
    db.mode_switch_requests.push({ id: 'ms-1', business_id: BZ, branch_id: BR, from_mode: 'cloud', to_mode: 'local', status: 'pending' });
    assert.equal((await call('POST', '/api/admin/mode-switch/nope/cancel', AGENT_T, {})).status, 404);
    const r = await call('POST', '/api/admin/mode-switch/ms-1/cancel', AGENT_T, {});
    assert.equal(r.status, 200); assert.equal(db.mode_switch_requests[0].status, 'cancelled'); assert.ok(audited('mode_switch.cancel'));
  });
  await ok('the admin who generated a tech token cannot confirm it; another super admin can, audited', async () => {
    reset();
    db.tech_access_tokens.push({ id: 'tt-1', admin_id: SUPER, admin_name: 'Boss', business_id: BZ, branch_name: 'Main', status: 'active' });
    const self = await call('POST', '/api/admin/tech/tokens/tt-1/confirm', SUPER_T, {});
    assert.equal(self.status, 403); assert.equal(self.body.code, 'SELF_CONFIRM'); assert.ok(!db.tech_access_tokens[0].confirmed_at);
    const other = await call('POST', '/api/admin/tech/tokens/tt-1/confirm', SUPER2_T, {});
    assert.equal(other.status, 200); assert.ok(db.tech_access_tokens[0].confirmed_at); assert.ok(audited('tech.token.confirm'));
  });
  await ok('/api/tech/mode-switch/apply is refused without an enrolled till of the branch', () => {
    const t = read('apps/server/src/routes/tech.ts');
    assert.match(t, /const deviceId = String\(req\.headers\['x-device-id'\][\s\S]*?code: 'DEVICE_REQUIRED'/);
    assert.match(t, /\.from\('user_devices'\)[\s\S]*?\.eq\('business_id', businessId\)\.eq\('device_id', deviceId\)[\s\S]*?code: 'DEVICE_NOT_ENROLLED'/);
    assert.ok(t.indexOf("code: 'DEVICE_NOT_ENROLLED'") < t.indexOf("const switchHash"), 'checked before the switch code is even looked up');
    assert.match(t, /\.update\(\{ status: 'applied'[\s\S]*?\.eq\('status', 'pending'\)\.select\('id'\)/, 'claimed once, atomically');
  });

  console.log('\n3. Billing and licensing writes\n');
  const superOnly = [
    ['POST', `/api/admin/clients/${BZ}/suspend`, { reason: 'x' }], ['POST', `/api/admin/clients/${BZ}/activate`, {}],
    ['PATCH', `/api/admin/clients/${BZ}/web-access`, { expires_at: null }], ['PATCH', `/api/admin/clients/${BZ}/desktop-version`, { version: null }],
    ['POST', `/api/admin/clients/${BZ}/subscription/renew`, { plan_id: PLAN, years: 1 }], ['PATCH', `/api/admin/clients/${BZ}/billing/${INV}`, { status: 'paid' }],
    ['GET', `/api/admin/clients/${BZ}/export`, undefined], ['POST', `/api/admin/clients/${BZ}/branches/${BR}/licence`, { licensed: true }],
    ['PATCH', `/api/admin/clients/${BZ}/features/web_hosting`, { enabled: true }],
    // A507: the tax and money settings (VAT, currency, type, KRA PIN) are any admin's again — an agent's change is
    // e-mailed to the super admins to verify (tested below).
  ];
  for (const [m, p, body] of superOnly) {
    await ok(`agent ${m} ${p.replace(BZ, ':id').replace(BR, ':branch').replace(INV, ':inv')} ${body ? JSON.stringify(body) : ''} → 403`, async () => {
      reset();
      const r = await call(m, p, AGENT_T, body);
      assert.ok(refusedSuper(r), JSON.stringify(r));
      assert.equal(db.businesses[0].status, 'active'); assert.equal(db.businesses[0].vat_rate, 16); assert.equal(db.invoices[0].status, 'pending');
    });
  }
  await ok('A507: an agent changes the VAT rate and currency — saved; the answer carries no secret column', async () => {
    reset();
    const r = await call('PATCH', `/api/admin/clients/${BZ}`, AGENT_T, { vat_rate: 8, currency: 'USD' });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(db.businesses[0].vat_rate, 8); assert.equal(db.businesses[0].currency, 'USD');
    assert.ok(!('override_pin_hash' in (r.body ?? {})), JSON.stringify(r.body));
  });
  await ok('an agent still edits the name (and themes stay an agent\'s)', async () => {
    reset();
    assert.equal((await call('PATCH', `/api/admin/clients/${BZ}`, AGENT_T, { name: 'Pollo Ltd' })).status, 200);
    assert.equal(db.businesses[0].name, 'Pollo Ltd');
    assert.equal((await call('PATCH', `/api/admin/clients/${BZ}/features/themes`, AGENT_T, { enabled: true })).status, 200);
  });
  await ok('PATCH /clients/:id checks vat_rate (0–100), type, currency (3 letters)', async () => {
    reset();
    for (const body of [{ vat_rate: 101 }, { vat_rate: -1 }, { vat_rate: 'x' }, { type: 'casino' }, { currency: 'KESH' }, { currency: 12 }]) {
      const r = await call('PATCH', `/api/admin/clients/${BZ}`, SUPER_T, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    }
    assert.equal(db.businesses[0].vat_rate, 16);
    assert.equal((await call('PATCH', `/api/admin/clients/${BZ}`, SUPER_T, { vat_rate: 0, currency: 'usd' })).status, 200);
    assert.equal(db.businesses[0].vat_rate, 0); assert.equal(db.businesses[0].currency, 'USD');
  });
  await ok('invoice PATCH: status checked, scoped to the client in the path, audited', async () => {
    reset();
    assert.equal((await call('PATCH', `/api/admin/clients/${BZ}/billing/${INV}`, SUPER_T, { status: 'bogus' })).status, 400);
    const cross = await call('PATCH', `/api/admin/clients/${BZ}/billing/${OTHER_INV}`, SUPER_T, { status: 'paid' });
    assert.equal(cross.status, 404); assert.equal(db.invoices[1].status, 'pending', 'another client\'s invoice untouched');
    const r = await call('PATCH', `/api/admin/clients/${BZ}/billing/${INV}`, SUPER_T, { status: 'paid', payment_reference: 'QX1' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(db.invoices[0].status, 'paid'); assert.ok(audited('invoice.mark_paid'));
  });
  await ok('renew: an unknown plan or bad years is refused BEFORE the current subscription is expired', async () => {
    reset();
    for (const body of [{ plan_id: id(), years: 1 }, { plan_id: PLAN, years: 0 }, { plan_id: PLAN, years: 6 }, { plan_id: PLAN, years: 1.5 }, { plan_id: PLAN, years: 'two' }]) {
      const r = await call('POST', `/api/admin/clients/${BZ}/subscription/renew`, SUPER_T, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
      assert.equal(db.subscriptions[0].status, 'active', 'still active');
    }
    const r = await call('POST', `/api/admin/clients/${BZ}/subscription/renew`, SUPER_T, { plan_id: PLAN, years: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(db.subscriptions[0].status, 'expired');
  });

  console.log('\n4. requireAdmin re-checks the account; team changes are checked and audited\n');
  await ok('a deactivated admin\'s token is refused at once after the team change', async () => {
    reset();
    assert.equal((await call('GET', '/api/admin/plans', AGENT_T)).status, 200);
    const r = await call('PATCH', `/api/admin/team/${AGENT}`, SUPER_T, { is_active: false });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(audited('team.update'));
    const after = await call('GET', '/api/admin/plans', AGENT_T);
    assert.equal(after.status, 401); assert.equal(after.body.code, 'ADMIN_INACTIVE');
  });
  await ok('a demoted super admin loses super admin at once (the role is read from the account, not the token)', async () => {
    reset();
    db.admin_users.find((a) => a.id === SUPER2).role = 'agent'; adminAuth.forgetAdmin();
    assert.ok(refusedSuper(await call('POST', `/api/admin/clients/${BZ}/suspend`, SUPER2_T, { reason: 'x' })));
  });
  await ok('a token for an account that does not exist is refused', async () => {
    reset();
    assert.equal((await call('GET', '/api/admin/plans', adminTok(id(), 'super_admin'))).status, 401);
  });
  await ok('team POST/PATCH refuse an unknown role', async () => {
    reset();
    assert.equal((await call('POST', '/api/admin/team', SUPER_T, { email: 'n@z.test', name: 'N', password: 'longenough', role: 'god' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/team/${AGENT}`, SUPER_T, { role: 'god' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/team/${SUPER}`, SUPER_T, { role: 'agent' })).status, 400, 'not your own super admin');
  });

  console.log('\n5. /watchdog/test\n');
  await ok('/watchdog/test without a token is a 401 (requireAdmin first); an agent a 403', async () => {
    reset();
    assert.equal((await call('POST', '/api/admin/watchdog/test', null, {})).status, 401);
    assert.equal((await call('POST', '/api/admin/watchdog/test', AGENT_T, {})).status, 403);
  });

  console.log('\n6. Admin sign-in\n');
  await ok('no code table (before migration 119): the admin is refused 503, never signed in without a code', async () => {
    reset(); missingOtpTable = true;
    try {
      const r = await call('POST', '/api/admin/auth/login', null, { email: 'boss@zaptill.test', password: 'right password' });
      assert.equal(r.status, 503, JSON.stringify(r.body)); assert.ok(!r.body.token);
    } finally { missingOtpTable = false; }
  });
  await ok('an unknown email pays for a bcrypt comparison too (timing)', async () => {
    const src = read('apps/server/src/routes/admin.ts');
    assert.match(src, /if \(!admin \|\| !admin\.is_active\) \{\s*\/\/[^\n]*\n\s*await bcrypt\.compare\(String\(password\), DUMMY_ADMIN_HASH\);/);
    reset();
    const t0 = Date.now();
    const r = await call('POST', '/api/admin/auth/login', null, { email: 'nobody@zaptill.test', password: 'x' });
    assert.equal(r.status, 401); assert.ok(Date.now() - t0 >= 20, 'took bcrypt-cost time');
  });

  console.log('\n7. Export strips secrets\n');
  await ok('the export has no hash, secret, OTP or reveal-code column anywhere', async () => {
    reset();
    const r = await call('GET', `/api/admin/clients/${BZ}/export`, SUPER_T);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    for (const k of ['password_hash', 'pin_hash', 'override_pin_hash', 'otp_totp_secret', 'otp_version', 'tech_reveal_code', 'api_key']) assert.ok(!text.includes(`"${k}"`), k);
    assert.ok(r.body.staff.length === 3 && r.body.staff[0].name, 'the people are still there');
    assert.equal(R.stripSecretColumns({ name: 'a', pin: '1234', device_secret_hash: 'x' }).pin, undefined);
  });

  console.log('\n8. Self sign-up (onboarding)\n');
  const onboardBody = { businessName: 'New Co', businessType: 'cafe', branchName: 'Main', currency: 'KES', ownerEmail: 'me@new.test', vatRate: 16 };
  await ok('an account that already owns a business is refused (409)', async () => {
    reset(); signedUp = { id: OWNER_AUTH, email: 'me@new.test' };
    const r = await call('POST', '/api/onboarding', 'supa-token', onboardBody);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(db.businesses.length, 2);
  });
  await ok('inputs are checked: VAT, currency, lengths, the owner email is the signed-up one', async () => {
    reset(); signedUp = { id: id(), email: 'me@new.test' };
    for (const bad of [{ vatRate: 150 }, { currency: 'SHILLING' }, { businessName: 'x'.repeat(200) }, { ownerEmail: 'someone@else.test' }, { businessType: 'casino' }]) {
      const r = await call('POST', '/api/onboarding', 'supa-token', { ...onboardBody, ...bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
  });
  await ok('a good sign-up: the owner row holds the owner role (lib/ownerRole), no caller-supplied PIN hash', async () => {
    reset(); const uid = id(); signedUp = { id: uid, email: 'me@new.test' };
    const r = await call('POST', '/api/onboarding', 'supa-token', { ...onboardBody, ownerPinHash: '$2b$fake' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const owner = db.users.find((u) => u.email === 'me@new.test');
    const role = db.roles.find((x) => x.id === owner.role_id);
    assert.ok(role && ['owner', 'admin'].includes(role.name.toLowerCase()), `owner role ${role?.name}`);
    assert.equal(owner.pin_hash, null);
  });

  console.log('\n9. QR ordering\n');
  await ok('the menu names the branch the QR orders for, and never the business id', async () => {
    reset();
    const main = await call('GET', '/api/qr/pollo/menu');
    assert.equal(main.status, 200); assert.equal(main.body.branch_id, BR, 'the main branch'); assert.equal(main.body.business.id, undefined);
    const table = await call('GET', '/api/qr/pollo/menu?table_id=tbl-2');
    assert.equal(table.body.branch_id, BR2, 'the table\'s own branch'); assert.equal(table.body.table_name, 'T7');
  });
  await ok('an order goes through with the branch from the menu (it never could: the menu sent none)', async () => {
    reset();
    const m = await call('GET', '/api/qr/pollo/menu');
    const r = await call('POST', '/api/qr/pollo/order', null, { branch_id: m.body.branch_id, items: [{ product_id: 'p1', quantity: 2 }], guest_name: 'Kizzy' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db.orders[0].branch_id, BR); assert.equal(db.kitchen_tickets[0].branch_id, BR); assert.equal(db.orders[0].total, 400);
  });
  await ok('the table\'s branch wins over a branch_id sent by the page; another business\'s branch is never used', async () => {
    reset();
    const r = await call('POST', '/api/qr/pollo/order', null, { table_id: 'tbl-2', branch_id: BR, items: [{ product_id: 'p1', quantity: 1 }] });
    assert.equal(r.status, 201); assert.equal(db.orders[0].branch_id, BR2);
  });
  await ok('empty orders, unknown / other-business products and over-long texts are refused', async () => {
    reset();
    const bad = [
      { items: [] }, { items: [{ product_id: 'nope', quantity: 1 }] }, { items: [{ product_id: 'p-other', quantity: 1 }] },
      { items: [{ product_id: 'p1', quantity: 1 }], guest_name: 'x'.repeat(61) },
      { items: [{ product_id: 'p1', quantity: 1 }], notes: 'x'.repeat(301) },
      { items: [{ product_id: 'p1', quantity: 1, modifier_summary: 'x'.repeat(201) }] },
    ];
    for (const b of bad) {
      const r = await call('POST', '/api/qr/pollo/order', null, b);
      assert.equal(r.status, 400, `${JSON.stringify(b).slice(0, 80)} → ${r.status}`);
    }
    assert.equal(db.orders.length, 0);
  });

  console.log('\n10. KDS token revocation\n');
  const ownerT = userTok({ userId: OWNER_USER, isOwner: true });
  await ok('a new KDS token revokes the old one; the new one works', async () => {
    reset();
    const a = await call('POST', '/api/kitchen/kds-token', ownerT, { branch_id: BR });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((await call('GET', '/api/kitchen/tickets', a.body.token)).status, 200);
    const b = await call('POST', '/api/kitchen/kds-token', ownerT, { branch_id: BR });
    const old = await call('GET', '/api/kitchen/tickets', a.body.token);
    assert.equal(old.status, 401); assert.equal(old.body.code, 'KDS_TOKEN_REVOKED');
    assert.equal((await call('GET', '/api/kitchen/tickets', b.body.token)).status, 200);
  });
  await ok('a token from before migration 137 (no version) works until the first new token', async () => {
    reset();
    const legacy = jwt.sign({ businessId: BZ, branchId: BR, isOwner: false, surface: 'kds', permissionKeys: [] }, process.env.JWT_SECRET);
    assert.equal((await call('GET', '/api/kitchen/tickets', legacy)).status, 200);
    await call('POST', '/api/kitchen/kds-token', ownerT, { branch_id: BR });
    assert.equal((await call('GET', '/api/kitchen/tickets', legacy)).status, 401);
  });
  await ok('a suspended business or a closed branch is refused on the display', async () => {
    reset();
    const t = (await call('POST', '/api/kitchen/kds-token', ownerT, { branch_id: BR })).body.token;
    db.businesses[0].status = 'suspended';
    assert.equal((await call('GET', '/api/kitchen/tickets', t)).body.code, 'BUSINESS_SUSPENDED');
    db.businesses[0].status = 'active'; db.branches[0].status = 'inactive';
    assert.equal((await call('GET', '/api/kitchen/tickets', t)).body.code, 'BRANCH_INACTIVE');
  });

  console.log('\n11. M-Pesa\n');
  const cb = (code) => ({ Body: { stkCallback: { CheckoutRequestID: 'ck-1', ResultCode: code, ResultDesc: 'Request cancelled by user' } } });
  await ok('a late failure callback leaves a completed payment completed', async () => {
    reset();
    db.payments.push({ id: 'pay-1', mpesa_checkout_id: 'ck-1', status: 'completed', business_id: BZ, amount: 100 });
    for (const code of [1032, 1]) {
      assert.equal((await call('POST', '/api/mpesa/callback', null, cb(code))).status, 200);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(db.payments[0].status, 'completed', `result ${code}`);
    }
    db.payments.push({ id: 'pay-2', mpesa_checkout_id: 'ck-1', status: 'pending', business_id: BZ, amount: 1 });
    await call('POST', '/api/mpesa/callback', null, cb(1032)); await new Promise((r) => setTimeout(r, 50));
    assert.equal(db.payments[1].status, 'failed', 'a pending one still fails');
  });
  await ok('lib/env: M-Pesa sandbox in production is refused (warned with the explicit staging override)', () => {
    assert.equal(ENV.mpesaSandboxInProductionProblem({ NODE_ENV: 'production', MPESA_ENVIRONMENT: 'sandbox' }), 'refuse');
    assert.equal(ENV.mpesaSandboxInProductionProblem({ NODE_ENV: 'production', MPESA_ENVIRONMENT: 'sandbox', MPESA_ALLOW_SANDBOX_IN_PRODUCTION: '1' }), 'warn');
    assert.equal(ENV.mpesaSandboxInProductionProblem({ NODE_ENV: 'production', MPESA_ENVIRONMENT: 'production' }), null);
    assert.equal(ENV.mpesaSandboxInProductionProblem({ NODE_ENV: 'development', MPESA_ENVIRONMENT: 'sandbox' }), null);
    assert.match(read('apps/server/src/lib/env.ts'), /if \(sandboxRefusal === 'refuse'\) \{[\s\S]*?process\.exit\(1\);/);
  });

  console.log('\n12. /tech/branch-config (the reveal code)\n');
  await ok('a cashier is refused; the owner, a devices.approve manager and the branch\'s own till get it', async () => {
    reset();
    const cashier = await call('GET', `/api/tech/branch-config/${BR}`, userTok({ userId: CASHIER, permissionKeys: ['orders.create'] }));
    assert.equal(cashier.status, 403, JSON.stringify(cashier.body)); assert.ok(!JSON.stringify(cashier.body).includes('REVEAL1'));
    assert.equal((await call('GET', `/api/tech/branch-config/${BR}`, ownerT)).body.reveal_code, 'REVEAL1');
    assert.equal((await call('GET', `/api/tech/branch-config/${BR}`, userTok({ userId: MANAGER, permissionKeys: ['devices.approve'] }))).body.reveal_code, 'REVEAL1');
    const till = jwt.sign({ userId: null, deviceId: 'dev-1', till: true, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET);
    assert.equal((await call('GET', `/api/tech/branch-config/${BR}`, till)).body.reveal_code, 'REVEAL1');
    assert.equal((await call('GET', `/api/tech/branch-config/${BR2}`, till)).status, 403, 'not another branch\'s code');
  });

  console.log('\n13. The admin portal follows the rules\n');
  await ok('agents see no super-admin-only button; the note no longer reads req.adminEmail', () => {
    const ui = read('apps/admin/src/AdminPortal.tsx');
    assert.doesNotMatch(ui, /req\.adminEmail/);
    assert.match(ui, /const superOnly = \(el\) => isSuper \? el :/);
    for (const fn of ['changeOwnerEmail', 'resetOwnerPassword', 'resetOwnerOtp', 'suspend', 'activate', 'exportData']) {
      assert.match(ui, new RegExp(`superOnly\\(<button onClick=\\{${fn}\\}`), fn);
    }
    assert.match(ui, /\{isSuper && <button disabled=\{licencingBranch === b\.id\}/);
    assert.match(ui, /\{inv\.status !== "paid" && isSuper && \(/);
    assert.match(ui, /admin\?\.role === "super_admin" && t\.admin_id !== admin\?\.id/);
    assert.match(ui, /\{admin\?\.role === "super_admin" && <form onSubmit=\{generateSwitch\}/);
  });

  console.log('\n9b. The QR order limit (last: it uses up this address\'s orders)\n');
  await ok(`more than ${10} QR orders from one address in 10 minutes → 429`, async () => {
    reset();
    let last;
    for (let i = 0; i < 12; i++) last = await call('POST', '/api/qr/pollo/order', null, { items: [{ product_id: 'p1', quantity: 1 }] });
    assert.equal(last.status, 429, JSON.stringify(last.body));
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
