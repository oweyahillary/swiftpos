/**
 * migration-73-74.test.mjs — run the migrations against a REAL Postgres.
 *
 * Migration 74 shipped with a bug that no amount of reading caught: it used
 * `CREATE OR REPLACE VIEW` to insert columns in the MIDDLE of the view migration
 * 73 created. Replace can only APPEND — existing columns keep their names, types
 * and positions — so Postgres refused:
 *
 *   42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
 *
 * It reached the owner because "the DDL is unexecuted" was listed as a caveat
 * instead of being fixed. PGlite is Postgres compiled to WASM: real parser, real
 * planner, real DDL semantics, in-process and with no server to install. There
 * is no longer an excuse for shipping SQL nobody ran.
 *
 * Run:  node scripts/test-migrations-73-74.mjs
 *
 * Lives in scripts/ beside test-migrations-41-42, 47, 48, 50, 51 and 52 — this
 * repository has tested migrations against PGlite since migration 41, and the
 * first version of this file put a second copy of that practice somewhere else.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
} catch {
  console.error(
    '\n@electric-sql/pglite is not installed — this suite cannot run.\n' +
    '  npm i --no-save @electric-sql/pglite\n');
  process.exit(1);
}

// fileURLToPath, NOT `new URL(...).pathname`.
//
// On Windows the pathname form yields "/C:/swiftpos/pos/apps/server/test", with
// a leading slash, and path.resolve then prepends the drive — producing
// "C:\C:\swiftpos\pos\migrations\73_device_role.sql" and seventeen confusing
// failures. It is correct on Linux, which is the only place this file had run.
// Register A13: a green from the wrong environment is not a green.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIG  = path.join(ROOT, 'migrations');

// Fail loudly and immediately if the migrations cannot be found. Without this a
// path bug presents as every assertion failing for its own apparent reason —
// missing columns, empty views — and the actual cause is buried in the noise.
if (!fs.existsSync(MIG)) {
  console.error(
    `\nCannot find the migrations directory.\n` +
    `  resolved to: ${MIG}\n` +
    `  from:        ${HERE}\n\n` +
    `Run from the repository root, or check this file has not moved.\n`);
  process.exit(1);
}
for (const f of ['73_device_role.sql', '74_device_role_confirmation.sql']) {
  if (!fs.existsSync(path.join(MIG, f))) {
    console.error(`\nMissing migration: ${path.join(MIG, f)}\n`);
    process.exit(1);
  }
}

let passed = 0, failed = 0;
const ok = (name, fn) => fn().then(
  () => { console.log(`  ok   ${name}`); passed++; },
  (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; });

const db = new PGlite();

/**
 * Enough of public.user_devices to exercise 73 and 74 — the columns they touch
 * plus the ones their indexes and view name. Taken from the owner's live dump
 * (2026-08-09), not invented, so a column that differs in reality is a real
 * finding rather than an artefact of this file.
 */
const BASELINE = `
  CREATE TABLE public.branches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL
  );
  CREATE TABLE public.user_devices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL,
    business_id         uuid NOT NULL,
    fingerprint         text NOT NULL,
    device_label        text,
    ip_address          text,
    status              text NOT NULL DEFAULT 'pending'
                          CHECK (status = ANY (ARRAY['pending','approved','rejected'])),
    requested_at        timestamptz NOT NULL DEFAULT now(),
    reviewed_at         timestamptz,
    reviewed_by         uuid,
    last_seen_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    app_version         text,
    schema_version      integer,
    last_sync_at        timestamptz,
    device_id           text,
    branch_id           uuid REFERENCES public.branches(id),
    terminal_code       text,
    bound_at            timestamptz,
    previous_branch_id  uuid REFERENCES public.branches(id),
    branch_changed_at   timestamptz,
    branch_change_count integer NOT NULL DEFAULT 0,
    rebind_allowed_until timestamptz,
    rebind_authorised_by uuid
  );
  CREATE TABLE public.schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT CURRENT_USER,
    notes      text
  );
`;

const run = (file) => db.exec(fs.readFileSync(path.join(MIG, file), 'utf8'));

console.log('\nRunning migrations 73 and 74 against real Postgres (PGlite)\n');

await db.exec(BASELINE);

// ─────────────────────────────────────────────────────────────────────────────
console.log('1. The migrations apply');

await ok('73 applies cleanly', async () => { await run('73_device_role.sql'); });

await ok('74 applies cleanly — this is what 42P16 broke', async () => {
  await run('74_device_role_confirmation.sql');
});

await ok('both are recorded in schema_migrations', async () => {
  const r = await db.query(`SELECT version FROM public.schema_migrations ORDER BY version`);
  const v = r.rows.map(x => x.version);
  assert.ok(v.includes('73_device_role'), `got ${JSON.stringify(v)}`);
  assert.ok(v.includes('74_device_role_confirmation'), `got ${JSON.stringify(v)}`);
});

await ok('re-running BOTH is idempotent — a half-applied script must be resumable', async () => {
  await run('73_device_role.sql');
  await run('74_device_role_confirmation.sql');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. The CHECK constraint actually constrains');

const insertDevice = (cols) => {
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`).join(',');
  return db.query(
    `INSERT INTO public.user_devices (user_id, business_id, fingerprint, ${keys.join(',')})
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'fp-' || gen_random_uuid()::text, ${vals})
     RETURNING id`,
    keys.map(k => cols[k]));
};

await ok('till, node and office are all accepted', async () => {
  for (const role of ['till', 'node', 'office']) {
    await insertDevice({ device_role: role });
  }
});

await ok('an invalid role is REJECTED by the CHECK', async () => {
  await assert.rejects(() => insertDevice({ device_role: 'kiosk' }), /violates check constraint/i);
});

await ok('NULL is allowed — "has not reported", not a guess', async () => {
  const r = await insertDevice({ device_role: null });
  assert.ok(r.rows[0].id);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. One confirmed server per branch');

const BRANCH = '11111111-1111-1111-1111-111111111111';
const BIZ    = '00000000-0000-0000-0000-000000000001';
await db.query(`INSERT INTO public.branches (id, business_id) VALUES ($1, $2)`, [BRANCH, BIZ]);

const serving = (deviceId, confirmed, role = 'node') => db.query(
  `INSERT INTO public.user_devices
     (user_id, business_id, fingerprint, device_id, branch_id, device_role, status, role_confirmed_at)
   VALUES (gen_random_uuid(), $1, 'fp-'||$2, $2, $3, $4, 'approved', $5) RETURNING id`,
  [BIZ, deviceId, BRANCH, role, confirmed ? new Date().toISOString() : null]);

await ok('the first confirmed server is accepted', async () => {
  await serving('till-A', true);
});

await ok('a SECOND confirmed server for the same branch is refused by the index', async () => {
  await assert.rejects(() => serving('till-B', true), /duplicate key|unique constraint/i);
});

await ok('an office machine cannot sneak past it either', async () => {
  await assert.rejects(() => serving('office-1', true, 'office'), /duplicate key|unique constraint/i);
});

await ok('UNCONFIRMED claimants are allowed — that is how a conflict is recorded', async () => {
  await serving('till-C', false);
  const r = await db.query(
    `SELECT count(*)::int AS n FROM public.user_devices WHERE branch_id = $1`, [BRANCH]);
  assert.equal(r.rows[0].n, 2, 'one confirmed plus one pending claimant');
});

await ok('clear-then-set is the ONLY order that works — proves the handover sequence', async () => {
  // Set-then-clear: refused by the index, exactly as deviceRole.ts reasons.
  await assert.rejects(
    () => db.query(`UPDATE public.user_devices SET role_confirmed_at = now() WHERE device_id = 'till-C'`),
    /duplicate key|unique constraint/i);
  // Clear the incumbent first, then the newcomer takes it.
  await db.query(`UPDATE public.user_devices SET role_confirmed_at = NULL WHERE device_id = 'till-A'`);
  await db.query(`UPDATE public.user_devices SET role_confirmed_at = now() WHERE device_id = 'till-C'`);
  const r = await db.query(
    `SELECT device_id FROM public.user_devices WHERE branch_id = $1 AND role_confirmed_at IS NOT NULL`,
    [BRANCH]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].device_id, 'till-C');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. The view');

await ok('branch_serving_devices exists and exposes both derived booleans', async () => {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'branch_serving_devices' ORDER BY ordinal_position`);
  const cols = r.rows.map(x => x.column_name);
  assert.ok(cols.includes('is_view_only'), `got ${cols.join(',')}`);
  assert.ok(cols.includes('is_confirmed'), `got ${cols.join(',')}`);
  assert.ok(cols.includes('role_confirmed_at'));
});

await ok('it shows serving machines only — never a plain till', async () => {
  await serving('till-D', false, 'till');
  const r = await db.query(`SELECT device_id FROM public.branch_serving_devices`);
  assert.ok(!r.rows.some(x => x.device_id === 'till-D'), 'a till is not a serving device');
});

await ok('is_view_only marks the office machine and only it', async () => {
  await db.query(
    `INSERT INTO public.user_devices
       (user_id, business_id, fingerprint, device_id, branch_id, device_role, status)
     VALUES (gen_random_uuid(), $1, 'fp-off2', 'office-2', $2, 'office', 'approved')`, [BIZ, BRANCH]);
  const r = await db.query(
    `SELECT device_id, is_view_only FROM public.branch_serving_devices ORDER BY device_id`);
  const office = r.rows.find(x => x.device_id === 'office-2');
  assert.equal(office.is_view_only, true);
  assert.ok(r.rows.filter(x => x.is_view_only).length === 1);
});

await ok('re-running 73 ALONE after 74 reverts the view — and 74 restores it', async () => {
  // Honest consequence of DROP + CREATE: 73 owns the smaller definition, so
  // running it on its own after 74 loses the confirmation columns. Migrations
  // are meant to run in order and this is recoverable, but it is real and
  // should be observed rather than assumed.
  await run('73_device_role.sql');
  let r = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'branch_serving_devices'`);
  assert.ok(!r.rows.some(x => x.column_name === 'is_confirmed'),
    'the view is back to migration 73 shape');

  await run('74_device_role_confirmation.sql');
  r = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'branch_serving_devices'`);
  assert.ok(r.rows.some(x => x.column_name === 'is_confirmed'),
    're-running 74 restores it — the documented recovery');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. Migration 73 alone, then 74 — the upgrade path that failed');

await ok('applying 73 then 74 on a fresh database reproduces the 42P16 fix', async () => {
  const fresh = new PGlite();
  await fresh.exec(BASELINE);
  await fresh.exec(fs.readFileSync(path.join(MIG, '73_device_role.sql'), 'utf8'));
  // This is the exact sequence that raised
  //   42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
  await fresh.exec(fs.readFileSync(path.join(MIG, '74_device_role_confirmation.sql'), 'utf8'));
  const r = await fresh.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'branch_serving_devices'`);
  assert.ok(r.rows[0].n > 0, 'view must survive the upgrade');
  await fresh.close();
});

await db.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
