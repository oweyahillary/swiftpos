/**
 * owner-users-row.test.mjs — A451: the owner always signs in as a users row of their business.
 *
 * Owner, 2026-10-13: "A451 is important and needed". An owner with no public.users row signed in with the auth.users id;
 * every write naming the person (the void of order 8a523b99…, a refund, a sale's cashier) was refused by the database.
 *
 * RUNS the built apps/server/dist/routes/auth.js ensureOwnerUserRow against an in-memory database, and pins its use at
 * sign-in and at a session's renewal.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/owner-users-row.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: the owner_id step removed → "the row the business names" fails; the create step removed →
 * "a row is created" fails; login back on resolveOwnerUserRow → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
if (!fs.existsSync(path.join(DIST, 'routes/auth.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', MAIN = '22222222-2222-4222-8222-222222222222';
const OWNER_ROW = '44444444-4444-4444-8444-444444444444', AUTH_ID = '99999999-9999-4999-8999-999999999999';
const R_OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', R_CASH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let db, seq = 0;
const reset = (over = {}) => {
  db = { businesses: [{ id: BZ, owner_id: AUTH_ID }], users: [], roles: [{ id: R_OWNER, business_id: BZ, name: 'owner' }, { id: R_CASH, business_id: BZ, name: 'cashier' }],
    branches: [{ id: MAIN, business_id: BZ, is_main: true }], user_branches: [], ...over };
};
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      const p = { id: payload.id ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, ...payload };
      if (table === 'users' && db.users.some((u) => u.business_id === p.business_id && u.email === p.email)) return { data: null, error: { code: '23505', message: 'duplicate' } };
      db[table].push(p); return { data: [p], error: null };
    }
    return { data: rows(), error: null };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'insert') return (row) => { op = 'insert'; payload = row; return q; };
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'ilike') return (k, v) => { f.push((r) => String(r[k] ?? '').toLowerCase() === String(v).replace(/\\([\\%_])/g, '$1').toLowerCase()); return q; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); };
      if (prop === 'single') return () => { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};
const { ensureOwnerUserRow } = require(path.join(DIST, 'routes/auth.js'));

console.log('\nThe owner signs in as a users row of their business\n');
await ok('their row by email, as before (any case)', async () => {
  reset({ users: [{ id: OWNER_ROW, business_id: BZ, email: 'Owner@Pizza.co.ke', status: 'active', must_change_password: false }] });
  const r = await ensureOwnerUserRow(BZ, 'owner@pizza.co.ke');
  assert(r?.id === OWNER_ROW && !r.created && db.users.length === 1, JSON.stringify(r));
});
await ok('no row by that email: the row the business names as its owner', async () => {
  reset({ businesses: [{ id: BZ, owner_id: OWNER_ROW }], users: [{ id: OWNER_ROW, business_id: BZ, email: 'old@pizza.co.ke', status: 'active' }] });
  const r = await ensureOwnerUserRow(BZ, 'new@pizza.co.ke');
  assert(r?.id === OWNER_ROW && db.users.length === 1, JSON.stringify(r));
});
await ok('none at all: a row is created — the owner role, active, on the main branch', async () => {
  reset();
  const r = await ensureOwnerUserRow(BZ, 'owner@pizza.co.ke');
  const u = db.users.find((x) => x.id === r?.id);
  assert(r?.created === true && u?.role_id === R_OWNER && u.status === 'active' && u.email === 'owner@pizza.co.ke' && u.name === 'owner'
    && db.user_branches.some((b) => b.user_id === u.id && b.branch_id === MAIN), JSON.stringify({ r, u, ub: db.user_branches }));
  const again = await ensureOwnerUserRow(BZ, 'OWNER@pizza.co.ke');
  assert(again?.id === r.id && db.users.length === 1, 'signing in again finds it — never a second row');
});
await ok('an older business with an "Admin" role (onboarding) gets that role', async () => {
  reset({ roles: [{ id: R_OWNER, business_id: BZ, name: 'Admin' }] });
  const r = await ensureOwnerUserRow(BZ, 'boss@pizza.co.ke');
  assert(db.users.find((x) => x.id === r?.id)?.role_id === R_OWNER, JSON.stringify(db.users));
});
await ok('no email to go by and nothing found: none (the logged fallback stays)', async () => {
  reset();
  assert(await ensureOwnerUserRow(BZ, '') === null && db.users.length === 0, 'no row made from nothing');
});

console.log('\nWhere it is used\n');
await ok('at sign-in, and at a session\'s renewal (an owner session from before is mended)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
  assert(/const ownerUser = await ensureOwnerUserRow\(business\.id, data\.user\.email\);/.test(src), 'login');
  assert(/if \(cleanPayload\.isOwner && cleanPayload\.userId && cleanPayload\.businessId\) \{[\s\S]{0,700}ensureOwnerUserRow\(cleanPayload\.businessId,[\s\S]{0,300}cleanPayload\.userId = row\.id;/.test(src), 'refresh');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
